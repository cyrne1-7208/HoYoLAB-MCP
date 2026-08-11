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
});

test("MCP exposes MDX article and Wiki tools over the protocol", async () => {
  const articlePayload = {
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "123",
          subject: "Example article",
          content: "<h2>Summary</h2><p>Hello Traveler.</p>"
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
  const apiClient = {
    searchPosts: async () => ({ data: {
      list: [{ post: { post_id: "456", subject: "Search result", content: "Snippet" } }],
      is_last: true
    } }),
    searchWiki: async () => ({ data: {
      posts: [],
      entry_pages: [{ web_path: "https://wiki.hoyolab.com/pc/genshin/entry/7299", name: "Mavuika", menu_name: "Character Archive", game_name: "Genshin Impact" }],
      is_last: true
    } }),
    getArticle: async () => ({ payload: articlePayload, url: "https://bbs-api-os.hoyolab.com/community/post/wapi/getPostFull?post_id=123" }),
    getWiki: async () => ({ payload: wikiPayload, url: "https://sg-act-public-api-static.hoyolab.com/hoyowiki/genshin/wapi/entry_page?entry_page_id=49" }),
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

  const postSearch = await client.callTool({ name: "search_hoyolab_posts", arguments: { keyword: "Search" } });
  assert.match(postSearch.content.find((item) => item.type === "text")?.text || "", /post_id: 456/);
  assert.equal(postSearch.structuredContent.results[0].post_id, "456");

  const wikiSearch = await client.callTool({ name: "search_hoyowiki", arguments: { keyword: "Mavuika" } });
  assert.match(wikiSearch.content.find((item) => item.type === "text")?.text || "", /entry_page_id: 7299/);
  assert.equal(wikiSearch.structuredContent.entry_pages[0].entry_page_id, "7299");
  assert.equal(wikiSearch.structuredContent.entry_pages[0].wiki_app, "genshin");

  const article = await client.callTool({ name: "read_hoyolab_article", arguments: { post_id: "123" } });
  const articleText = article.content.find((item) => item.type === "text")?.text || "";
  assert.match(articleText, /^---\n/);
  assert.match(articleText, /# Article: Example article/);
  assert.equal(article.structuredContent.format, "mdx");
  assert.match(article.structuredContent.mdx, /# Article: Example article/);
  assert.equal(article.structuredContent.mdx, articleText);

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

  const component = await client.callTool({ name: "read_hoyowiki_component", arguments: { entry_page_id: "49", module: "1", component: "component[1]" } });
  const componentText = component.content.find((item) => item.type === "text")?.text || "";
  assert.match(componentText, /### 1\.1\. Base Info/);
  assert.equal(component.structuredContent.scope, "component");
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

  await client.close();
  await server.close();
});
