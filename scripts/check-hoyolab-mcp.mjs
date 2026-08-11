import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "hoyolab-mcp-check", version: "0.1.0" });
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

async function callAndSummarize(name, arguments_, validate, label = name) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = textResult(result);
  if (result.isError) throw new Error(`${name} returned an MCP error: ${text}`);
  validate?.({ text, structured: result.structuredContent || {} });
  return {
    name: label,
    ok: true,
    text_length: text.length,
    starts_with: text.slice(0, 60).replace(/\n/g, "\\n"),
    structured_keys: result.structuredContent ? Object.keys(result.structuredContent) : [],
    structured_body_length: typeof result.structuredContent?.mdx === "string"
      ? result.structuredContent.mdx.length
      : typeof result.structuredContent?.markdown === "string"
        ? result.structuredContent.markdown.length
        : undefined
  };
}

function requireText(text, marker, name) {
  if (!text.includes(marker)) throw new Error(`${name} did not return expected body marker: ${marker}`);
}

function validateMdxResult(kind, label) {
  return ({ text, structured }) => {
    const headingMarker = kind === "article" ? "# Article:" : "\n# ";
    requireText(text, headingMarker, `${label} content`);
    requireText(structured.mdx, headingMarker, `${label} structuredContent`);
    if (structured.mdx !== text) throw new Error(`${label} content and structuredContent.mdx differ`);
    if (kind === "wiki" && /^(?:# Wiki entry:|## \d+\. Module:|### \d+\.\d+\. Component:|#### \d+\.\d+\.\d+\. Item:)/m.test(text)) {
      throw new Error(`${label} retained a redundant hierarchy label`);
    }
  };
}

function validateReplies(label) {
  return ({ text, structured }) => {
    requireText(text, "# Replies:", `${label} content`);
    if (structured.total_count < 1 || !Array.isArray(structured.replies) || structured.replies.length < 1) {
      throw new Error(`${label} returned no structured replies`);
    }
    requireText(structured.markdown, "# Replies:", `${label} structuredContent`);
    if (structured.markdown !== text) throw new Error(`${label} content and structuredContent.markdown differ`);
  };
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const required = [
    "search_hoyolab_posts",
    "search_hoyowiki",
    "read_hoyolab_article",
    "read_hoyowiki_entry",
    "get_hoyowiki_hierarchy",
    "read_hoyowiki_module",
    "read_hoyowiki_component",
    "read_hoyolab_replies"
  ];
  const available = new Set(listed.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Missing MCP tools: ${missing.join(", ")}`);

  const checks = [
    await callAndSummarize("search_hoyolab_posts", { keyword: "Genshin Impact", page_size: 2 }, ({ structured }) => {
      if (!structured.results?.some((result) => /^\d+$/.test(result.post_id || ""))) {
        throw new Error("search_hoyolab_posts returned no usable numeric post_id");
      }
    }, "search_hoyolab_posts:genshin"),
    await callAndSummarize("search_hoyowiki", { keyword: "Mavuika", page_size: 5 }, ({ structured }) => {
      if (!structured.entry_pages?.some((entry) => entry.entry_page_id === "7299" && entry.wiki_app === "genshin")) {
        throw new Error("search_hoyowiki did not derive entry_page_id/wiki_app from web_path");
      }
    }, "search_hoyowiki:mavuika"),
    await callAndSummarize("read_hoyolab_article", { post_id: "45842980", language: "ja-jp" }, ({ text, structured }) => {
      requireText(text, "## Article body", "read_hoyolab_article:45842980:ja-jp content");
      validateMdxResult("article", "read_hoyolab_article:45842980:ja-jp")({ text, structured });
    }, "read_hoyolab_article:45842980:ja-jp"),
    await callAndSummarize("read_hoyolab_article", { post_id: "45842980", language: "en-us" }, ({ text, structured }) => {
      requireText(text, "## Article body", "read_hoyolab_article:45842980:en-us content");
      validateMdxResult("article", "read_hoyolab_article:45842980:en-us")({ text, structured });
    }, "read_hoyolab_article:45842980:en-us"),
    await callAndSummarize("read_hoyolab_article", { post_id: "45996236", language: "ja-jp" }, validateMdxResult("article", "read_hoyolab_article:45996236:ja-jp"), "read_hoyolab_article:45996236:ja-jp"),
    await callAndSummarize("read_hoyolab_article", { post_id: "42626259", language: "ja-jp" }, ({ text, structured }) => {
      validateMdxResult("article", "read_hoyolab_article:42626259:ja-jp")({ text, structured });
      requireText(text, "ウェンティに強化", "read_hoyolab_article:42626259:ja-jp content");
      requireText(text, "![Image](", "read_hoyolab_article:42626259:ja-jp images");
      if (structured.body_source !== "json-content") throw new Error("read_hoyolab_article:42626259 did not identify JSON content");
      if (text.includes('{"describe"') || text.includes('"imgs"')) throw new Error("read_hoyolab_article:42626259 returned raw JSON");
    }, "read_hoyolab_article:42626259:ja-jp"),
    await callAndSummarize("read_hoyolab_article", { post_id: "42429178", language: "ja-jp" }, ({ text, structured }) => {
      validateMdxResult("article", "read_hoyolab_article:42429178:ja-jp")({ text, structured });
      requireText(text, "風神のご加護", "read_hoyolab_article:42429178:ja-jp paragraph");
      requireText(text, "![Image](", "read_hoyolab_article:42429178:ja-jp images");
      if (structured.body_source !== "json-content") throw new Error("read_hoyolab_article:42429178 did not identify JSON content");
    }, "read_hoyolab_article:42429178:ja-jp"),
    await callAndSummarize("read_hoyolab_article", { post_id: "42594600", language: "ja-jp" }, ({ text, structured }) => {
      validateMdxResult("article", "read_hoyolab_article:42594600:ja-jp")({ text, structured });
      requireText(text, "[Video](https://www.youtube.com/embed/XCf4uWwDKco)", "read_hoyolab_article:42594600:ja-jp video");
      if (structured.body_source !== "json-content") throw new Error("read_hoyolab_article:42594600 did not identify JSON content");
    }, "read_hoyolab_article:42594600:ja-jp"),
    await callAndSummarize("read_hoyolab_article", { post_id: "46080271", language: "ja-jp" }, ({ text, structured }) => {
      validateMdxResult("article", "read_hoyolab_article:46080271:ja-jp")({ text, structured });
      requireText(text, "七聖召喚", "read_hoyolab_article:46080271:ja-jp paragraph");
      requireText(text, "![Image](", "read_hoyolab_article:46080271:ja-jp images");
    }, "read_hoyolab_article:46080271:ja-jp"),
    await callAndSummarize("read_hoyowiki_entry", { wiki_app: "genshin", entry_page_id: "49", language: "ja-jp" }, validateMdxResult("wiki", "read_hoyowiki_entry:49:ja-jp"), "read_hoyowiki_entry:49:ja-jp"),
    await callAndSummarize("read_hoyowiki_entry", { wiki_app: "genshin", entry_page_id: "7299", language: "en-us" }, validateMdxResult("wiki", "read_hoyowiki_entry:7299:en-us"), "read_hoyowiki_entry:7299:en-us"),
    await callAndSummarize("get_hoyowiki_hierarchy", { wiki_app: "genshin", entry_page_id: "49", language: "ja-jp" }),
    await callAndSummarize("read_hoyowiki_module", { wiki_app: "genshin", entry_page_id: "49", module: "module[1]", language: "ja-jp" }, ({ text, structured }) => {
      requireText(text, "## 1. ", "read_hoyowiki_module:49:ja-jp content");
      requireText(structured.mdx, "## 1. ", "read_hoyowiki_module:49:ja-jp structuredContent");
    }, "read_hoyowiki_module:49:ja-jp"),
    await callAndSummarize("read_hoyowiki_component", { wiki_app: "genshin", entry_page_id: "7299", module: "module[1]", component: "module[1].component[1]", language: "en-us" }, ({ text, structured }) => {
      requireText(text, "### 1.1. ", "read_hoyowiki_component:7299:en-us content");
      requireText(structured.mdx, "### 1.1. ", "read_hoyowiki_component:7299:en-us structuredContent");
    }, "read_hoyowiki_component:7299:en-us"),
    await callAndSummarize("read_hoyolab_replies", { post_id: "45996236", size: 5, language: "ja-jp" }, validateReplies("read_hoyolab_replies:45996236:ja-jp"), "read_hoyolab_replies:45996236:ja-jp"),
    await callAndSummarize("read_hoyolab_replies", { post_id: "45709254", size: 5, language: "ja-jp" }, validateReplies("read_hoyolab_replies:45709254:ja-jp"), "read_hoyolab_replies:45709254:ja-jp")
  ];

  console.log(JSON.stringify({
    ok: true,
    tools: listed.tools.map((tool) => tool.name),
    checks
  }, null, 2));
} finally {
  await client.close().catch(() => {});
}
