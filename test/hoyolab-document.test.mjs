import test from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { createDocument, readDocument } from "../src/document/hoyolab-document.mjs";
import { createDocumentStore } from "../src/document/document-store.mjs";

function article(content, extra = {}) {
  return { retcode: 0, data: { post: { post: { post_id: "101", subject: "Article fixture", content, lang: "ja-jp", ...extra }, user: { nickname: "Fixture author" } } } };
}
function document(content, extra = {}) {
  return createDocument(article(content, extra), { kind: "article", id: "101", language: "ja-jp" });
}
function wiki() {
  return { retcode: 0, data: { page: { id: "202", name: "Wiki fixture", lang: "en-us", modules: [{ name: "Skills", components: [{ component_id: "talent", data: JSON.stringify({ list: [{ title: "Skill A", desc: "Existing description", additional_scaling: "Important extra 42%" }, { title: "Skill B", desc: "Other skill" }] }) }] }] } } };
}
const tableBody = "<h2>Changes</h2><p>Values are percentages, only while condition A holds.</p><table><tr><th>Level</th><th>Value (%)</th></tr><tr><td>1</td><td>20</td></tr><tr><td>2</td><td>40</td></tr></table><p>Note: does not stack.</p>";

test("one document model drives full, outline, section, block and table reads", () => {
  const doc = document(tableBody);
  const full = readDocument(doc);
  const outline = readDocument(doc, { view: "outline" });
  const section = outline.outline.find((item) => item.title.includes("Changes"));
  const table = doc.blocks.find((block) => block.type === "table");
  assert.match(full.mdx, /Values are percentages/);
  assert.match(full.mdx, /Fixture author/);
  assert.match(outline.mdx, new RegExp(table.id));
  const selected = readDocument(doc, { section: section.section_id, table_block: table.id, row_start: 2, row_end: 2 });
  assert.match(selected.mdx, /\| Level \| Value \(%\) \|/);
  assert.match(selected.mdx, /\| 2 \| 40 \|/);
  assert.doesNotMatch(selected.mdx, /\| 1 \| 20 \|/);
  assert.match(selected.mdx, /condition A/);
  assert.match(selected.mdx, /does not stack/);
  assert.match(selected.mdx, /# Article: Article fixture/);
  assert.equal(selected.coverage.scope, "selection");
  assert.deepEqual(selected.blocks.find((block) => block.type === "table").selected_rows, { start: 2, end: 2, total: 2 });
  const exact = readDocument(doc, { block_ids: [table.id] });
  assert.equal(exact.coverage.scope, "selection");
  assert.deepEqual(exact.blocks.map((block) => block.block_id), [table.id]);
});

test("Wiki numbering and direct item sections retain owner headings and actual language", () => {
  const doc = createDocument(wiki(), { kind: "wiki", id: "202", wikiApp: "genshin", language: "ja-jp" });
  const read = readDocument(doc, { section: "1.1.1." });
  assert.match(read.mdx, /## 1\. Skills/);
  assert.match(read.mdx, /### 1\.1\. Talent/);
  assert.match(read.mdx, /Important extra 42%/);
  assert.doesNotMatch(read.mdx, /Other skill/);
  assert.equal(read.metadata.requested_language, "ja-jp");
  assert.equal(read.metadata.actual_language, "en-us");
  assert.equal(read.metadata.language_status, "different");
  assert.ok(read.warnings.some((warning) => warning.code === "UNRECOGNIZED_ITEM_FIELD"));
  assert.equal(doc.hierarchy.modules[0].components[0].items[0].section_id, "s4");
});

test("missing document shapes fail, valid empty bodies report uncertainty", () => {
  assert.throws(() => createDocument({ retcode: 0, data: {} }, { kind: "article", id: "101" }), (error) => error.code === "INVALID_DOCUMENT");
  assert.throws(() => createDocument(article("Body"), { kind: "article", id: "999" }), (error) => error.code === "INVALID_DOCUMENT");
  const malformed = wiki();
  malformed.data.page.modules[0].components = [null];
  assert.throws(() => createDocument(malformed, { kind: "wiki", id: "202", wikiApp: "genshin" }), (error) => error.code === "INVALID_DOCUMENT");
  const read = readDocument(document("", { lang: undefined }));
  assert.equal(read.metadata.actual_language, undefined);
  assert.equal(read.metadata.language_status, "unknown");
  assert.ok(read.warnings.some((warning) => warning.code === "EMPTY_BODY"));
  assert.equal(read.coverage.upstream_completeness, "not-verifiable");
});

test("unknown Delta widgets preserve text and emit visible conversion warnings", () => {
  const doc = document("ja-jp", { structured_content: JSON.stringify([{ insert: "Opening.\n" }, { insert: { new_widget: { text: "Critical detail: 77%" } } }, { insert: "Ending.\n" }]) });
  const read = readDocument(doc);
  assert.match(read.mdx, /Critical detail: 77%/);
  assert.match(read.mdx, /UNSUPPORTED_DELTA_EMBED/);
  assert.equal(read.coverage.conversion, "partial");
});

test("code fences do not become section headings and unsafe links are not executable", () => {
  const doc = document('<p><a href="javascript:alert(1)">Readable label</a></p><pre><code># not a heading\n| a | b |\n| --- | --- |</code></pre>');
  assert.equal(doc.blocks.filter((block) => block.type === "code").length, 1);
  assert.equal(doc.sections.length, 2);
  const read = readDocument(doc);
  assert.match(read.mdx, /# not a heading/);
  assert.doesNotMatch(read.mdx, /javascript:/);
  assert.match(read.mdx, /Readable label/);
});

test("output budgets preserve complete blocks and expose usable text-only continuations", () => {
  const doc = document(Array.from({ length: 9 }, (_, index) => `<p>Paragraph ${index}: ${"detail ".repeat(80)}</p>`).join(""));
  let args = { post_id: "101", max_chars: 5000 };
  const seen = [];
  for (let pages = 0; pages < 20; pages += 1) {
    const read = readDocument(doc, args);
    assert.ok(read.mdx.length <= 5000);
    seen.push(...read.blocks.map((block) => block.block_id));
    const metadata = YAML.parse(read.mdx.split("---\n")[1]);
    assert.equal(Boolean(metadata.continuation), Boolean(read.continuation));
    if (!read.continuation) break;
    assert.equal(read.continuation.post_id, "101");
    assert.equal(read.continuation.revision, doc.revision);
    args = read.continuation;
  }
  assert.deepEqual(seen, doc.blocks.map((block) => block.id));
  assert.throws(() => readDocument(doc, { max_chars: 1000 }), (error) => error.code === "BUDGET_TOO_SMALL");
});

test("literal document search has match pagination and retains nearby conditions", () => {
  const doc = document("<h2>Changes</h2><p>Condition: skill level 10.</p><p>Damage increases by 42%.</p><p>Note: only one target.</p><h2>Unrelated</h2><p>Other text.</p>");
  const read = readDocument(doc, { view: "search", query: "damage 42%" });
  assert.equal(read.match_count, 1);
  assert.match(read.mdx, /skill level 10/);
  assert.match(read.mdx, /only one target/);
  assert.doesNotMatch(read.mdx, /Other text/);
  const page1 = readDocument(doc, { view: "search", query: "Changes", max_matches: 1, context_blocks: 0 });
  const page2 = readDocument(doc, { view: "search", query: "Changes", max_matches: 1, context_blocks: 0, match_offset: page1.next_match_offset });
  assert.notEqual(page1.matches[0].block_id, page2.matches[0].block_id);
  assert.throws(() => readDocument(doc, { view: "search" }), (error) => error.code === "INVALID_SELECTION");
});

test("invalid selections and table ranges fail explicitly", () => {
  const doc = document(tableBody);
  assert.throws(() => readDocument(doc, { section: "not found" }), (error) => error.code === "SECTION_NOT_FOUND");
  assert.throws(() => readDocument(doc, { row_start: 1 }), (error) => error.code === "INVALID_SELECTION");
  assert.throws(() => readDocument(doc, { table_block: "b2", row_start: 3 }), (error) => error.code === "INVALID_SELECTION");
  assert.throws(() => readDocument(doc, { start_block: 3, end_block: 1 }), (error) => error.code === "INVALID_SELECTION");
  assert.throws(() => readDocument(doc, { table_block: "b2", block_ids: ["b1"] }), (error) => error.code === "INVALID_SELECTION");
  assert.throws(() => readDocument(doc, { view: "outline", outline_start: 999 }), (error) => error.code === "INVALID_SELECTION");
});

test("revision is content-based, not retrieval-time-based", () => {
  const payload = article("<p>Same body.</p>");
  const a = createDocument(payload, { kind: "article", id: "101", language: "ja-jp", retrievedAt: "2026-01-01T00:00:00Z" });
  const b = createDocument(payload, { kind: "article", id: "101", language: "ja-jp", retrievedAt: "2026-02-01T00:00:00Z" });
  assert.equal(a.revision, b.revision);
  assert.notEqual(a.revision, document("Different body").revision);
});

test("long outline sections page block references without losing any IDs", () => {
  const doc = document(Array.from({ length: 150 }, (_, index) => `<p>Block ${index}</p>`).join(""));
  const seen = [];
  let args = { view: "outline", max_chars: 4500 };
  for (let page = 0; page < 20; page += 1) {
    const read = readDocument(doc, args);
    seen.push(...read.outline.flatMap((section) => section.blocks.map((block) => block.block_id)));
    assert.ok(read.mdx.length <= 4500);
    if (!read.continuation) break;
    args = read.continuation;
  }
  assert.deepEqual(seen, doc.blocks.map((block) => block.id));
});

test("search continuations retain unmatched trailing notes and exclude unrelated gaps", () => {
  const doc = document(`<p>Target ${"detail ".repeat(100)}</p><p>${"Condition ".repeat(180)}</p><p>Unrelated gap.</p><p>Other target ${"detail ".repeat(100)}</p><p>${"Note ".repeat(180)}</p>`);
  const first = readDocument(doc, { view: "search", query: "target", context_blocks: 1, max_chars: 4500 });
  assert.ok(first.continuation);
  assert.equal(first.continuation.view, "full");
  const seen = [...first.blocks.map((block) => block.block_id)];
  let args = first.continuation;
  for (let page = 0; page < 10; page += 1) {
    const read = readDocument(doc, args);
    seen.push(...read.blocks.map((block) => block.block_id));
    if (!read.continuation) break;
    args = read.continuation;
  }
  const expected = readDocument(doc, { view: "search", query: "target", context_blocks: 1, max_chars: 20000 }).blocks.map((block) => block.block_id);
  assert.deepEqual(seen, expected);
  assert.ok(seen.includes("b5"));
});

test("JSON Delta bodies keep Delta formatting, and legacy blocks retain siblings", () => {
  const delta = document(JSON.stringify([{ insert: "Heading" }, { insert: "\n", attributes: { header: 2 } }, { insert: "Body.\n" }]));
  assert.equal(delta.metadata.body_source, "quill-delta-content");
  assert.match(readDocument(delta).mdx, /### Section: Heading/);
  const mixed = document(JSON.stringify({ blocks: [{ text: "Readable paragraph", images: ["https://example.com/image.png"], new_detail: "Sibling detail 55%" }] }));
  const read = readDocument(mixed);
  assert.match(read.mdx, /Readable paragraph/);
  assert.match(read.mdx, /https:\/\/example\.com\/image\.png/);
  assert.match(read.mdx, /Sibling detail 55%/);
  assert.equal(read.coverage.conversion, "partial");
});

test("explicit one-column JSON tables retain values and support row selection", () => {
  for (const table of [{ headers: ["Value"], rows: [["42%"], ["55%"]] }, { columns: ["Value"], body: [["42%"], ["55%"]] }]) {
    const doc = document(JSON.stringify({ describe: "Values are percentages.", table }));
    const full = readDocument(doc);
    assert.equal(doc.metadata.body_source, "json-content");
    assert.match(full.mdx, /\| Value \|/);
    assert.match(full.mdx, /\| 42% \|/);
    assert.match(full.mdx, /\| 55% \|/);
    assert.equal(full.coverage.conversion, "no-known-loss");
    const block = readDocument(doc, { view: "outline" }).outline.flatMap((section) => section.blocks).find((item) => item.type === "table");
    assert.equal(block.rows, 2);
    const selected = readDocument(doc, { table_block: block.block_id, row_start: 2, row_end: 2 });
    assert.match(selected.mdx, /Values are percentages/);
    assert.match(selected.mdx, /\| 55% \|/);
    assert.doesNotMatch(selected.mdx, /\| 42% \|/);
  }
  const tableOnly = document(JSON.stringify({ table: { headers: ["Value"], rows: [["42%"]] } }));
  assert.match(readDocument(tableOnly).mdx, /42%/);
  assert.ok(!tableOnly.warnings.some((warning) => warning.code === "EMPTY_BODY"));
  const typed = readDocument(document(JSON.stringify({ blocks: [{ type: "table", columns: ["Value"], body: [["42%"], ["55%"]] }] })));
  assert.equal(typed.coverage.conversion, "no-known-loss");
  assert.equal(typed.mdx.split("42%").length - 1, 1);
});

test("unsupported root-level and mixed table shapes retain fallback data with warnings", () => {
  const malformed = { columns: ["Value"], new_rows: [{ important_value: "77%" }] };
  for (const fields of [{ table: malformed }, { tables: [{ headers: ["Level", "Value"], rows: [["1", "42%"]] }, malformed] }]) {
    const read = readDocument(document(JSON.stringify({ describe: "Introduction.", ...fields })));
    assert.match(read.mdx, /Introduction/);
    assert.match(read.mdx, /77%/);
    assert.ok(read.warnings.some((warning) => warning.code === "UNSUPPORTED_ARTICLE_TABLE"));
    assert.equal(read.coverage.conversion, "partial");
    if (fields.tables) assert.match(read.mdx, /\| 1 \| 42% \|/);
  }
});

test("empty headings before, between and after body sections survive full and scoped reads", () => {
  const doc = document("<h2>Empty before</h2><h2>Filled</h2><p>Existing body.</p><h2>Empty after</h2><h3>Nested empty</h3>");
  const full = readDocument(doc);
  const names = ["Empty before", "Filled", "Empty after", "Nested empty"];
  const positions = names.map((name) => full.mdx.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(doc.blocks.filter((block) => block.type === "heading").length, 2);
  const outline = readDocument(doc, { view: "outline" });
  const empty = outline.outline.find((section) => section.title.includes("Empty before"));
  const scoped = readDocument(doc, { section: empty.section_id });
  assert.match(scoped.mdx, /Empty before/);
  assert.doesNotMatch(scoped.mdx, /Existing body/);
  assert.match(readDocument(doc, { view: "search", query: "Empty before", context_blocks: 0 }).mdx, /Empty before/);
  const headingsOnly = readDocument(document("<h2>Only heading</h2>"));
  assert.match(headingsOnly.mdx, /Only heading/);
  assert.doesNotMatch(headingsOnly.mdx, /No readable body blocks/);
});

test("empty Wiki modules and components retain numbered headings in full MDX", () => {
  const payload = wiki();
  payload.data.page.modules = [{ name: "Empty module", components: [] }, { name: "Parent", components: [{ component_id: "empty", data: "" }] }];
  const doc = createDocument(payload, { kind: "wiki", id: "202", wikiApp: "genshin", language: "en-us" });
  const read = readDocument(doc);
  assert.match(read.mdx, /## 1\. Empty module/);
  assert.match(read.mdx, /## 2\. Parent/);
  assert.match(read.mdx, /### 2\.1\. Empty/);
  assert.equal(doc.blocks.filter((block) => block.type === "heading").length, 2);
});

test("heading-only continuations retain every heading once in document order", () => {
  const names = Array.from({ length: 40 }, (_, index) => `Empty ${index}: ${"label ".repeat(12)}`);
  const doc = document(names.map((name) => `<h2>${name}</h2>`).join(""));
  let args = { post_id: "101", max_chars: 4500 };
  const seen = [];
  const output = [];
  for (let page = 0; page < 20; page += 1) {
    const read = readDocument(doc, args);
    assert.ok(read.mdx.length <= 4500);
    seen.push(...read.blocks.map((block) => block.block_id));
    output.push(read.mdx.replace(/^---\n[\s\S]*?\n---\n/, ""));
    if (!read.continuation) break;
    args = read.continuation;
  }
  assert.deepEqual(seen, doc.blocks.map((block) => block.id));
  const text = output.join("\n");
  for (const name of names) assert.equal(text.split(`### Section: ${name.trim()}\n`).length - 1, 1);
});

test("cache reuses reads, pins old revisions and never makes a pinned old revision the latest", async () => {
  let content = "Version A";
  let calls = 0;
  const store = createDocumentStore({ apiClient: { getArticle: async () => { calls += 1; return { payload: article(content), language: "ja-jp" }; } } });
  const key = { kind: "article", id: "101", language: "JA" };
  const a = await store.get(key);
  assert.equal((await store.get(key)).cache_hit, true);
  assert.equal(calls, 1);
  content = "Version B";
  const b = await store.get({ ...key, refresh: true });
  assert.notEqual(a.document.revision, b.document.revision);
  const pinned = await store.get({ ...key, revision: a.document.revision });
  assert.match(readDocument(pinned.document).mdx, /Version A/);
  assert.equal((await store.get(key)).document.revision, b.document.revision);
  assert.equal(calls, 2);
  await assert.rejects(store.get({ ...key, revision: a.document.revision, refresh: true }), (error) => error.code === "INVALID_SELECTION");
});

test("expired revisions fail instead of silently substituting updated content; cache is bounded", async () => {
  let clock = 100;
  let content = "A";
  const store = createDocumentStore({ now: () => clock, retentionMs: 100, freshnessMs: 20, maxEntries: 1,
    apiClient: { getArticle: async () => ({ payload: article(content) }) } });
  const args = { kind: "article", id: "101" };
  const first = await store.get(args);
  clock += 101; content = "B";
  await assert.rejects(store.get({ ...args, revision: first.document.revision }), (error) => error.code === "REVISION_UNAVAILABLE");
  await store.get(args);
  content = "C"; await store.get({ ...args, refresh: true });
  assert.equal(store.stats().entries, 1);
  assert.ok(store.stats().bytes <= 32 * 1024 * 1024);
});

test("large exact selections account for selector and continuation YAML without losing blocks", () => {
  const doc = document(Array.from({ length: 700 }, (_, index) => `<p>Block ${index}: ${"v".repeat(68)}</p>`).join(""));
  assert.equal(readDocument(doc).blocks.length, 700);
  for (const [count, maxChars] of [[700, 60000], [400, 20000]]) {
    const ids = doc.blocks.slice(0, count).map((block) => block.id);
    const seen = [];
    let args = { post_id: "101", block_ids: ids, max_chars: maxChars };
    for (let page = 0; page < 20; page += 1) {
      const read = readDocument(doc, args);
      assert.ok(read.mdx.length <= maxChars);
      assert.ok(read.blocks.length > 0);
      seen.push(...read.blocks.map((block) => block.block_id));
      const textMetadata = YAML.parse(read.mdx.split("---\n")[1]);
      if (!read.continuation) break;
      assert.deepEqual(textMetadata.continuation.block_ids, read.continuation.block_ids);
      assert.equal(read.continuation.revision, doc.revision);
      args = read.continuation;
    }
    assert.deepEqual(seen, ids);
  }
});

test("budget-boundary pages measure the full envelope in body, search and outline views", () => {
  const doc = document(Array.from({ length: 45 }, (_, index) => `<p>Target ${index}: ${"detail ".repeat(20)}</p>`).join(""));
  for (const maxChars of [3000, 3200, 3500, 4000, 5000, 6500]) {
    for (const selection of [{}, { view: "search", query: "target", max_matches: 20, context_blocks: 0 }, { view: "outline" }]) {
      let args = { ...selection, max_chars: maxChars };
      const ids = [];
      for (let page = 0; page < 30; page += 1) {
        const read = readDocument(doc, args);
        assert.ok(read.mdx.length <= maxChars, `${selection.view || "full"}: ${maxChars}`);
        ids.push(...(read.outline ? read.outline.flatMap((section) => section.blocks) : read.blocks).map((block) => block.block_id));
        if (!read.continuation) break;
        args = read.continuation;
      }
      assert.deepEqual(ids, doc.blocks.slice(0, selection.view === "search" ? 20 : 45).map((block) => block.id));
    }
  }
});

test("copied heading titles retain trailing punctuation while numeric Wiki selectors still work", () => {
  const doc = document("<h2>Changes.</h2><p>Only this section.</p><h2>Other</h2><p>Unrelated.</p>");
  const title = readDocument(doc, { view: "outline" }).outline.find((section) => section.title.includes("Changes.")).title;
  const selected = readDocument(doc, { section: title });
  assert.match(selected.mdx, /Only this section/);
  assert.doesNotMatch(selected.mdx, /Unrelated/);
  const wikiDoc = createDocument(wiki(), { kind: "wiki", id: "202", wikiApp: "genshin", language: "en-us" });
  assert.match(readDocument(wikiDoc, { section: "1.1.1." }).mdx, /Existing description/);
});

test("embedded Wiki headings cannot escape their source module or component", () => {
  const payload = wiki();
  payload.data.page.desc = "<h1>Page description heading</h1><p>Introduction.</p>";
  payload.data.page.modules = [{ name: "Media", components: [
    { component_id: "customize", data: JSON.stringify({ data: "<h2>Character details</h2><p>First body.</p><h3>Nested notes</h3><p>Second body.</p><h2>Birthday</h2><p>Third body.</p>" }) },
    { component_id: "talent", data: JSON.stringify({ list: [{ title: "Other component", desc: "Separate component body." }] }) }
  ] }, { name: "Other module", components: [{ component_id: "customize", data: JSON.stringify({ data: "<p>Unrelated module body.</p>" }) }] }];
  const doc = createDocument(payload, { kind: "wiki", id: "202", wikiApp: "genshin", language: "en-us" });
  const component = readDocument(doc, { section: "module[1].component[1]" });
  assert.equal(component.blocks.length, 3);
  for (const text of ["First body", "Second body", "Third body"]) assert.ok(component.mdx.includes(text));
  assert.match(component.mdx, /#### 1\.1\.1\. Character details/);
  assert.match(component.mdx, /##### 1\.1\.2\. Nested notes/);
  assert.doesNotMatch(component.mdx, /Separate component body|Unrelated module body/);
  const module = readDocument(doc, { section: "module[1]" });
  assert.equal(module.blocks.length, 4);
  assert.match(module.mdx, /Separate component body/);
  assert.doesNotMatch(module.mdx, /Unrelated module body/);
  assert.equal(doc.sections.find((section) => section.title === "Page description heading").parent_id, "s1");
});

test("a slow earlier fetch cannot replace a completed refresh", async () => {
  const pending = [];
  const store = createDocumentStore({ apiClient: { getArticle: () => new Promise((resolve) => pending.push(resolve)) } });
  const args = { kind: "article", id: "101", language: "ja-jp" };
  const oldRequest = store.get(args);
  const newRequest = store.get({ ...args, refresh: true });
  pending[1]({ payload: article("Newer version") });
  const newer = await newRequest;
  pending[0]({ payload: article("Older version") });
  const older = await oldRequest;
  assert.notEqual(older.document.revision, newer.document.revision);
  assert.equal((await store.get(args)).document.revision, newer.document.revision);
  assert.equal((await store.get({ ...args, revision: older.document.revision })).document.revision, older.document.revision);
});

test("a pinned cache miss does not establish the latest unpinned version", async () => {
  const oldPayload = article("Pinned old version");
  const revision = createDocument(oldPayload, { kind: "article", id: "101", language: "ja-jp" }).revision;
  let calls = 0;
  const store = createDocumentStore({ apiClient: { getArticle: async () => ({ payload: ++calls === 1 ? oldPayload : article("Current version") }) } });
  const args = { kind: "article", id: "101", language: "ja-jp" };
  assert.equal((await store.get({ ...args, revision })).document.revision, revision);
  const latest = await store.get(args);
  assert.equal(calls, 2);
  assert.notEqual(latest.document.revision, revision);
  assert.match(readDocument(latest.document).mdx, /Current version/);
});

test("evicting the newest cached revision never promotes a pinned older revision", async () => {
  let content = "Version A";
  let calls = 0;
  const store = createDocumentStore({ maxEntries: 2, apiClient: { getArticle: async ({ postId }) => {
    calls += 1;
    return { payload: article(postId === "101" ? content : "Other article", { post_id: postId }) };
  } } });
  const args = { kind: "article", id: "101", language: "ja-jp" };
  const older = await store.get(args);
  content = "Version B";
  const newer = await store.get({ ...args, refresh: true });
  await store.get({ ...args, revision: older.document.revision });
  await store.get({ ...args, id: "102" });
  const latest = await store.get(args);
  assert.equal(latest.document.revision, newer.document.revision);
  assert.equal(latest.cache_hit, false);
  assert.equal(calls, 4);
  assert.ok(store.stats().entries <= 2);
});

test("a refreshed document larger than the cache cannot revive the cached old version", async () => {
  let content = "Small original";
  let calls = 0;
  const store = createDocumentStore({ maxBytes: 5000, apiClient: { getArticle: async () => {
    calls += 1;
    return { payload: article(content) };
  } } });
  const args = { kind: "article", id: "101", language: "ja-jp" };
  await store.get(args);
  assert.equal(store.stats().entries, 1);
  content = "New large body ".repeat(1000);
  const refreshed = await store.get({ ...args, refresh: true });
  const latest = await store.get(args);
  assert.equal(latest.document.revision, refreshed.document.revision);
  assert.equal(latest.cache_hit, false);
  assert.equal(calls, 3);
  assert.ok(store.stats().bytes <= 5000);
});

test("out-of-order responses remain fresh even when the cache can hold only one revision", async () => {
  const pending = [];
  let calls = 0;
  const store = createDocumentStore({ maxEntries: 1, apiClient: { getArticle: () => {
    calls += 1;
    return calls <= 2 ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve({ payload: article("Current version") });
  } } });
  const args = { kind: "article", id: "101", language: "ja-jp" };
  const oldRequest = store.get(args);
  const refresh = store.get({ ...args, refresh: true });
  pending[1]({ payload: article("Current version") });
  const current = await refresh;
  pending[0]({ payload: article("Old version") });
  await oldRequest;
  assert.equal((await store.get(args)).document.revision, current.document.revision);
  assert.equal(store.stats().entries, 1);
});
