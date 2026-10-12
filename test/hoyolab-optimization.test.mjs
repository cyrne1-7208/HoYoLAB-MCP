import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocument, readDocument } from "../src/document/hoyolab-document.mjs";
import { wikiDocumentParts, wikiHierarchy, wikiDocumentPartsWithHierarchy } from "../src/transform/hoyolab-mdx.mjs";
import { createTextPrefixes } from "../src/transform/text-prefix.mjs";
import { createHoYoLabMcpServer } from "../src/mcp/hoyolab-server.mjs";

const retrievedAt = "2026-01-01T00:00:00.000Z";
const article = (content, extra = {}) => createDocument({ retcode: 0, data: { post: { post: {
  post_id: "101", subject: "Optimization fixture", content, lang: "en-us", ...extra
} } } }, { kind: "article", id: "101", language: "en-us", retrievedAt });
const wiki = (modules) => ({ retcode: 0, data: { page: {
  id: "202", name: "Optimization Wiki", lang: "en-us", desc: "<p>Introduction.</p>", modules
} } });

test("text prefixes retain whole chunks, Unicode and whitespace exactly", () => {
  for (const chunks of [[], [""], ["Japanese 日本語\n\n", "Emoji 😀\n", "", "Combining é\t\n", "tail   "]]) {
    const prefix = createTextPrefixes(chunks);
    for (let count = 0; count <= chunks.length; count += 1) assert.equal(prefix(count), chunks.slice(0, count).join(""));
  }
});

test("combined Wiki conversion matches independent rendering for every component shape and location", () => {
  const wrapped = (value, count) => {
    for (let index = 0; index < count; index += 1) value = { data: JSON.stringify(value) };
    return JSON.stringify(value);
  };
  const shapes = [undefined, null, "", "<h2>First</h2><p>Body.</p><h3>Nested</h3><p>Note.</p>",
    JSON.stringify({ list: [{ title: "Skill", desc: "<h2>Details</h2><p>42% 😀</p>", extra_note: "Retained extra" }] }),
    { list: [{ key: "Level", value: "10", note: "Retained note" }] },
    { list: [{ key: "Field", values: ["Level", "Value"] }, { key: "Damage", values: ["1", "42%"] }] },
    { artifact_list: { flower: { desc: "Artifact description" } } },
    { pic: "https://example.com/gallery.png", data: "<h2>Gallery notes</h2><p>Caption.</p>" },
    [{ key: "Image", img: "javascript:invalid", imgDesc: "Readable caption" }],
    wrapped({ list: [{ title: "Wrapped", desc: "Nested body" }] }, 7)];
  for (const data of shapes) {
    // Shared object identity must not reuse numbering or warning paths from another component location.
    const component = { component_id: "customize", data };
    const payload = wiki([{ name: "First module", components: [component, component] }, { name: "Second module", components: [component] }]);
    const original = structuredClone(payload);
    const options = { wikiApp: "genshin", language: "ja-jp" };
    const combined = wikiDocumentPartsWithHierarchy(payload, options);
    assert.deepEqual(combined.parts, wikiDocumentParts(payload, options));
    assert.deepEqual(combined.hierarchy, wikiHierarchy(payload, options));
    assert.deepEqual(payload, original, "render reuse must not mutate the source payload");
  }
});

test("shared Wiki locations resolve to their first owner rather than an embedded heading", () => {
  const payload = wiki([{ name: "Skills", components: [{ component_id: "talent", data: JSON.stringify({ list: [
    { title: "Skill A", desc: "<h2>Details A</h2><p>BODY-A</p><h3>Notes A</h3><p>NOTE-A</p>" },
    { title: "Skill B", desc: "<h2>Details B</h2><p>BODY-B</p>" }
  ] }) }] }]);
  const document = createDocument(payload, { kind: "wiki", id: "202", wikiApp: "genshin", retrievedAt });
  const item = document.hierarchy.modules[0].components[0].items[0];
  const owners = document.sections.filter((section) => section.location === item.location);
  assert.ok(owners.length > 1);
  assert.equal(item.section_id, owners[0].id);
  const selected = readDocument(document, { section: item.location });
  assert.equal(selected.metadata.selection_section, owners[0].id);
  assert.match(selected.mdx, /BODY-A/);
  assert.match(selected.mdx, /NOTE-A/);
  assert.doesNotMatch(selected.mdx, /BODY-B/);
  assert.deepEqual(selected.blocks, readDocument(document, { section: owners[0].id }).blocks);
});

test("outline grouping and cached ancestor paths preserve a frozen document model", () => {
  const document = article(Array.from({ length: 42 }, (_, index) => `<h2>Section ${index} Σ 日本語</h2><p>First ${index}.</p><p>Second ${index}.</p><h3>Nested ${index}</h3><p>Third ${index}.</p>`).join(""));
  const original = structuredClone(document);
  const freeze = (value) => {
    if (value && typeof value === "object") { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  };
  freeze(document);
  const outline = readDocument(document, { view: "outline", outline_size: 200, max_chars: 200000 });
  assert.equal(outline.continuation, undefined);
  for (const entry of outline.outline) {
    assert.deepEqual(entry.blocks.map((block) => block.block_id), document.blocks.filter((block) => block.section_id === entry.section_id).map((block) => block.id));
  }
  const search = readDocument(document, { view: "search", query: "Section 41 日本語", context_blocks: 0, max_chars: 200000 });
  const owner = document.sections.find((section) => section.title.includes("Section 41"));
  const child = document.sections.find((section) => section.parent_id === owner.id);
  assert.deepEqual(search.matches.map((match) => match.block_id), document.blocks.filter((block) => [owner.id, child.id].includes(block.section_id)).map((block) => block.id));
  readDocument(document, { block_ids: document.blocks.filter((_, index) => index % 7 === 0).map((block) => block.id), max_chars: 200000 });
  assert.deepEqual(document, original, "read-local indexes must not change model fields, revisions or cache accounting");
});

test("read-local indexes do not retain stale headings between calls", () => {
  const document = article("<h2>Original</h2><p>First body.</p><p>Second body.</p>");
  assert.equal(readDocument(document, { view: "search", query: "CHANGED-MARKER" }).match_count, 0);
  const owner = document.sections.find((section) => section.title.includes("Original"));
  owner.title = "CHANGED-MARKER";
  const updated = readDocument(document, { view: "search", query: "CHANGED-MARKER", context_blocks: 0 });
  assert.equal(updated.match_count, 2);
  assert.equal(readDocument(document, { section: "CHANGED-MARKER" }).metadata.selection_section, owner.id);
});

test("long shared ancestor titles remain searchable across sections and match pages", () => {
  const document = article(Array.from({ length: 96 }, (_, index) => `<h2>Section ${index}</h2><p>Body ${index}.</p>`).join(""),
    { subject: "LONG-ANCESTOR " + "日本語😀 ".repeat(512) });
  const first = readDocument(document, { view: "search", query: "LONG-ANCESTOR", max_matches: 50, context_blocks: 0, max_chars: 200000 });
  const next = readDocument(document, { view: "search", query: "LONG-ANCESTOR", max_matches: 50, context_blocks: 0,
    match_offset: first.next_match_offset, max_chars: 200000 });
  assert.equal(first.match_count, document.blocks.length);
  assert.deepEqual([...first.matches, ...next.matches].map((match) => match.block_id), document.blocks.map((block) => block.id));
  assert.equal(next.next_match_offset, undefined);
  const missing = readDocument(document, { view: "search", query: "MISSING-MARKER", max_chars: 200000 });
  assert.equal(missing.match_count, 0);
});

test("reply budget trimming preserves child coverage and every continuation record", async (t) => {
  const list = Array.from({ length: 4 }, (_, root) => ({
    reply: { reply_id: String(100 + root), content: `ROOT-${root} ${"detail 😀 ".repeat(12)}`, lang: "en-us" },
    sub_reply_count: root % 2 ? 7 : 6,
    sub_replies: Array.from({ length: 6 }, (_, child) => ({ reply: {
      reply_id: String(1000 + root * 10 + child), f_reply_id: String(100 + root),
      content: `CHILD-${root}-${child} ${"detail 日本語 ".repeat(12)}`, lang: "en-us", sub_reply_count: 0
    } }))
  }));
  const payload = { retcode: 0, data: { list, is_last: true } };
  const server = createHoYoLabMcpServer({ apiClient: { getReplies: async () => ({ payload, retrievedAt }) } });
  const client = new Client({ name: "optimization-reply-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport); await client.listTools();
  const call = (args) => client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", language: "en-us", ...args } });
  const full = await call({ max_chars: 200000 });
  assert.equal(full.isError, undefined);
  for (const maxChars of [1800, 2500, 3500, 4500, 8000]) {
    const ids = [];
    let args = { max_chars: maxChars };
    for (let page = 0; page < 40; page += 1) {
      const result = await call(args);
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      const data = result.structuredContent;
      assert.ok(data.markdown.length <= maxChars);
      assert.ok(data.replies.length);
      const coverages = [];
      for (const record of data.replies) {
        const children = data.replies.filter((child) => child.parent_reply_id === record.reply_id).length;
        assert.equal(record.returned_child_count, children);
        const advertised = record.sub_reply_count == null ? undefined : Number(record.sub_reply_count);
        const expected = !record.reply_id || !Number.isInteger(advertised) || advertised < children ? "unknown" : children < advertised ? "partial" : "complete";
        assert.equal(record.child_coverage, expected);
        coverages.push(expected);
      }
      assert.equal(data.coverage.children, coverages.includes("partial") ? "partial" : coverages.includes("unknown") ? "unknown" : "complete");
      ids.push(...data.replies.map((record) => record.reply_id));
      if (!data.continuation) break;
      args = data.continuation;
    }
    assert.deepEqual(ids, full.structuredContent.replies.map((record) => record.reply_id));
  }
});
