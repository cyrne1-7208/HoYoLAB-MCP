import assert from "node:assert/strict";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Public examples supplement deterministic fixtures; upstream edits can invalidate a pinned reply page.
const GAMES = [
  { app: "genshin", gameId: 2, keyword: "Venti", entryId: "49", officialPost: "46791577", userPost: "46672037" },
  { app: "hsr", gameId: 6, keyword: "Acheron", entryId: "1919", officialPost: "46814308", userPost: "46763602" },
  { app: "zzz", gameId: 8, keyword: "Anby", entryId: "2", officialPost: "46622788", userPost: "45888979" }
];
const client = new Client({ name: "hoyolab-regression-check", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/mcp-server.mjs"], cwd: process.cwd(), stderr: "pipe" });
transport.stderr.on("data", (chunk) => process.stderr.write(chunk));
let calls = 0;

async function call(name, args) {
  calls += 1;
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
  const data = result.structuredContent;
  assert.equal(data.content_trust, "external-untrusted");
  if (data.mdx || data.markdown) {
    const text = data.mdx || data.markdown;
    assert.equal(result.content[0].text, text);
    assert.ok(text.length <= (args.max_chars || (args.view && args.view !== "full" ? 12000 : 60000)));
    const metadata = YAML.parse(text.split("---\n")[1]);
    assert.equal(Boolean(metadata.continuation), Boolean(data.continuation));
  }
  return data;
}

async function readBodyPages(name, args) {
  const ids = [];
  let current = args;
  let revision;
  for (let page = 0; page < 100; page += 1) {
    const data = await call(name, current);
    revision ||= data.revision;
    assert.equal(data.revision, revision);
    ids.push(...data.blocks.map((block) => block.block_id));
    if (!data.continuation) return ids;
    assert.ok(data.blocks.length, "A continuation must make progress");
    current = data.continuation;
  }
  throw new Error("Document continuation did not finish within 100 pages");
}

function checkReplyCounts(data) {
  assert.equal(data.returned_count, data.replies.length);
  for (const reply of data.replies) {
    const children = data.replies.filter((child) => child.parent_reply_id === reply.reply_id).length;
    assert.equal(reply.returned_child_count, children);
    assert.ok(reply.received_child_count >= children);
    if (reply.sub_reply_count != null && Number.isInteger(Number(reply.sub_reply_count)) && Number(reply.sub_reply_count) >= children) {
      assert.equal(reply.child_coverage, children < Number(reply.sub_reply_count) ? "partial" : "complete");
    }
  }
}

async function checkReplies(game) {
  const args = { post_id: game.officialPost, size: 15, language: "en-us", max_chars: 200000 };
  const first = await call("read_hoyolab_replies", args);
  assert.ok(first.returned_root_count > 0, `${game.app}: expected a nonempty reply page`);
  assert.equal(first.continuation, undefined);
  checkReplyCounts(first);
  assert.ok(first.next_page?.last_id, `${game.app}: expected a second page cursor`);
  const next = await call("read_hoyolab_replies", first.next_page);
  checkReplyCounts(next);
  assert.equal(next.requested_cursor, String(first.last_id));
  assert.equal(next.page, 2);
  const firstRoots = new Set(first.replies.filter((reply) => reply.depth === 0).map((reply) => reply.reply_id));
  assert.ok(next.replies.some((reply) => reply.depth === 0 && !firstRoots.has(reply.reply_id)), "Cursor pagination repeated the first page");

  const small = await call("read_hoyolab_replies", { ...args, revision: first.revision, max_chars: 6000 });
  checkReplyCounts(small);
  const ids = small.replies.map((reply) => reply.reply_id);
  let current = small;
  for (let page = 0; current.continuation && page < 100; page += 1) {
    current = await call("read_hoyolab_replies", current.continuation);
    checkReplyCounts(current);
    assert.equal(current.revision, first.revision);
    ids.push(...current.replies.map((reply) => reply.reply_id));
  }
  assert.equal(current.continuation, undefined);
  assert.deepEqual(ids, first.replies.map((reply) => reply.reply_id));
  const invalid = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: game.officialPost, page: 2 } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "INVALID_SELECTION");
  return { first_records: first.returned_count, next_records: next.returned_count, cursor: first.next_page.last_id, budgeted_records: ids.length };
}

async function checkWiki(game) {
  const args = { wiki_app: game.app, entry_page_id: game.entryId, language: "en-us", max_chars: 200000 };
  const hierarchy = await call("get_hoyowiki_hierarchy", { wiki_app: game.app, entry_page_id: game.entryId, language: "en-us" });
  const pinned = { ...args, revision: hierarchy.revision };
  const outline = await call("read_hoyowiki_entry", { ...pinned, view: "outline", outline_size: 200 });
  assert.equal(outline.continuation, undefined);
  const refs = outline.outline.flatMap((section) => section.blocks.map((block) => ({ id: block.block_id, location: section.location })));
  const fullIds = await readBodyPages("read_hoyowiki_entry", pinned);
  assert.deepEqual(fullIds, refs.map((block) => block.id));
  let modules = 0;
  let components = 0;
  for (const module of hierarchy.modules) {
    const expected = refs.filter((block) => block.location === module.location || block.location?.startsWith(module.location + ".")).map((block) => block.id);
    assert.deepEqual(await readBodyPages("read_hoyowiki_module", { ...pinned, module: module.location }), expected);
    modules += 1;
    for (const component of module.components) {
      const expectedComponent = refs.filter((block) => block.location === component.location || block.location?.startsWith(component.location + ".")).map((block) => block.id);
      assert.deepEqual(await readBodyPages("read_hoyowiki_component", { ...pinned, module: module.location, component: component.location }), expectedComponent);
      components += 1;
    }
  }
  return { entry_id: game.entryId, modules, components, blocks: fullIds.length };
}

async function checkArticles(game) {
  const versions = new Set();
  const languages = [];
  for (const language of ["en-us", "JA", "zh-cn"]) {
    const data = await call("read_hoyolab_article", { post_id: game.officialPost, language, max_chars: 200000 });
    assert.ok(data.blocks.length > 0);
    assert.equal(data.actual_language, language === "JA" ? "ja-jp" : language);
    assert.equal(data.is_multilingual, true);
    assert.equal(data.continuation, undefined);
    versions.add(data.revision);
    languages.push(data.actual_language);
  }
  assert.equal(versions.size, 3);
  const user = await call("read_hoyolab_article", { post_id: game.userPost, language: "en-us", max_chars: 200000 });
  assert.ok(user.blocks.length > 0);
  const ids = await readBodyPages("read_hoyolab_article", { post_id: game.userPost, language: "en-us", revision: user.revision,
    block_ids: user.blocks.map((block) => block.block_id), max_chars: 6000 });
  assert.deepEqual(ids, user.blocks.map((block) => block.block_id));
  return { official_post: game.officialPost, languages, user_post: game.userPost, user_blocks: ids.length };
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  assert.ok(listed.tools.every((tool) => tool.outputSchema));
  for (const tool of listed.tools.filter((tool) => tool.name.startsWith("search_"))) {
    const author = JSON.stringify(tool.inputSchema.properties.author_type);
    assert.doesNotMatch(author, /"const":3|follow/i);
  }
  const games = [];
  for (const game of GAMES) {
    const searches = [];
    for (const order_type of [0, 2]) for (const author_type of [0, 1, 2]) {
      const data = await call("search_hoyolab_posts", { keyword: game.keyword, game_id: game.gameId, language: "en-us", order_type, author_type, page_size: 3 });
      assert.equal(data.filters.order_type, order_type);
      assert.equal(data.filters.author_type, author_type);
      assert.ok(data.results.every((item) => /^\d+$/.test(item.post_id)));
      searches.push({ order_type, author_type, count: data.results.length });
    }
    const result = { app: game.app, searches, articles: await checkArticles(game), wiki: await checkWiki(game), replies: await checkReplies(game) };
    games.push(result);
    process.stderr.write(`Verified ${game.app}: ${result.wiki.modules} modules, ${result.wiki.components} components, reply cursor ${result.replies.cursor}\n`);
  }
  console.log(JSON.stringify({ ok: true, calls, games }, null, 2));
} finally {
  await client.close().catch(() => {});
}
