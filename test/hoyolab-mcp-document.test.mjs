import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHoYoLabMcpServer } from "../src/mcp/hoyolab-server.mjs";
import { HoYoLabApiError } from "../src/hoyolab/api.mjs";

const post = (content = "<h2>Changes</h2><p>Damage increases by 42%.</p><p>Only under condition A.</p>") => ({ retcode: 0, data: { post: { post: { post_id: "101", subject: "Protocol fixture", lang: "ja-jp", content } } } });
const wiki = (items = [{ title: "Skill A", desc: "Damage description" }]) => ({ retcode: 0, data: { page: { id: "202", name: "Wiki fixture", status: 2, lang: "en-us", modules: [{ name: "Skills", components: [{ component_id: "talent", data: JSON.stringify({ list: items }) }] }] } } });

async function setup(t, overrides = {}, documentStoreOptions = {}) {
  const calls = { article: 0, wiki: 0 };
  const apiClient = {
    getArticle: async () => { calls.article += 1; return { payload: post(), language: "ja-jp" }; },
    getWiki: async () => { calls.wiki += 1; return { payload: wiki(), language: "ja-jp" }; },
    getReplies: async () => ({ payload: { retcode: 0, data: { list: [], is_last: true } }, language: "ja-jp" }),
    ...overrides
  };
  const server = createHoYoLabMcpServer({ apiClient, documentStoreOptions });
  const client = new Client({ name: "document-protocol-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  // Tool discovery activates the SDK client's output validators, including validation of structured error results.
  await client.listTools();
  return { client, calls };
}

test("all eight tools declare output schemas and document views return real bodies", async (t) => {
  const { client, calls } = await setup(t);
  const list = await client.listTools();
  assert.equal(list.tools.length, 8);
  assert.ok(list.tools.every((tool) => tool.outputSchema));
  const args = { post_id: "101", language: "ja-jp" };
  const outline = await client.callTool({ name: "read_hoyolab_article", arguments: { ...args, view: "outline" } });
  assert.equal(outline.isError, undefined);
  const section = outline.structuredContent.outline.find((item) => item.title.includes("Changes"));
  const read = await client.callTool({ name: "read_hoyolab_article", arguments: { ...args, section: section.section_id, revision: outline.structuredContent.revision } });
  assert.match(read.structuredContent.mdx, /42%/);
  assert.equal(read.content[0].text, read.structuredContent.mdx);
  assert.equal(calls.article, 1);
  const search = await client.callTool({ name: "read_hoyolab_article", arguments: { ...args, view: "search", query: "damage" } });
  assert.equal(search.structuredContent.match_count, 1);
  assert.match(search.structuredContent.mdx, /condition A/);
});

test("hierarchy and scoped Wiki reads reuse one revision and report actual language", async (t) => {
  const { client, calls } = await setup(t);
  const args = { entry_page_id: "202", language: "ja-jp" };
  const hierarchy = await client.callTool({ name: "get_hoyowiki_hierarchy", arguments: args });
  const structured = hierarchy.structuredContent;
  assert.equal(structured.status, "partial");
  assert.equal(structured.upstream_status, 2);
  assert.equal(structured.actual_language, "en-us");
  for (const [name, selectors] of [["read_hoyowiki_module", { module: "1" }], ["read_hoyowiki_component", { module: "1", component: "1" }]]) {
    const read = await client.callTool({ name, arguments: { ...args, ...selectors, revision: structured.revision } });
    assert.equal(read.isError, undefined);
    assert.equal(read.structuredContent.revision, structured.revision);
    assert.equal(read.structuredContent.actual_language, "en-us");
    assert.match(read.structuredContent.mdx, /Damage description/);
  }
  assert.equal(calls.wiki, 1);
});

test("scoped continuations are directly reusable with the original tool", async (t) => {
  const payload = wiki(Array.from({ length: 12 }, (_, index) => ({ title: `Skill ${index}`, desc: "detail ".repeat(60) })));
  const { client } = await setup(t, { getWiki: async () => ({ payload, language: "ja-jp" }) });
  const first = await client.callTool({ name: "read_hoyowiki_module", arguments: { entry_page_id: "202", module: "1", max_chars: 5000 } });
  assert.equal(first.isError, undefined);
  assert.ok(first.structuredContent.continuation);
  assert.equal(first.structuredContent.continuation.section, undefined);
  const next = await client.callTool({ name: "read_hoyowiki_module", arguments: first.structuredContent.continuation });
  assert.equal(next.isError, undefined);
  assert.equal(next.structuredContent.revision, first.structuredContent.revision);
  assert.ok(next.structuredContent.blocks[0].index > first.structuredContent.blocks.at(-1).index);
});

test("missing payloads and API failures are typed tool errors, not metadata-only success", async (t) => {
  const { client } = await setup(t, { getArticle: async () => ({ payload: { retcode: 0, data: {} } }),
    getReplies: async () => { throw new HoYoLabApiError("HoYoLAB returned HTTP 429", { code: "RATE_LIMITED", retryable: true, status: 429, retryAfterMs: 5000 }); } });
  const missing = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "INVALID_DOCUMENT");
  const limited = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(limited.isError, true);
  assert.equal(limited.structuredContent.error.retry_after_ms, 5000);
  assert.equal(limited.structuredContent.error.http_status, 429);
});

test("all eight discovered tools accept structured errors without relaxing success validation", async (t) => {
  const fail = async () => { throw new HoYoLabApiError("HoYoLAB returned HTTP 429", { code: "RATE_LIMITED", retryable: true, status: 429, retryAfterMs: 5000 }); };
  const { client } = await setup(t, { searchPosts: fail, searchWiki: fail, getArticle: fail, getWiki: fail, getReplies: fail });
  const cases = [
    ["search_hoyolab_posts", { keyword: "test" }], ["search_hoyowiki", { keyword: "test" }],
    ["read_hoyolab_article", { post_id: "101" }], ["read_hoyowiki_entry", { entry_page_id: "202" }],
    ["get_hoyowiki_hierarchy", { entry_page_id: "202" }], ["read_hoyowiki_module", { entry_page_id: "202", module: "1" }],
    ["read_hoyowiki_component", { entry_page_id: "202", module: "1", component: "1" }], ["read_hoyolab_replies", { post_id: "101" }]
  ];
  for (const [name, arguments_] of cases) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "RATE_LIMITED");
    assert.equal(result.structuredContent.error.retry_after_ms, 5000);
    const validate = client.getToolOutputValidator(name);
    assert.equal(validate(result.structuredContent).valid, true);
    const incomplete = { kind: "article", status: "ok", warnings: [], content_trust: "external-untrusted" };
    assert.equal(validate(incomplete).valid, false, `${name} must still reject incomplete successful output`);
    assert.equal(validate({ ...result.structuredContent, error: {} }).valid, false);
  }
});

test("MCP reads retain one-column table values and empty headings after tool discovery", async (t) => {
  const { client } = await setup(t, { getArticle: async ({ postId }) => {
    const content = postId === "101" ? JSON.stringify({ describe: "Values are percentages.", table: { headers: ["Value"], rows: [["42%"], ["55%"]] } })
      : "<h2>Empty before</h2><h2>Filled</h2><p>Existing body.</p><h2>Empty after</h2>";
    const payload = post(content);
    payload.data.post.post.post_id = postId;
    return { payload, language: "ja-jp" };
  } });
  const outline = (await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101", view: "outline" } })).structuredContent;
  const table = outline.outline.flatMap((section) => section.blocks).find((block) => block.type === "table");
  assert.equal(table.rows, 2);
  const selected = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101", revision: outline.revision,
    table_block: table.block_id, row_start: 2, row_end: 2 } });
  assert.equal(selected.isError, undefined);
  assert.match(selected.structuredContent.mdx, /\| 55% \|/);
  assert.doesNotMatch(selected.structuredContent.mdx, /\| 42% \|/);
  const headings = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "102" } });
  assert.equal(headings.isError, undefined);
  assert.match(headings.structuredContent.mdx, /Empty before/);
  assert.match(headings.structuredContent.mdx, /Empty after/);
  assert.equal(headings.content[0].text, headings.structuredContent.mdx);
});

test("reply completeness separates received counts from advertised child counts", async (t) => {
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true, total_count: 50,
    list: [{ reply: { reply_id: "1", content: "Root", sub_reply_count: 10 }, sub_replies: [{ reply: { reply_id: "2", f_reply_id: "1", content: "Child" } }] }] } } }) });
  const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.returned_count, 2);
  assert.equal(result.structuredContent.upstream_counts.total_count, 50);
  assert.equal(result.structuredContent.total_count, undefined);
  assert.equal(result.structuredContent.replies[0].child_coverage, "partial");
  assert.equal(result.structuredContent.coverage.root_page_is_last, true);
  assert.match(result.content[0].text, /SUB_REPLIES_PARTIAL/);
});

test("reply continuations preserve whole records and detect changed API pages", async (t) => {
  let changed = false;
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true,
    list: Array.from({ length: 4 }, (_, index) => ({ reply: { reply_id: String(index + 1), content: `${changed ? "Changed" : "Reply"} ${index}: ${"text ".repeat(220)}`, sub_reply_count: 0 } })) } } }) });
  const first = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", max_chars: 4000 } });
  assert.equal(first.isError, undefined);
  assert.ok(first.structuredContent.continuation);
  const next = await client.callTool({ name: "read_hoyolab_replies", arguments: first.structuredContent.continuation });
  assert.equal(next.isError, undefined);
  assert.notEqual(next.structuredContent.replies[0].reply_id, first.structuredContent.replies[0].reply_id);
  changed = true;
  const stale = await client.callTool({ name: "read_hoyolab_replies", arguments: first.structuredContent.continuation });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "REVISION_UNAVAILABLE");
});

test("ID-less replies are retained without accidental sibling deduplication", async (t) => {
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { list: [
    { reply: { reply_id: "1", content: "Root A" }, sub_replies: [{ reply: { content: "Anonymous A" } }] },
    { reply: { reply_id: "2", content: "Root B" }, sub_replies: [{ reply: { content: "Anonymous B" } }] }
  ] } } }) });
  const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(result.structuredContent.returned_count, 4);
  assert.match(result.content[0].text, /Anonymous A/);
  assert.match(result.content[0].text, /Anonymous B/);
});

test("MCP cancellation reaches the active upstream request", async (t) => {
  let announce;
  let observe;
  const started = new Promise((resolve) => { announce = resolve; });
  const cancelled = new Promise((resolve) => { observe = resolve; });
  const { client } = await setup(t, { getArticle: ({ signal }) => new Promise((_resolve, reject) => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => { observe(true); reject(signal.reason); }, { once: true });
    announce();
  }) });
  const controller = new AbortController();
  const pending = client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101" } }, undefined, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending);
  assert.equal(await cancelled, true);
});

test("search snippets cannot fence off later candidates and malformed items are visible omissions", async (t) => {
  const { client } = await setup(t, { searchPosts: async () => ({ data: { list: [null, {},
    { post: { post_id: "101", subject: "Code preview", created_at: 1e100, content: `<pre><code>${"line\n".repeat(400)}</code></pre>` }, image_list: [{ url: "javascript:alert(1)" }] },
    { post: { post_id: "102", subject: "Next candidate", content: "Short body" } }
  ] } }) });
  const result = await client.callTool({ name: "search_hoyolab_posts", arguments: { keyword: "test" } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "partial");
  assert.deepEqual(result.structuredContent.results.map((item) => item.post_id), ["101", "102"]);
  assert.ok(result.structuredContent.results[0].snippet.length <= 1200);
  assert.match(result.content[0].text, /^## \[Next candidate\]/m);
  assert.doesNotMatch(result.content[0].text, /^ {0,3}(?:`{3,}|~{3,})|javascript:|undefined/m);
  assert.match(result.content[0].text, /INVALID_SEARCH_ITEM/);
});

test("Wiki search URLs are safe and an unreported application is never silently Genshin", async (t) => {
  const { client } = await setup(t, { searchWiki: async () => ({ data: { posts: [], entry_pages: [null, {},
    { id: "202", name: "HSR entry", wiki_app: "hsr", web_path: "javascript:alert(1)", icon_url: "data:image/svg+xml,example" },
    { id: "303", name: "Unknown application" }
  ] } }) });
  const result = await client.callTool({ name: "search_hoyowiki", arguments: { keyword: "test" } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "partial");
  assert.equal(result.structuredContent.entry_pages.length, 2);
  assert.equal(result.structuredContent.entry_pages[0].url, "https://wiki.hoyolab.com/pc/hsr/entry/202");
  assert.equal(result.structuredContent.entry_pages[1].wiki_app, undefined);
  assert.equal(result.structuredContent.entry_pages[1].url, undefined);
  assert.match(result.content[0].text, /WIKI_APP_UNREPORTED/);
  assert.doesNotMatch(result.content[0].text, /javascript:|data:|\/genshin\/entry\/303/);
});

test("all-invalid search items are typed failures but genuinely empty searches succeed", async (t) => {
  let invalid = true;
  const { client } = await setup(t, { searchPosts: async () => ({ data: { list: invalid ? [null, {}] : [] } }),
    searchWiki: async () => ({ data: { posts: [], entry_pages: invalid ? [{ name: "No ID" }] : [] } }) });
  for (const name of ["search_hoyolab_posts", "search_hoyowiki"]) {
    const result = await client.callTool({ name, arguments: { keyword: "test" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "INVALID_RESPONSE");
  }
  invalid = false;
  for (const name of ["search_hoyolab_posts", "search_hoyowiki"]) {
    const result = await client.callTool({ name, arguments: { keyword: "test" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "ok");
  }
});

test("reply next_page arguments forward last_id and return distinct API pages", async (t) => {
  const calls = [];
  const { client } = await setup(t, { getReplies: async (args) => {
    calls.push(args);
    const second = args.lastId === "15";
    return { payload: { retcode: 0, data: { is_last: second, last_id: second ? "30" : "15",
      list: [{ reply: { reply_id: second ? "2" : "1", content: second ? "Second page" : "First page", sub_reply_count: 0 } }] } }, language: "ja-jp" };
  } });
  const first = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.next_page.last_id, "15");
  assert.equal(first.structuredContent.next_page.page, 2);
  const second = await client.callTool({ name: "read_hoyolab_replies", arguments: first.structuredContent.next_page });
  assert.equal(second.isError, undefined);
  assert.equal(calls[1].lastId, "15");
  assert.equal(second.structuredContent.requested_cursor, "15");
  assert.equal(second.structuredContent.replies[0].reply_id, "2");
  assert.equal(second.structuredContent.next_page, undefined);
  const noCursor = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", page: 2 } });
  assert.equal(noCursor.isError, true);
  assert.equal(noCursor.structuredContent.error.code, "INVALID_SELECTION");
  assert.equal(calls.length, 2);
});

test("missing or nonadvancing reply cursors report warnings instead of repeating a page", async (t) => {
  let cursor;
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: false, last_id: cursor,
    list: [{ reply: { reply_id: "1", content: "Body", sub_reply_count: 0 } }] } } }) });
  for (const value of [undefined, "0", "15"]) {
    cursor = value;
    const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", ...(value === "15" ? { page: 2, last_id: "15" } : {}) } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.next_page, undefined);
    assert.equal(result.structuredContent.status, "partial");
    assert.match(result.content[0].text, /REPLY_CURSOR_UNAVAILABLE/);
  }
});

test("duplicate reply parents retain new children from every nested list", async (t) => {
  const child = (id) => ({ reply: { reply_id: id, content: `Child ${id}`, sub_reply_count: 0 } });
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true, list: [
    { reply: { reply_id: "1", content: "", sub_reply_count: 3, sub_replies: [child("3")] }, sub_replies: [child("2")] },
    { reply: { reply_id: "1", content: "Recovered root", sub_reply_count: 3 }, sub_replies: [child("4")] }
  ] } } }) });
  const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(result.isError, undefined);
  const replies = result.structuredContent.replies;
  assert.deepEqual(replies.map((record) => record.reply_id), ["1", "2", "3", "4"]);
  assert.equal(replies[0].body, "Recovered root");
  assert.equal(replies[0].received_child_count, 3);
  assert.equal(replies[0].returned_child_count, 3);
  assert.equal(replies[0].child_coverage, "complete");
});

test("reply child counts describe this output separately from the entire received page", async (t) => {
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true,
    list: [{ reply: { reply_id: "1", content: "Root", sub_reply_count: 2 }, sub_replies: [2, 3].map((id) => ({ reply: { reply_id: String(id), content: "detail ".repeat(250), sub_reply_count: 0 } })) }] } } }) });
  let checkedPartial = false;
  for (const maxChars of [2000, 3000, 4500, 6000]) {
    const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", max_chars: maxChars } });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.length <= maxChars);
    const output = result.structuredContent;
    const root = output.replies[0];
    const included = output.replies.filter((record) => record.parent_reply_id === root.reply_id).length;
    assert.equal(root.received_child_count, 2);
    assert.equal(root.received_child_coverage, "complete");
    assert.equal(root.returned_child_count, included);
    assert.equal(root.child_coverage, included === 2 ? "complete" : "partial");
    assert.equal(output.coverage.received_children, "complete");
    if (included < 2) {
      checkedPartial = true;
      assert.equal(output.coverage.children, "partial");
      assert.ok(output.continuation);
    }
  }
  assert.equal(checkedPartial, true);
});

test("small reply budgets use actual metadata size instead of a fixed reservation", async (t) => {
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true,
    list: [{ reply: { reply_id: "1", content: "OK", sub_reply_count: 0, created_at: 1e100 } }] } } }) });
  const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101", max_chars: 1000 } });
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.length <= 1000);
  assert.equal(result.structuredContent.replies[0].body, "OK");
  assert.equal(result.structuredContent.continuation, undefined);
});

test("overly complex article content produces a typed, schema-valid MCP error", async (t) => {
  let nested = { text: "Deep body" };
  for (let depth = 0; depth < 2000; depth += 1) nested = { content: nested };
  const { client } = await setup(t, { getArticle: async () => ({ payload: post(JSON.stringify(nested)), language: "ja-jp" }) });
  const result = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "DOCUMENT_TOO_COMPLEX");
  assert.equal(client.getToolOutputValidator("read_hoyolab_article")(result.structuredContent).valid, true);
});

test("MCP article reads do not return a pinned old body as latest after cache eviction", async (t) => {
  let content = "Version A";
  let requests = 0;
  const { client } = await setup(t, { getArticle: async ({ postId }) => {
    requests += 1;
    const payload = post(postId === "101" ? content : "Other article");
    payload.data.post.post.post_id = postId;
    return { payload, language: "ja-jp" };
  } }, { maxEntries: 2 });
  const read = async (args = {}) => {
    const result = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101", ...args } });
    assert.equal(result.isError, undefined);
    return result.structuredContent;
  };
  const older = await read();
  content = "Version B";
  const newer = await read({ refresh: true });
  assert.match((await read({ revision: older.revision })).mdx, /Version A/);
  await read({ post_id: "102" });
  const latest = await read();
  assert.equal(latest.revision, newer.revision);
  assert.match(latest.mdx, /Version B/);
  assert.doesNotMatch(latest.mdx, /Version A/);
  assert.equal(latest.cache_hit, false);
  assert.equal(requests, 4);
});

test("MCP Wiki item selection retains nested headings, aliases and media notes", async (t) => {
  const payload = wiki([{ title: "Skill A", desc: "<h1>Details</h1><p>BODY-A</p>", description: "EXTRA-NOTE",
    videos: [{ title: "Clip", url: "https://example.com/a)b", transcript: "TRANSCRIPT" }] }, { title: "Skill B", desc: "BODY-B" }]);
  const { client } = await setup(t, { getWiki: async () => ({ payload, language: "en-us" }) });
  const hierarchy = (await client.callTool({ name: "get_hoyowiki_hierarchy", arguments: { entry_page_id: "202" } })).structuredContent;
  const item = hierarchy.modules[0].components[0].items[0];
  const read = await client.callTool({ name: "read_hoyowiki_entry", arguments: { entry_page_id: "202", revision: hierarchy.revision, section: item.section_id } });
  assert.equal(read.isError, undefined);
  for (const marker of ["BODY-A", "EXTRA-NOTE", "TRANSCRIPT", "https://example.com/a%29b"]) assert.ok(read.content[0].text.includes(marker));
  assert.doesNotMatch(read.content[0].text, /BODY-B/);
  assert.equal(read.structuredContent.status, "partial");
  assert.equal(read.content[0].text, read.structuredContent.mdx);
});

test("search titles and reply images cannot introduce extra Markdown destinations", async (t) => {
  const title = "Name](javascript:bad)[suffix";
  const url = "https://example.com/a)[injected](javascript:bad)";
  const { client } = await setup(t, {
    searchPosts: async () => ({ data: { list: [{ post: { post_id: "101", subject: title, content: "Body" } }] } }),
    searchWiki: async () => ({ data: { entry_pages: [{ id: "202", wiki_app: "genshin", name: title, web_path: url }], posts: [] } }),
    getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true, list: [{ reply: { reply_id: "1", content: "Body", images: [url] } }] } } })
  });
  for (const [name, args] of [["search_hoyolab_posts", { keyword: "test" }], ["search_hoyowiki", { keyword: "test" }], ["read_hoyolab_replies", { post_id: "101" }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0].text, /(?<!\\)\]\(javascript:/i);
    if (name === "search_hoyolab_posts") assert.equal(result.structuredContent.results[0].title, title);
    if (name === "search_hoyowiki") assert.equal(result.structuredContent.entry_pages[0].title, title);
  }
});

test("malformed reply cursors never generate a bogus next page", async (t) => {
  let cursor;
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: false, last_id: cursor,
    list: [{ reply: { reply_id: "1", content: "Body" } }] } } }) });
  for (const value of [{ cursor: 15 }, true, [], 1.5, -1]) {
    cursor = value;
    const result = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.next_page, undefined);
    assert.ok(result.structuredContent.warnings.some((warning) => warning.code === "REPLY_CURSOR_UNAVAILABLE"));
  }
});

test("malformed reply items are visible omissions, not fabricated empty replies", async (t) => {
  let list = [null, {}, true, "invalid", { reply: [] }, { reply: { content: "REAL-IDLESS-BODY" } }];
  const { client } = await setup(t, { getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true, list } } }) });
  const mixed = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(mixed.isError, undefined);
  assert.equal(mixed.structuredContent.returned_count, 1);
  assert.equal(mixed.structuredContent.replies[0].body, "REAL-IDLESS-BODY");
  assert.ok(mixed.structuredContent.warnings.some((warning) => warning.code === "INVALID_REPLY_ITEM"));
  list = [null, {}, false];
  const invalid = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "INVALID_RESPONSE");
  list = [];
  const empty = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(empty.isError, undefined);
  assert.equal(empty.structuredContent.returned_count, 0);
});

test("malformed identifier objects cannot become fabricated IDs or trigger coercion errors", async (t) => {
  const invalidId = { toString: "not callable" };
  const { client } = await setup(t, {
    searchPosts: async () => ({ data: { list: [{ post: { post_id: invalidId, subject: "Invalid" } }, { post: { post_id: "101", subject: "Valid" } }] } }),
    getReplies: async () => ({ payload: { retcode: 0, data: { is_last: true, list: [{ reply: { reply_id: invalidId, f_reply_id: {}, content: "REAL-BODY" } }] } } })
  });
  const search = await client.callTool({ name: "search_hoyolab_posts", arguments: { keyword: "test" } });
  assert.equal(search.isError, undefined);
  assert.deepEqual(search.structuredContent.results.map((item) => item.post_id), ["101"]);
  assert.ok(search.structuredContent.warnings.some((warning) => warning.code === "INVALID_SEARCH_ITEM"));
  const reply = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "101" } });
  assert.equal(reply.isError, undefined);
  assert.equal(reply.structuredContent.replies[0].reply_id, undefined);
  assert.equal(reply.structuredContent.replies[0].parent_reply_id, undefined);
  assert.equal(reply.structuredContent.replies[0].body, "REAL-BODY");
});

test("MCP overload rejects excess work, cancellation removes queued work and remaining calls finish", async (t) => {
  let unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  let announce;
  const activeReady = new Promise((resolve) => { announce = resolve; });
  let calls = 0;
  const { client } = await setup(t, { getArticle: async ({ postId }) => {
    calls += 1;
    if (calls === 8) announce();
    await barrier;
    const payload = post("QUEUED-BODY");
    payload.data.post.post.post_id = postId;
    return { payload };
  } });
  t.after(() => unblock());
  const call = (index, signal) => client.callTool({ name: "read_hoyolab_article", arguments: { post_id: String(1000 + index) } }, undefined, { signal });
  const active = Array.from({ length: 8 }, (_, index) => call(index));
  await activeReady;
  const controller = new AbortController();
  const cancelled = call(8, controller.signal);
  const queued = Array.from({ length: 23 }, (_, index) => call(index + 9));
  const overloaded = await call(32);
  assert.equal(overloaded.isError, true);
  assert.equal(overloaded.structuredContent.error.code, "BUSY");
  assert.equal(overloaded.structuredContent.error.retryable, true);
  const rejection = assert.rejects(cancelled);
  controller.abort();
  await rejection;
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = call(33);
  unblock();
  for (const result of await Promise.all([...active, ...queued, replacement])) {
    assert.equal(result.isError, undefined);
    assert.match(result.structuredContent.mdx, /QUEUED-BODY/);
  }
  assert.equal(calls, 32);
});

test("all eight tools reject malformed input before calling an upstream API", async (t) => {
  let calls = 0;
  const unexpected = async () => { calls += 1; throw new Error("must not fetch"); };
  const { client } = await setup(t, { getArticle: unexpected, getWiki: unexpected, getReplies: unexpected, searchPosts: unexpected, searchWiki: unexpected });
  const cases = [
    ["search_hoyolab_posts", { keyword: "test", author_type: 3 }],
    ["search_hoyowiki", { keyword: " " }],
    ["read_hoyolab_article", { post_id: "101", max_chars: 0 }],
    ["read_hoyowiki_entry", { entry_page_id: "202", wiki_app: "../../example.com" }],
    ["get_hoyowiki_hierarchy", { entry_page_id: {} }],
    ["read_hoyowiki_module", { entry_page_id: "202", module: "" }],
    ["read_hoyowiki_component", { entry_page_id: "202", module: "1", component: null }],
    ["read_hoyolab_replies", { post_id: "101", last_id: {} }]
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /validation/i);
  }
  assert.equal(calls, 0);
});

test("invalid document option combinations fail before document retrieval", async (t) => {
  const { client, calls } = await setup(t);
  const cases = [
    { view: "search" }, { view: "outline", max_matches: 1 }, { match_offset: 0 }, { outline_start: 1 },
    { view: "outline", start_block: 1 }, { table_block: "b1", block_ids: ["b1"] },
    { start_block: 3, end_block: 1 }, { table_block: "b1", row_start: 4, row_end: 1 }
  ];
  for (const [name, identity] of [["read_hoyolab_article", { post_id: "101" }], ["read_hoyowiki_entry", { entry_page_id: "202" }],
    ["read_hoyowiki_module", { entry_page_id: "202", module: "1" }], ["read_hoyowiki_component", { entry_page_id: "202", module: "1", component: "1" }]]) {
    for (const options of cases) {
      const result = await client.callTool({ name, arguments: { ...identity, ...options } });
      assert.equal(result.isError, true, `${name}: ${JSON.stringify(options)}`);
      assert.equal(result.structuredContent.error.code, "INVALID_SELECTION");
    }
  }
  assert.deepEqual(calls, { article: 0, wiki: 0 });
});

test("large table context has schema-valid compact continuations without including other tables", async (t) => {
  const content = "<p>Units.</p><table><tr><th>Level</th><th>Value</th></tr><tr><td>1</td><td>42%</td></tr></table>"
    + Array.from({ length: 1110 }, (_, index) => `<p>NOTE-${index}: ${"detail ".repeat(20)}</p>`
      + (index % 100 === 0 ? "<table><tr><th>Other</th><th>Value</th></tr><tr><td>Not selected</td><td>999</td></tr></table>" : "")).join("");
  const { client } = await setup(t, { getArticle: async () => ({ payload: post(content), language: "ja-jp" }) });
  const full = (await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "101", max_chars: 200000 } })).structuredContent;
  assert.equal(full.continuation, undefined);
  const table = full.blocks.find((block) => block.type === "table");
  const expected = full.blocks.filter((block) => block.type !== "table" || block.block_id === table.block_id).map((block) => block.block_id);
  const seen = [];
  let args = { post_id: "101", table_block: table.block_id, row_start: 1, row_end: 1, revision: full.revision, max_chars: 15000 };
  for (let page = 0; page < 100; page += 1) {
    const result = await client.callTool({ name: "read_hoyolab_article", arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.ok(result.content[0].text.length <= 15000);
    assert.doesNotMatch(result.content[0].text, /Not selected/);
    seen.push(...result.structuredContent.blocks.map((block) => block.block_id));
    if (!result.structuredContent.continuation) break;
    args = result.structuredContent.continuation;
    assert.ok(!args.block_ids || args.block_ids.length <= 1000, "Continuation exceeds the discovered block_ids schema limit");
  }
  assert.deepEqual(seen, expected);
});
