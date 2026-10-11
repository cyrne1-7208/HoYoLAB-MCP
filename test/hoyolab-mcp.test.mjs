import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createHoYoLabClient } from "../src/hoyolab/api.mjs";
import { createHoYoLabMcpServer } from "../src/mcp/hoyolab-server.mjs";

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test("HoYoLAB API client builds observed endpoints and language headers", async () => {
  const calls = [];
  const client = createHoYoLabClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ retcode: 0, data: { page: { id: "49", name: "Raiden Shogun", modules: [] } } });
    }
  });

  await client.getWiki({ wikiApp: "genshin", entryPageId: "49", language: "ja-jp" });

  assert.match(calls[0].url, /\/hoyowiki\/genshin\/wapi\/entry_page\?entry_page_id=49$/);
  assert.equal(calls[0].options.headers["x-rpc-language"], "ja-jp");
  assert.equal(calls[0].options.headers["accept-language"], "ja-jp");
  assert.equal(calls[0].options.headers["x-rpc-wiki_app"], "genshin");

  await client.searchPosts({ keyword: "Genshin", orderType: 2, authorType: 1 });
  const postSearchUrl = new URL(calls[1].url);
  assert.equal(postSearchUrl.searchParams.get("order_type"), "2");
  assert.equal(postSearchUrl.searchParams.get("author_type"), "1");

  await client.searchWiki({ keyword: "Mavuika", orderType: 2, authorType: 2 });
  const wikiSearchUrl = new URL(calls[2].url);
  assert.equal(wikiSearchUrl.searchParams.get("order_type"), "2");
  assert.equal(wikiSearchUrl.searchParams.get("author_type"), "2");

  await client.searchPosts({ keyword: "Genshin", authorType: 3 });
  const unsupportedAuthorUrl = new URL(calls[3].url);
  assert.equal(unsupportedAuthorUrl.searchParams.get("author_type"), "0");

  await client.getArticle({ postId: "123", language: "JA" });
  assert.equal(calls[4].options.headers["x-rpc-language"], "ja-jp");
  assert.equal(calls[4].options.headers["accept-language"], "ja-jp");
  await assert.rejects(() => client.getArticle({ postId: "123", language: "xx-yy" }), /Unsupported language/);
});

test("MCP exposes MDX article and Wiki tools over the protocol", async () => {
  const articlePayload = {
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "123",
          subject: "Example article",
          content: "<h2>Summary</h2><p>Hello Traveler.</p>",
          lang: "ja-jp",
          origin_lang: "en-us",
          is_multi_language: true,
          multi_language_info: { langs: ["en-us", "ja-jp"] }
        },
        user: { nickname: "Author" },
        game: { game_name: "Genshin Impact" }
      }
    }
  };
  const wikiPayload = {
    retcode: 0,
    data: {
      page: {
        id: "49",
        status: 2,
        name: "Raiden Shogun",
        desc: "Her Excellency.",
        modules: [{
          name: "Attributes",
          components: [{
            component_id: "baseInfo",
            data: JSON.stringify({ list: [
              { title: "Summary", desc: "Raiden Shogun" },
              { title: "Details", desc: "Electro Archon" }
            ] })
          }]
        }]
      }
    }
  };
  const repliesPayload = {
    retcode: 0,
    data: {
      is_last: true,
      last_id: "9",
      list: [{
        reply: {
          reply_id: "9",
          lang: "ja-jp",
          content: "Fallback [emoji]",
          struct_content: JSON.stringify([
            { insert: "Structured reply" },
            { insert: { backup: { type: "text", text: "[emoji]" }, emoticon: { url: "https://example.com/emoji.png" } } },
            { insert: "\n" }
          ]),
          created_at: 1700000000
        },
        user: { nickname: "Reply author" },
        sub_replies: [{
          reply: { reply_id: "10", f_reply_id: "9", content: "Nested reply", created_at: 1700000001 },
          user: { nickname: "Nested author" }
        }]
      }]
    }
  };
  const searchCalls = { posts: [], wiki: [] };
  const apiClient = {
    searchPosts: async (options) => {
      searchCalls.posts.push(options);
      return { data: {
      list: [{ post: { post_id: "456", subject: "Search result", content: "Snippet" } }],
      is_last: true
      } };
    },
    searchWiki: async (options) => {
      searchCalls.wiki.push(options);
      return { data: {
      posts: [],
      entry_pages: [{ web_path: "https://wiki.hoyolab.com/pc/genshin/entry/7299", name: "Mavuika", menu_name: "Character Archive", game_name: "Genshin Impact" }],
      is_last: true
      } };
    },
    getArticle: async () => ({ payload: articlePayload, url: "https://bbs-api-os.hoyolab.com/community/post/wapi/getPostFull?post_id=123" }),
    getWiki: async () => ({ payload: wikiPayload, url: "https://sg-act-public-api-static.hoyolab.com/hoyowiki/genshin/wapi/entry_page?entry_page_id=49", language: "ja-jp" }),
    getReplies: async () => ({ payload: repliesPayload })
  };

  const server = createHoYoLabMcpServer({ apiClient });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "search_hoyolab_posts",
      "search_hoyowiki",
      "read_hoyolab_article",
      "read_hoyowiki_entry",
      "get_hoyowiki_hierarchy",
      "read_hoyowiki_module",
      "read_hoyowiki_component",
      "read_hoyolab_replies"
    ]
  );
  for (const toolName of ["search_hoyolab_posts", "search_hoyowiki"]) {
    const tool = listed.tools.find(({ name }) => name === toolName);
    assert.ok(tool);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema.properties.author_type), /3|followed/i);
  }

  const postSearch = await client.callTool({ name: "search_hoyolab_posts", arguments: { keyword: "Search", order_type: 2, author_type: 1 } });
  assert.match(postSearch.content.find((item) => item.type === "text")?.text || "", /post_id: 456/);
  assert.equal(postSearch.structuredContent.results[0].post_id, "456");
  assert.ok(searchCalls.posts[0].signal instanceof AbortSignal);
  const { signal, ...postSearchArguments } = searchCalls.posts[0];
  assert.deepEqual(postSearchArguments, {
    keyword: "Search",
    gameId: undefined,
    page: 1,
    pageSize: 15,
    orderType: 2,
    authorType: 1,
    isAllGame: false,
    scene: "SCENE_GENERAL",
    language: undefined
  });
  assert.deepEqual(postSearch.structuredContent.filters, {
    order_type: 2,
    order: "latest",
    author_type: 1,
    author: "official"
  });

  const wikiSearch = await client.callTool({ name: "search_hoyowiki", arguments: { keyword: "Mavuika", order_type: 2, author_type: 2 } });
  assert.match(wikiSearch.content.find((item) => item.type === "text")?.text || "", /entry_page_id: 7299/);
  assert.equal(wikiSearch.structuredContent.entry_pages[0].entry_page_id, "7299");
  assert.equal(wikiSearch.structuredContent.entry_pages[0].wiki_app, "genshin");
  assert.equal(searchCalls.wiki[0].orderType, 2);
  assert.equal(searchCalls.wiki[0].authorType, 2);
  assert.deepEqual(wikiSearch.structuredContent.filters, {
    order_type: 2,
    order: "latest",
    author_type: 2,
    author: "authenticated"
  });

  const article = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "123" } });
  const articleText = article.content.find((item) => item.type === "text")?.text || "";
  assert.match(articleText, /^---\n/);
  assert.match(articleText, /# Article: Example article/);
  assert.equal(article.structuredContent.format, "mdx");
  assert.match(article.structuredContent.mdx, /# Article: Example article/);
  assert.equal(article.structuredContent.mdx, articleText);
  assert.equal(article.structuredContent.language, "ja-jp");
  assert.equal(article.structuredContent.api_origin_lang, "en-us");
  assert.deepEqual(article.structuredContent.available_languages, ["en-us", "ja-jp"]);

  const wiki = await client.callTool({ name: "read_hoyowiki_entry", arguments: { entry_page_id: "49" } });
  const wikiText = wiki.content.find((item) => item.type === "text")?.text || "";
  assert.match(wikiText, /^---\n/);
  assert.match(wikiText, /# Raiden Shogun/);
  assert.match(wikiText, /## 1\. Attributes/);
  assert.match(wikiText, /### 1\.1\. Base Info/);
  assert.match(wikiText, /#### 1\.1\.1\. /);
  assert.equal(wiki.structuredContent.format, "mdx");
  assert.equal(wiki.structuredContent.mdx, wikiText);

  const hierarchy = await client.callTool({ name: "get_hoyowiki_hierarchy", arguments: { entry_page_id: "49" } });
  const hierarchyText = hierarchy.content.find((item) => item.type === "text")?.text || "";
  assert.match(hierarchyText, /## 1\. Attributes/);
  assert.match(hierarchyText, /### 1\.1\. Base Info/);
  assert.equal(hierarchy.structuredContent.modules[0].number, "1");
  assert.equal(hierarchy.structuredContent.modules[0].components[0].number, "1.1");

  const module = await client.callTool({ name: "read_hoyowiki_module", arguments: { entry_page_id: "49", module: "module[1]" } });
  const moduleText = module.content.find((item) => item.type === "text")?.text || "";
  assert.match(moduleText, /## 1\. Attributes/);
  assert.equal(module.structuredContent.scope, "module");
  assert.equal(module.structuredContent.requested_language, "ja-jp");
  assert.equal(module.structuredContent.actual_language, undefined);
  assert.equal(module.structuredContent.language_status, "unknown");

  const component = await client.callTool({ name: "read_hoyowiki_component", arguments: { entry_page_id: "49", module: "1", component: "component[1]" } });
  const componentText = component.content.find((item) => item.type === "text")?.text || "";
  assert.match(componentText, /### 1\.1\. Base Info/);
  assert.equal(component.structuredContent.scope, "component");
  assert.equal(component.structuredContent.requested_language, "ja-jp");
  assert.equal(component.structuredContent.actual_language, undefined);
  assert.equal(component.structuredContent.mdx, componentText);

  const replies = await client.callTool({ name: "read_hoyolab_replies", arguments: { post_id: "123", size: 2 } });
  const repliesText = replies.content.find((item) => item.type === "text")?.text || "";
  assert.match(repliesText, /## Reply 9 — Reply author/);
  assert.match(repliesText, /### Reply 10 — Nested author/);
  assert.match(repliesText, /Structured reply/);
  assert.match(repliesText, /!\[Emoji\]\(https:\/\/example\.com\/emoji\.png\)/);
  assert.equal(replies.structuredContent.markdown, repliesText);
  assert.equal(replies.structuredContent.replies.length, 2);
  assert.equal(replies.structuredContent.replies[0].body_source, "quill-delta");
  assert.equal(replies.structuredContent.replies[0].language, "ja-jp");
  assert.deepEqual(replies.structuredContent.languages, ["ja-jp"]);

  await client.close();
  await server.close();
});
