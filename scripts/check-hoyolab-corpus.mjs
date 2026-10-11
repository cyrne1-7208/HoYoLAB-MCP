import assert from "node:assert/strict";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHoYoLabClient } from "../src/hoyolab/api.mjs";
import { createHoYoLabMcpServer } from "../src/mcp/hoyolab-server.mjs";

// Different categories exercise source shapes that character-only examples do not cover.
const GAMES = [
  { app: "genshin", gameId: 2, wiki: [["Kaeya", "Character Archive"], ["Favonius Sword", "Weapons"], ["Mora", "Teyvat's Resources"], ["Hilichurl", "Enemies and Monsters"]] },
  { app: "hsr", gameId: 6, wiki: [["March 7th", "Characters"], ["Cruising in the Stellar Sea", "Light Cones"], ["Credit", "Inventory Items"], ["Voidranger", "Enemies"]] },
  { app: "zzz", gameId: 8, wiki: [["Nicole", "Agents"], ["Starlight Engine", "W-Engines"], ["Denny", "Upgrade Materials"], ["Amillion", "Bangboo"]] }
];
const api = createHoYoLabClient({ defaultLanguage: "en-us" });
const received = new Map();
let requests = 0;
const wrapped = Object.fromEntries(Object.entries(api).map(([name, value]) => [name, typeof value !== "function" ? value : async (args) => {
  requests += 1;
  const response = await value(args);
  if (name === "getWiki") received.set(`wiki:${args.wikiApp}:${args.entryPageId}`, response.payload.data.page);
  if (name === "getArticle") received.set(`article:${args.postId}`, response.payload.data.post.post);
  return response;
}]));
const server = createHoYoLabMcpServer({ apiClient: wrapped });
const client = new Client({ name: "hoyolab-corpus-check", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let calls = 0;
let budgetExpansions = 0;

const normalize = (value) => String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const ignoredSourceKey = /^(?:id|uid|suid|post_id|game_id|entry_page_id|component_id|origin_module_id|type|kind|block_type|layout|style|class|color|font|font_family|font_size|is_.*|can_.*|without_border|rich_text_editing)$/i;

// Sample long text anchors directly from raw fields; do not reuse the converter to generate the expectation.
// This supplements exact block/row checks, and is not a proof that every upstream byte was displayed.
function sourceAnchors(value) {
  const anchors = new Set();
  const stack = [{ value, key: "" }];
  while (stack.length) {
    const current = stack.pop();
    if (ignoredSourceKey.test(current.key) || current.value == null) continue;
    if (typeof current.value === "object") {
      for (const [key, nested] of Object.entries(current.value)) stack.push({ value: nested, key });
      continue;
    }
    if (typeof current.value !== "string") continue;
    const text = current.value.trim();
    if (/^https?:\/\//i.test(text)) continue;
    try {
      const parsed = JSON.parse(text.replace(/^\$([\s\S]*)\$$/, "$1"));
      if (parsed && typeof parsed === "object") { stack.push({ value: parsed, key: current.key }); continue; }
    } catch { /* Ordinary text is checked below. */ }
    const plain = text.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, "\n").replace(/https?:\/\/[^\s)]+/g, "")
      .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ");
    for (const line of plain.split(/\r?\n/)) {
      const normalized = normalize(line);
      if (normalized.length < 24) continue;
      for (const start of [0, Math.floor((normalized.length - 24) / 2), normalized.length - 24]) anchors.add(normalized.slice(start, start + 24));
    }
  }
  return [...anchors];
}

async function call(name, args, { allowBudgetError = false } = {}) {
  calls += 1;
  const result = await client.callTool({ name, arguments: args });
  if (allowBudgetError && result.isError && result.structuredContent?.error?.code === "BUDGET_TOO_SMALL") return result.structuredContent;
  assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
  const data = result.structuredContent;
  assert.equal(data.content_trust, "external-untrusted");
  const text = data.mdx || data.markdown;
  if (text) {
    assert.equal(result.content[0].text, text);
    assert.ok(text.length <= (args.max_chars || (args.view && args.view !== "full" ? 12000 : 60000)));
    const metadata = YAML.parse(text.split("---\n")[1]);
    assert.equal(metadata.revision, data.revision);
    assert.equal(Boolean(metadata.continuation), Boolean(data.continuation));
  }
  return data;
}

async function pages(name, args, { allowBudgetGrowth = false } = {}) {
  let current = args;
  const ids = [];
  const texts = [];
  const sections = [];
  const blocks = [];
  let revision;
  for (let page = 0; page < 200; page += 1) {
    const result = await call(name, current, { allowBudgetError: allowBudgetGrowth });
    if (result.kind === "error") {
      assert.equal(result.error.code, "BUDGET_TOO_SMALL");
      assert.ok((current.max_chars || 60000) < 200000, "A complete block does not fit even at the supported maximum budget");
      current = { ...current, max_chars: 200000 };
      budgetExpansions += 1;
      continue;
    }
    revision ||= result.revision;
    assert.equal(result.revision, revision);
    ids.push(...(result.outline ? result.outline.flatMap((section) => section.blocks) : result.blocks).map((block) => block.block_id));
    blocks.push(...result.blocks);
    texts.push(result.mdx.split("\n---\n").slice(1).join("\n---\n"));
    if (result.outline) sections.push(...result.outline);
    if (!result.continuation) return { ids, text: texts.join("\n"), revision, sections, blocks, warnings: result.warnings, conversion: result.coverage.conversion };
    assert.ok(result.outline?.length || result.blocks.length, "Continuation did not make progress");
    current = result.continuation;
  }
  throw new Error("Continuation did not finish within 200 pages");
}

function verifyAnchors(raw, output, context) {
  const anchors = sourceAnchors(raw);
  const normalized = normalize(output);
  const missing = anchors.filter((anchor) => !normalized.includes(anchor));
  assert.deepEqual(missing.slice(0, 8), [], `${context}: raw source text anchors missing from the selected body`);
  return anchors.length;
}

async function checkWiki(game, keyword, menu) {
  const search = await call("search_hoyowiki", { keyword, game_id: game.gameId, page_size: 15, language: "en-us" });
  const candidates = search.entry_pages.filter((entry) => entry.wiki_app === game.app && entry.menu === menu);
  const candidate = candidates.find((entry) => normalize(entry.title) === normalize(keyword)) || candidates[0];
  assert.ok(candidate, `${game.app}: no ${menu} candidate for ${keyword}`);
  const args = { wiki_app: game.app, entry_page_id: candidate.entry_page_id, language: "en-us" };
  const hierarchy = await call("get_hoyowiki_hierarchy", args);
  const pinned = { ...args, revision: hierarchy.revision, max_chars: 200000 };
  const whole = await pages("read_hoyowiki_entry", pinned);
  const outline = await pages("read_hoyowiki_entry", { ...pinned, view: "outline", outline_size: 200 });
  assert.deepEqual(whole.ids, outline.ids);
  const raw = received.get(`wiki:${game.app}:${candidate.entry_page_id}`);
  let anchors = verifyAnchors(raw.desc || "", whole.text, `${game.app}/${candidate.entry_page_id}/intro`);
  let components = 0;
  for (const module of hierarchy.modules) {
    const moduleRead = await pages("read_hoyowiki_module", { ...pinned, module: module.location });
    const expectedModule = outline.sections.filter((section) => section.location === module.location || section.location?.startsWith(module.location + "."))
      .flatMap((section) => section.blocks.map((block) => block.block_id));
    assert.deepEqual(moduleRead.ids, expectedModule);
    for (const component of module.components) {
      const read = await pages("read_hoyowiki_component", { ...pinned, module: module.location, component: component.location });
      const expectedComponent = outline.sections.filter((section) => section.location === component.location || section.location?.startsWith(component.location + "."))
        .flatMap((section) => section.blocks.map((block) => block.block_id));
      assert.deepEqual(read.ids, expectedComponent);
      const rawComponent = raw.modules[module.module_index - 1].components[component.component_index - 1];
      anchors += verifyAnchors(rawComponent.data, read.text, `${game.app}/${candidate.entry_page_id}/${component.location}`);
      components += 1;
    }
  }
  const small = await pages("read_hoyowiki_entry", { ...pinned, max_chars: 6000 }, { allowBudgetGrowth: true });
  assert.deepEqual(small.ids, whole.ids);
  const tables = outline.sections.flatMap((section) => section.blocks).filter((block) => block.type === "table" && block.rows > 0).slice(0, 3);
  for (const table of tables) for (const row of new Set([1, table.rows])) {
    const selected = await pages("read_hoyowiki_entry", { ...pinned, table_block: table.block_id, row_start: row, row_end: row });
    const selectedTable = selected.blocks.find((block) => block.block_id === table.block_id);
    assert.deepEqual(selectedTable.selected_rows, { start: row, end: row, total: table.rows });
    const expected = whole.blocks.filter((block) => block.block_id === table.block_id || (block.section_id === selectedTable.section_id && block.type !== "table"));
    assert.deepEqual(selected.ids, expected.map((block) => block.block_id));
    assert.equal(selected.blocks.filter((block) => block.type === "table").length, 1);
  }
  const bodyBlocks = whole.blocks.filter((block) => block.type !== "heading").length;
  if (!bodyBlocks) assert.ok(whole.warnings.some((warning) => warning.code === "EMPTY_BODY"), "Empty upstream body must be visible to the client");
  return { entry_id: candidate.entry_page_id, menu, modules: hierarchy.modules.length, components, blocks: whole.ids.length,
    body_blocks: bodyBlocks, source_anchors: anchors, tables_checked: tables.length, conversion: whole.conversion, warning_codes: [...new Set(whole.warnings.map((warning) => warning.code))] };
}

async function checkArticles(game) {
  const search = await call("search_hoyolab_posts", { keyword: "guide", game_id: game.gameId, order_type: 2, page_size: 10, language: "en-us" });
  const candidates = [...new Map(search.results.map((post) => [post.post_id, post])).values()].slice(0, 3);
  assert.equal(candidates.length, 3, `${game.app}: expected three distinct article candidates`);
  const articles = [];
  for (const candidate of candidates) {
    const args = { post_id: candidate.post_id, language: "en-us", max_chars: 200000 };
    const full = await pages("read_hoyolab_article", args);
    const pinned = { ...args, revision: full.revision };
    const outline = await pages("read_hoyolab_article", { ...pinned, view: "outline", outline_size: 200 });
    assert.deepEqual(full.ids, outline.ids);
    const small = await pages("read_hoyolab_article", { ...pinned, block_ids: full.ids, max_chars: 6000 }, { allowBudgetGrowth: true });
    assert.deepEqual(small.ids, full.ids);
    const read = await call("read_hoyolab_article", pinned);
    const raw = received.get(`article:${candidate.post_id}`);
    const source = read.body_source.includes("rows") ? raw.structured_content_rows
      : read.body_source === "quill-delta" ? raw.structured_content : read.body_source.endsWith("desc") ? raw.desc : raw.content;
    const anchors = verifyAnchors(source, full.text, `${game.app}/article/${candidate.post_id}`);
    articles.push({ post_id: candidate.post_id, blocks: full.ids.length, source: read.body_source, source_anchors: anchors });
  }
  return articles;
}

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, 8);
  const games = [];
  for (const game of GAMES) {
    const entries = [];
    for (const [keyword, menu] of game.wiki) {
      const entry = await checkWiki(game, keyword, menu);
      entries.push(entry);
      process.stderr.write(`Verified ${game.app} ${menu}: ${entry.entry_id}, ${entry.source_anchors} source anchors\n`);
    }
    games.push({ app: game.app, wiki: entries, articles: await checkArticles(game) });
  }
  console.log(JSON.stringify({ ok: true, calls, api_requests: requests, budget_expansions: budgetExpansions, games }, null, 2));
} finally {
  await client.close();
  await server.close();
}
