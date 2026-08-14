import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createHoYoLabClient, HoYoLabApiError } from "../hoyolab/api.mjs";
import {
  articleToMdx,
  cleanTitle,
  htmlToMarkdown,
  richTextToMarkdown,
  unwrapApiData,
  wikiHierarchy,
  wikiLocationToMdx,
  wikiToMdx
} from "../transform/hoyolab-mdx.mjs";

const SERVER_NAME = "hoyolab-mcp";
const SERVER_VERSION = "0.1.0";
const LANGUAGE_SCHEMA = z.string().regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i).optional()
  .describe("HoYoLAB language code, for example ja-jp, en-us, or zh-cn; short aliases such as JA, JP, and EN are normalized");
const POST_ID_SCHEMA = z.string().regex(/^\d+$/).describe("Numeric HoYoLAB post ID");
const ENTRY_ID_SCHEMA = z.string().regex(/^\d+$/).describe("Numeric HoYoWiki entry page ID");
const WIKI_APP_SCHEMA = z.string().regex(/^[a-z0-9_-]+$/i).default("genshin")
  .describe("HoYoWiki application name, for example genshin");
const SEARCH_ORDER_TYPE_SCHEMA = z.union([z.literal(0), z.literal(2)]).default(0)
  .describe("Search order: 0 = relevance/default, 2 = latest posts");
// The followed-account option is not exposed because the anonymous public API rejects it.
const SEARCH_AUTHOR_TYPE_SCHEMA = z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0)
  .describe("Author filter: 0 = all, 1 = official accounts, 2 = authenticated accounts");
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});

function articleUrl(postId) {
  return postId ? `https://www.hoyolab.com/article/${postId}` : undefined;
}

function wikiUrl(wikiApp, entryPageId) {
  return wikiApp && entryPageId
    ? `https://wiki.hoyolab.com/pc/${wikiApp}/entry/${entryPageId}`
    : undefined;
}

function isoDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number * 1000).toISOString();
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactObject(object) {
  // Omit empty optional metadata so structured results stay compact without changing required values.
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

function articleBundle(payload) {
  const data = unwrapApiData(payload);
  const bundle = data?.post?.post ? data.post : data;
  return {
    data,
    bundle,
    post: bundle?.post ?? {},
    user: bundle?.user ?? {},
    game: bundle?.game ?? {}
  };
}

function searchPostResult(item) {
  const post = item?.post ?? item ?? {};
  const postId = post.post_id === undefined ? undefined : String(post.post_id);
  return compactObject({
    post_id: postId,
    title: cleanTitle(post.subject || post.title),
    snippet: htmlToMarkdown(post.content || post.desc || ""),
    author: textValue(item?.user?.nickname || post.user?.nickname),
    game: textValue(item?.game?.game_name || post.game?.game_name),
    created_at: isoDate(post.created_at),
    url: articleUrl(postId),
    views: item?.stat?.view_num ?? post.view_num,
    images: Array.isArray(item?.image_list) ? item.image_list.map((image) => image?.url || image?.image_url).filter(Boolean) : undefined
  });
}

function searchWikiResult(item) {
  const webPath = textValue(item?.web_path) || textValue(item?.app_path);
  const entryPageId = item?.entry_page_id ?? item?.id ?? webPath.match(/\/entry\/(\d+)(?:[/?#]|$)/i)?.[1];
  const wikiApp = textValue(item?.wiki_app) || textValue(item?.app_name) || webPath.match(/\/pc\/([^/]+)\/entry\//i)?.[1] || undefined;
  return compactObject({
    entry_page_id: entryPageId === undefined ? undefined : String(entryPageId),
    wiki_app: wikiApp,
    title: cleanTitle(item?.name || item?.title),
    menu: textValue(item?.menu_name),
    game: textValue(item?.game_name),
    icon_url: textValue(item?.icon_url),
    url: webPath || wikiUrl(wikiApp || "genshin", entryPageId)
  });
}

function searchFilterInfo(orderType, authorType) {
  const authorLabels = {
    0: "all",
    1: "official",
    2: "authenticated"
  };
  return {
    order_type: orderType,
    order: Number(orderType) === 2 ? "latest" : "relevance",
    author_type: authorType,
    author: authorLabels[authorType] || "unknown"
  };
}

function formatPostSearch({ keyword, data, page, pageSize, orderType, authorType, language }) {
  // Search results expose identifiers and context while full readable content remains the responsibility of the read tool.
  const list = Array.isArray(data?.list) ? data.list : [];
  const results = list.map(searchPostResult);
  const lines = [`# HoYoLAB post search: ${keyword}`, ""];
  if (!results.length) lines.push("> No matching posts were returned.");
  for (const result of results) {
    const title = result.url ? `[${result.title}](${result.url})` : result.title;
    const meta = [result.post_id ? `post_id: ${result.post_id}` : "", result.author, result.game, result.created_at]
      .filter(Boolean).join(" · ");
    lines.push(`## ${title}`);
    if (meta) lines.push(`- ${meta}`);
    if (result.snippet) lines.push(result.snippet);
    lines.push("");
  }
  return {
    text: lines.join("\n").trim() + "\n",
    structured: {
      kind: "post-search",
      keyword,
      page,
      page_size: pageSize,
      language,
      filters: searchFilterInfo(orderType, authorType),
      is_last: data?.is_last,
      next_offset: data?.next_offset,
      results
    }
  };
}

function formatWikiSearch({ keyword, data, page, pageSize, orderType, authorType, language }) {
  const posts = Array.isArray(data?.posts) ? data.posts.map(searchPostResult) : [];
  const entries = Array.isArray(data?.entry_pages) ? data.entry_pages.map(searchWikiResult) : [];
  const lines = [`# HoYoLAB Wiki search: ${keyword}`, ""];
  if (!posts.length && !entries.length) lines.push("> No matching posts or Wiki entries were returned.");
  if (entries.length) {
    lines.push("## Wiki entries", "");
    for (const entry of entries) {
      const title = entry.url ? `[${entry.title}](${entry.url})` : entry.title;
      const meta = [entry.entry_page_id ? `entry_page_id: ${entry.entry_page_id}` : "", entry.menu, entry.game]
        .filter(Boolean).join(" · ");
      lines.push(`- ${title}${meta ? ` — ${meta}` : ""}`);
    }
    lines.push("");
  }
  if (posts.length) {
    lines.push("## Related posts", "");
    for (const post of posts) {
      const title = post.url ? `[${post.title}](${post.url})` : post.title;
      lines.push(`- ${title}${post.post_id ? ` — post_id: ${post.post_id}` : ""}`);
    }
  }
  return {
    text: lines.join("\n").trim() + "\n",
    structured: {
      kind: "wiki-search",
      keyword,
      page,
      page_size: pageSize,
      language,
      filters: searchFilterInfo(orderType, authorType),
      is_last: data?.is_last,
      recommend_words: data?.recommend_words,
      entry_pages: entries,
      posts
    }
  };
}

function hierarchyDisplay(value, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function formatWikiHierarchy(hierarchy) {
  // Keep hierarchy text aligned with MDX headings so a displayed location can be copied into a scoped read call.
  const lines = [
    `# ${hierarchyDisplay(hierarchy.title, "Untitled entry")}`,
    "",
    `- wiki_app: ${hierarchy.wiki_app || "unknown"}`,
    `- entry_page_id: ${hierarchy.entry_page_id || "unknown"}`
  ];
  const modules = Array.isArray(hierarchy.modules) ? hierarchy.modules : [];
  if (!modules.length) {
    lines.push("", "> No modules were returned.");
    return lines.join("\n") + "\n";
  }

  for (const module of modules) {
    const moduleNumber = module.number || String(module.module_index);
    const moduleTitle = hierarchyDisplay(module.name, "Untitled section");
    lines.push("", `## ${moduleNumber}. ${moduleTitle}`, `- location: \`${module.location}\``);
    const components = Array.isArray(module.components) ? module.components : [];
    if (!components.length) {
      lines.push("- No subsections");
      continue;
    }
    for (const component of components) {
      const componentNumber = component.number || `${module.module_index}.${component.component_index}`;
      const componentTitle = hierarchyDisplay(component.name, "Untitled subsection");
      lines.push(
        "",
        `### ${componentNumber}. ${componentTitle}`,
        `- component_id: \`${component.component_id || "unknown"}\``,
        `- location: \`${component.location}\``
      );
      const items = Array.isArray(component.items) ? component.items : [];
      if (!items.length) {
        lines.push("- No separately addressable entries");
        continue;
      }
      for (const item of items) {
        const itemNumber = item.number || `${module.module_index}.${component.component_index}.${item.item_index}`;
        lines.push(`- ${itemNumber}. ${hierarchyDisplay(item.title, "Untitled entry")} (\`${item.location}\`)`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function replyList(data) {
  const candidates = [data?.list, data?.replies, data?.reply_list, data?.post?.reply_list]
    .filter(Array.isArray);
  return candidates.find((candidate) => candidate.length > 0) || candidates[0] || [];
}

function imageUrl(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value.url || value.image_url || value.img_url || value.src || value.image || "";
}

function replyImageUrls(item, reply) {
  const values = [item?.images, reply?.images, item?.r_reply_images, reply?.r_reply_images];
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map(imageUrl)
    .map((value) => {
      try {
        return new URL(value).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean))];
}

function replyRecord(item, language, depth, parentReplyId) {
  // Normalize the endpoint's nested reply shapes into one record model for Markdown and structured output.
  const reply = item?.reply ?? item ?? {};
  const user = item?.user ?? reply?.user ?? {};
  const replyId = reply.reply_id ?? reply.id;
  const parentId = reply.f_reply_id ?? reply.parent_reply_id ?? item?.r_reply?.reply_id ?? parentReplyId;
  const bodyResult = richTextToMarkdown({
    content: reply.content,
    desc: reply.desc,
    structuredContent: reply.struct_content ?? reply.structured_content,
    structuredRows: reply.structured_content_rows
  });
  const deleted = reply.is_deleted === true || Number(reply.is_deleted) === 1;
  return {
    reply_id: replyId === undefined ? undefined : String(replyId),
    parent_reply_id: parentId === undefined || parentId === null || parentId === "" ? undefined : String(parentId),
    depth,
    author: textValue(user.nickname || user.user_nickname || reply.user_nickname),
    created_at: isoDate(reply.created_at ?? reply.create_time),
    body: bodyResult.body || undefined,
    body_source: bodyResult.source,
    language: reply.lang || language,
    images: replyImageUrls(item, reply),
    is_deleted: deleted || undefined,
    sub_reply_count: item?.sub_reply_count ?? reply.sub_reply_count
  };
}

function nestedReplyList(item) {
  const reply = item?.reply ?? item ?? {};
  const candidates = [item?.sub_replies, reply?.sub_replies, item?.replies, reply?.replies]
    .filter(Array.isArray);
  return candidates.find((candidate) => candidate.length > 0) || [];
}

function collectReplyRecords(items, language, depth = 0, parentReplyId, seen = new Set()) {
  const records = [];
  for (const item of items) {
    const record = replyRecord(item, language, depth, parentReplyId);
    const key = record.reply_id || `${depth}:${records.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
    const nested = nestedReplyList(item);
    if (nested.length) {
      records.push(...collectReplyRecords(nested, language, depth + 1, record.reply_id, seen));
    }
  }
  return records;
}

function formatReplyRecord(lines, record) {
  const headingLevel = "#".repeat(Math.min(6, 2 + Number(record.depth || 0)));
  const title = [record.reply_id ? `Reply ${record.reply_id}` : "Reply", record.author].filter(Boolean).join(" — ");
  lines.push(`${headingLevel} ${title}`);
  if (record.created_at) lines.push(`- ${record.created_at}`);
  if (record.is_deleted) {
    lines.push("> Reply was deleted.");
  } else if (record.body) {
    lines.push(record.body);
  } else {
    lines.push("> No readable reply body was returned.");
  }
  for (const url of record.images || []) lines.push(`![Reply image](${url})`);
  lines.push("");
}

function formatReplies(payload, postId, language) {
  const data = unwrapApiData(payload);
  const items = replyList(data);
  const records = collectReplyRecords(items, language);
  const lines = [`# Replies: HoYoLAB article ${postId}`, ""];
  if (!items.length) lines.push("> No replies were returned.");
  for (const record of records) formatReplyRecord(lines, record);
  const text = lines.join("\n").trim() + "\n";
  return {
    text,
    structured: {
      kind: "article-replies",
      post_id: postId,
      language,
      languages: [...new Set(records.map((record) => record.language).filter(Boolean))],
      count: items.length,
      total_count: records.length,
      is_last: data?.is_last,
      last_id: data?.last_id,
      markdown: text,
      replies: records
    }
  };
}

function toolSuccess(text, structured) {
  // Return the same complete document in protocol text and structuredContent so clients can choose either field safely.
  return {
    content: [{ type: "text", text }],
    structuredContent: structured
  };
}

function toolFailure(error) {
  const message = error instanceof HoYoLabApiError || error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `HoYoLAB MCP error: ${message}` }]
  };
}

function withToolErrors(handler) {
  // Convert request and transformation failures into MCP tool errors instead of uncaught stdio exceptions.
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      return toolFailure(error);
    }
  };
}

export function createHoYoLabMcpServer({ apiClient = createHoYoLabClient() } = {}) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "Read-only HoYoLAB and HoYoWiki search and MDX retrieval server"
  });

  server.registerTool("search_hoyolab_posts", {
    title: "Search HoYoLAB posts",
    description: "Search public HoYoLAB posts. Results are compact Markdown; call read_hoyolab_article with a returned post_id for the full MDX article.",
    inputSchema: {
      keyword: z.string().trim().min(1).describe("Search keyword"),
      game_id: z.number().int().min(0).max(100000).optional().describe("HoYoLAB game ID; Genshin Impact is 2"),
      page: z.number().int().min(1).max(10000).default(1),
      page_size: z.number().int().min(1).max(50).default(15),
      order_type: SEARCH_ORDER_TYPE_SCHEMA,
      author_type: SEARCH_AUTHOR_TYPE_SCHEMA,
      is_all_game: z.boolean().default(false),
      scene: z.string().min(1).max(64).default("SCENE_GENERAL"),
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ keyword, game_id, page, page_size, order_type, author_type, is_all_game, scene, language }) => {
    const response = await apiClient.searchPosts({
      keyword,
      gameId: game_id,
      page,
      pageSize: page_size,
      orderType: order_type,
      authorType: author_type,
      isAllGame: is_all_game,
      scene,
      language
    });
    const effectiveLanguage = response.language || language;
    const result = formatPostSearch({ keyword, data: response.data, page, pageSize: page_size, orderType: order_type, authorType: author_type, language: effectiveLanguage });
    return toolSuccess(result.text, result.structured);
  }));

  server.registerTool("search_hoyowiki", {
    title: "Search HoYoWiki",
    description: "Search public HoYoLAB posts and HoYoWiki entries. Results include entry_page_id and URL; call read_hoyowiki_entry for the full MDX entry.",
    inputSchema: {
      keyword: z.string().trim().min(1).describe("Search keyword"),
      game_id: z.number().int().min(0).max(100000).optional().describe("HoYoLAB game ID; Genshin Impact is 2"),
      page: z.number().int().min(1).max(10000).default(1),
      page_size: z.number().int().min(1).max(50).default(15),
      order_type: SEARCH_ORDER_TYPE_SCHEMA,
      author_type: SEARCH_AUTHOR_TYPE_SCHEMA,
      is_all_game: z.boolean().default(false),
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ keyword, game_id, page, page_size, order_type, author_type, is_all_game, language }) => {
    const response = await apiClient.searchWiki({
      keyword,
      gameId: game_id,
      page,
      pageSize: page_size,
      orderType: order_type,
      authorType: author_type,
      isAllGame: is_all_game,
      language
    });
    const effectiveLanguage = response.language || language;
    const result = formatWikiSearch({ keyword, data: response.data, page, pageSize: page_size, orderType: order_type, authorType: author_type, language: effectiveLanguage });
    return toolSuccess(result.text, result.structured);
  }));

  server.registerTool("read_hoyolab_article", {
    title: "Read HoYoLAB article as MDX",
    description: "Fetch a public HoYoLAB article and return the complete converted MDX. Multilingual responses use the requested language when available.",
    inputSchema: {
      post_id: POST_ID_SCHEMA,
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ post_id, language }) => {
    const response = await apiClient.getArticle({ postId: post_id, language });
    const bundle = articleBundle(response.payload);
    const effectiveLanguage = response.language || language;
    // Build the document once so the visible MCP text and structured metadata cannot diverge.
    const mdx = articleToMdx(response.payload, { language: effectiveLanguage, sourceUrl: response.url });
    return toolSuccess(mdx, compactObject({
      kind: "article",
      format: "mdx",
      post_id,
      title: cleanTitle(bundle.post.subject || bundle.post.title),
      language: bundle.post.lang || effectiveLanguage,
      api_origin_lang: bundle.post.origin_lang,
      is_multilingual: bundle.post.is_multi_language,
      available_languages: Array.isArray(bundle.post.multi_language_info?.langs) ? bundle.post.multi_language_info.langs : undefined,
      source_url: response.url,
      human_url: articleUrl(post_id),
      body_source: mdx.match(/^body_source: ([^\n]+)/m)?.[1],
      mdx
    }));
  }));

  server.registerTool("read_hoyowiki_entry", {
    title: "Read HoYoWiki entry as MDX",
    description: "Fetch a public HoYoWiki entry and return complete converted MDX with a numbered hierarchy, tables, links, and media. Use get_hoyowiki_hierarchy first when selecting a subsection.",
    inputSchema: {
      wiki_app: WIKI_APP_SCHEMA,
      entry_page_id: ENTRY_ID_SCHEMA,
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ wiki_app, entry_page_id, language }) => {
    const response = await apiClient.getWiki({ wikiApp: wiki_app, entryPageId: entry_page_id, language });
    const effectiveLanguage = response.language || language;
    const page = unwrapApiData(response.payload)?.page ?? {};
    // The complete entry is rendered once and reused for both response channels.
    const mdx = wikiToMdx(response.payload, { wikiApp: wiki_app, language: effectiveLanguage, sourceUrl: response.url });
    return toolSuccess(mdx, compactObject({
      kind: "wiki",
      format: "mdx",
      wiki_app,
      entry_page_id,
      title: cleanTitle(page.name),
      language: page.lang || effectiveLanguage,
      available_languages: Array.isArray(page.langs) ? page.langs : undefined,
      source_url: response.url,
      human_url: wikiUrl(wiki_app, entry_page_id),
      mdx
    }));
  }));

  server.registerTool("get_hoyowiki_hierarchy", {
    title: "Get HoYoWiki hierarchy",
    description: "Fetch a public HoYoWiki entry and return its numbered 1., 1.1., and 1.1.1. hierarchy. Use the emitted locations such as module[1] or module[1].component[2] with the scoped read tools.",
    inputSchema: {
      wiki_app: WIKI_APP_SCHEMA,
      entry_page_id: ENTRY_ID_SCHEMA,
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ wiki_app, entry_page_id, language }) => {
    const response = await apiClient.getWiki({ wikiApp: wiki_app, entryPageId: entry_page_id, language });
    const effectiveLanguage = response.language || language;
    const hierarchy = wikiHierarchy(response.payload, { wikiApp: wiki_app, language: effectiveLanguage, sourceUrl: response.url });
    return toolSuccess(formatWikiHierarchy(hierarchy), hierarchy);
  }));

  server.registerTool("read_hoyowiki_module", {
    title: "Read HoYoWiki module as MDX",
    description: "Fetch a public HoYoWiki entry and return one numbered module as MDX. The module selector may be a 1-based number, module[1], or an exact module name; call get_hoyowiki_hierarchy first when possible.",
    inputSchema: {
      wiki_app: WIKI_APP_SCHEMA,
      entry_page_id: ENTRY_ID_SCHEMA,
      module: z.string().trim().min(1).describe("Module selector, for example 1, module[1], or an exact module name"),
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ wiki_app, entry_page_id, module, language }) => {
    const response = await apiClient.getWiki({ wikiApp: wiki_app, entryPageId: entry_page_id, language });
    const effectiveLanguage = response.language || language;
    // Scoped reads resolve selectors against the same hierarchy used by the full-entry renderer.
    const mdx = wikiLocationToMdx(response.payload, { wikiApp: wiki_app, language: effectiveLanguage, sourceUrl: response.url }, { module });
    return toolSuccess(mdx, compactObject({
      kind: "wiki",
      format: "mdx",
      scope: "module",
      wiki_app,
      entry_page_id,
      language: effectiveLanguage,
      module_selector: module,
      source_url: response.url,
      human_url: wikiUrl(wiki_app, entry_page_id),
      mdx
    }));
  }));

  server.registerTool("read_hoyowiki_component", {
    title: "Read HoYoWiki component as MDX",
    description: "Fetch a public HoYoWiki entry and return one numbered component as MDX. The module selector accepts a 1-based number, module[1], or exact name; the component selector accepts a 1-based number, component[1], module[1].component[1], component_id, or displayed name.",
    inputSchema: {
      wiki_app: WIKI_APP_SCHEMA,
      entry_page_id: ENTRY_ID_SCHEMA,
      module: z.string().trim().min(1).describe("Parent module selector, for example module[1] or an exact module name"),
      component: z.string().trim().min(1).describe("Component selector, for example component[1], module[1].component[1], component_id, or displayed name"),
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ wiki_app, entry_page_id, module, component, language }) => {
    const response = await apiClient.getWiki({ wikiApp: wiki_app, entryPageId: entry_page_id, language });
    const effectiveLanguage = response.language || language;
    // The parent module is required so a component name or number is unambiguous within the entry.
    const mdx = wikiLocationToMdx(response.payload, { wikiApp: wiki_app, language: effectiveLanguage, sourceUrl: response.url }, { module, component });
    return toolSuccess(mdx, compactObject({
      kind: "wiki",
      format: "mdx",
      scope: "component",
      wiki_app,
      entry_page_id,
      language: effectiveLanguage,
      module_selector: module,
      component_selector: component,
      source_url: response.url,
      human_url: wikiUrl(wiki_app, entry_page_id),
      mdx
    }));
  }));

  server.registerTool("read_hoyolab_replies", {
    title: "Read HoYoLAB article replies",
    description: "Fetch public replies for a HoYoLAB article and convert reply HTML to Markdown blocks.",
    inputSchema: {
      post_id: POST_ID_SCHEMA,
      size: z.number().int().min(1).max(50).default(15),
      page: z.number().int().min(1).max(10000).default(1),
      list_type: z.number().int().min(0).max(10).default(1),
      language: LANGUAGE_SCHEMA
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, withToolErrors(async ({ post_id, size, page, list_type, language }) => {
    const response = await apiClient.getReplies({ postId: post_id, size, page, listType: list_type, language });
    // Reply formatting preserves nesting through depth headings and keeps reply records available to callers.
    const result = formatReplies(response.payload, post_id, response.language || language);
    return toolSuccess(result.text, result.structured);
  }));

  return server;
}

export async function serveHoYoLabMcp({ apiClient } = {}) {
  const server = createHoYoLabMcpServer({ apiClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
