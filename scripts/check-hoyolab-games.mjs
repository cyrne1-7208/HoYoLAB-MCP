import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These cases cover the two non-Genshin HoYoWiki applications supported by the public API.
const GAME_CASES = [
  { name: "honkai-star-rail", gameId: 6, wikiApp: "hsr", keyword: "Acheron", language: "en-us" },
  { name: "zenless-zone-zero", gameId: 8, wikiApp: "zzz", keyword: "Anby", language: "en-us" }
];

const REQUIRED_TOOLS = [
  "search_hoyolab_posts",
  "search_hoyowiki",
  "read_hoyolab_article",
  "read_hoyowiki_entry",
  "get_hoyowiki_hierarchy",
  "read_hoyowiki_module",
  "read_hoyowiki_component",
  "read_hoyolab_replies"
];

const client = new Client({ name: "hoyolab-multigame-check", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/mcp-server.mjs"],
  cwd: process.cwd(),
  stderr: "pipe"
});

transport.stderr.on("data", (chunk) => process.stderr.write(chunk));

function textResult(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function requireText(text, marker, label) {
  requireValue(text.includes(marker), `${label} did not contain ${marker}`);
}

function requireNoResidualHtml(text, label) {
  requireValue(!/<\/?(?:p|div|span|table|thead|tbody|tr|th|td|img|iframe|hoyolab)\b/i.test(text), `${label} retained HTML markup`);
}

function validateMdx(result, label, kind) {
  const text = textResult(result);
  const structured = result.structuredContent || {};
  requireValue(!result.isError, `${label} returned an MCP error: ${text}`);
  requireValue(typeof structured.mdx === "string", `${label} did not return structuredContent.mdx`);
  requireValue(structured.mdx === text, `${label} content and structuredContent.mdx differ`);
  requireText(text, kind === "article" ? "# Article:" : "\n# ", `${label} content`);
  requireValue(text.length > 300, `${label} returned an unexpectedly short document`);
  requireNoResidualHtml(text, label);
  if (kind === "wiki") {
    requireValue(!/^(?:# Wiki entry:|## \d+\. Module:|### \d+\.\d+\. Component:|#### \d+\.\d+\.\d+\. Item:)/m.test(text), `${label} retained a redundant hierarchy label`);
  }
  return { text, structured };
}

async function callTool(name, arguments_, label = name) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = textResult(result);
  requireValue(!result.isError, `${label} returned an MCP error: ${text}`);
  return result;
}

async function findArticle(postResults, game) {
  // Search results can mix official and user posts, so select the first readable body instead of relying on one fixed ID.
  let fallback;
  for (const result of postResults) {
    if (!/^\d+$/.test(result?.post_id || "")) continue;
    const arguments_ = { post_id: result.post_id, language: game.language };
    const article = await callTool("read_hoyolab_article", arguments_, `read_hoyolab_article:${game.name}:${result.post_id}`);
    const checked = validateMdx(article, `read_hoyolab_article:${game.name}:${result.post_id}`, "article");
    fallback ||= { postId: result.post_id, article, checked };
    const body = checked.text.split("## Article body", 2)[1]?.trim() || "";
    if (body.length > 40) return { postId: result.post_id, article, checked };
  }
  requireValue(fallback, `${game.name} search returned no readable article ID`);
  return fallback;
}

async function findWikiEntry(entryResults, game) {
  // Prefer an entry with addressable child locations because module and component tools need those selectors.
  let fallback;
  for (const entry of entryResults) {
    if (!/^\d+$/.test(entry?.entry_page_id || "")) continue;
    const wikiApp = entry.wiki_app || game.wikiApp;
    const arguments_ = { wiki_app: wikiApp, entry_page_id: entry.entry_page_id, language: game.language };
    const hierarchy = await callTool("get_hoyowiki_hierarchy", arguments_, `get_hoyowiki_hierarchy:${game.name}:${entry.entry_page_id}`);
    const hierarchyData = hierarchy.structuredContent || {};
    const module = hierarchyData.modules?.find((candidate) => candidate.components?.length);
    const component = module?.components?.[0];
    if (!module || !component) continue;
    const full = await callTool("read_hoyowiki_entry", arguments_, `read_hoyowiki_entry:${game.name}:${entry.entry_page_id}`);
    const checked = validateMdx(full, `read_hoyowiki_entry:${game.name}:${entry.entry_page_id}`, "wiki");
    fallback ||= { entryPageId: entry.entry_page_id, wikiApp, hierarchy, hierarchyData, full, checked, module, component };
    if (checked.text.length > 300) return { entryPageId: entry.entry_page_id, wikiApp, hierarchy, hierarchyData, full, checked, module, component };
  }
  requireValue(fallback, `${game.name} search returned no Wiki entry with a readable hierarchy`);
  return fallback;
}

async function checkGame(game) {
  const postSearch = await callTool("search_hoyolab_posts", {
    keyword: game.keyword,
    game_id: game.gameId,
    page_size: 5,
    order_type: 2,
    author_type: 0,
    language: game.language
  }, `search_hoyolab_posts:${game.name}`);
  const postResults = postSearch.structuredContent?.results || [];
  requireValue(postResults.some((result) => /^\d+$/.test(result?.post_id || "")), `${game.name} post search returned no numeric post ID`);
  requireValue(postSearch.structuredContent?.filters?.order === "latest", `${game.name} post search did not preserve latest sort`);

  const wikiSearch = await callTool("search_hoyowiki", {
    keyword: game.keyword,
    game_id: game.gameId,
    page_size: 5,
    order_type: 0,
    author_type: 0,
    language: game.language
  }, `search_hoyowiki:${game.name}`);
  const entryResults = wikiSearch.structuredContent?.entry_pages || [];
  requireValue(entryResults.some((entry) => /^\d+$/.test(entry?.entry_page_id || "")), `${game.name} Wiki search returned no numeric entry ID`);
  requireValue(wikiSearch.structuredContent?.filters?.order === "relevance", `${game.name} Wiki search did not preserve default sort`);

  const article = await findArticle(postResults, game);
  const wiki = await findWikiEntry(entryResults, game);
  const wikiArguments = { wiki_app: wiki.wikiApp, entry_page_id: wiki.entryPageId, language: game.language };

  const hierarchyText = textResult(wiki.hierarchy);
  // The hierarchy response is the source of truth for selectors passed to the scoped read tools.
  requireText(hierarchyText, `## ${wiki.module.number}. `, `get_hoyowiki_hierarchy:${game.name}`);
  requireText(hierarchyText, `### ${wiki.component.number}. `, `get_hoyowiki_hierarchy:${game.name}`);
  requireValue(wiki.module.location && wiki.component.location, `${game.name} hierarchy did not expose scoped locations`);

  const moduleResult = await callTool("read_hoyowiki_module", {
    ...wikiArguments,
    module: wiki.module.location
  }, `read_hoyowiki_module:${game.name}`);
  const moduleChecked = validateMdx(moduleResult, `read_hoyowiki_module:${game.name}`, "wiki");
  requireText(moduleChecked.text, `## ${wiki.module.number}. `, `read_hoyowiki_module:${game.name}`);

  const componentResult = await callTool("read_hoyowiki_component", {
    ...wikiArguments,
    module: wiki.module.location,
    component: wiki.component.location
  }, `read_hoyowiki_component:${game.name}`);
  const componentChecked = validateMdx(componentResult, `read_hoyowiki_component:${game.name}`, "wiki");
  requireText(componentChecked.text, `### ${wiki.component.number}. `, `read_hoyowiki_component:${game.name}`);

  const replies = await callTool("read_hoyolab_replies", {
    post_id: article.postId,
    size: 5,
    language: game.language
  }, `read_hoyolab_replies:${game.name}`);
  const replyText = textResult(replies);
  const replyData = replies.structuredContent || {};
  requireText(replyText, "# Replies:", `read_hoyolab_replies:${game.name}`);
  requireNoResidualHtml(replyText, `read_hoyolab_replies:${game.name}`);
  requireValue(replyData.markdown === replyText, `read_hoyolab_replies:${game.name} content and structuredContent.markdown differ`);
  requireValue(Array.isArray(replyData.replies), `read_hoyolab_replies:${game.name} did not return a replies array`);

  return {
    game: game.name,
    game_id: game.gameId,
    wiki_app: wiki.wikiApp,
    post_id: article.postId,
    entry_page_id: wiki.entryPageId,
    module_location: wiki.module.location,
    component_location: wiki.component.location,
    reply_count: replyData.total_count ?? replyData.replies.length,
    tools: REQUIRED_TOOLS
  };
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const available = new Set(listed.tools.map((tool) => tool.name));
  const missing = REQUIRED_TOOLS.filter((name) => !available.has(name));
  requireValue(missing.length === 0, `Missing MCP tools: ${missing.join(", ")}`);
  const results = [];
  for (const game of GAME_CASES) results.push(await checkGame(game));
  console.log(JSON.stringify({ ok: true, tools: listed.tools.map((tool) => tool.name), games: results }, null, 2));
} finally {
  await client.close().catch(() => {});
}
