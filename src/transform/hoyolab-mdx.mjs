import YAML from "yaml";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { HoYoLabApiError } from "../hoyolab/api.mjs";
import { openingFence, isClosingFence, escapeMarkdownText, markdownLink } from "./markdown-syntax.mjs";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined"
});

turndown.use(gfm);
turndown.addRule("hoyolabSafeLink", {
  filter: "a",
  replacement: (content, node) => {
    const url = safeUrl(node.getAttribute("href"));
    return url ? markdownLink(content || url, url, { formattedLabel: Boolean(content) }) : content;
  }
});
turndown.addRule("hoyolabSafeImage", {
  filter: "img",
  replacement: (_content, node) => {
    const url = safeUrl(node.getAttribute("src"));
    const label = node.getAttribute("alt") || node.getAttribute("title") || "Image";
    return url ? markdownLink(label, url, { image: true }) : escapeMarkdownText(label);
  }
});
turndown.addRule("hoyolabIframe", {
  filter: "iframe",
  replacement: (_content, node) => {
    const url = safeUrl(node.getAttribute("src"));
    return url ? `\n${markdownLink("Video", url)}\n` : "";
  }
});
turndown.addRule("hoyolabTable", {
  filter: "table",
  replacement: (_content, node) => htmlTableToMarkdown(node)
});
turndown.remove(["script", "style", "noscript", "template", "object", "embed", "svg"]);

const INTERNAL_KEYS = /^(id|uid|suid|post_id|game_id|component_id|layout|style|origin_module_id|is_poped|is_customize_name|is_abstract|is_show_switch|switch|repeated|is_submodule|without_border|can_delete|is_hidden|rich_text_editing)$/i;
const HTML_VALUE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*|\/?\s*)>/i;
const LOCALE_PLACEHOLDERS = new Set(["zh-cn", "zh-tw", "de-de", "en-us", "es-es", "fr-fr", "id-id", "it-it", "ja-jp", "ko-kr", "pt-pt", "ru-ru", "th-th", "tr-tr", "vi-vn"]);
const MAX_CONTENT_DEPTH = 64;
const MAX_CONTENT_NODES = 50000;

// Keep transport metadata in frontmatter while rendering only fields that describe the readable document.

function isObject(value) {
  return value !== null && typeof value === "object";
}

function assertContentComplexity(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (++nodes > MAX_CONTENT_NODES || depth > MAX_CONTENT_DEPTH) throw new HoYoLabApiError("Structured content exceeds the depth or node processing limit", { code: "DOCUMENT_TOO_COMPLEX" });
    if (isObject(current)) for (const item of Object.values(current)) stack.push([item, depth + 1]);
  }
}

function conversionWarning(options, code, path, message) {
  const warning = { code, path: path || options.sourcePath || "body", message };
  if (options.warnings && options.warnings.length < 128 && !options.warnings.some((item) => item.code === code && item.path === warning.path)) options.warnings.push(warning);
}

// Recover readable values from new upstream widgets without treating their text as server instructions.
function fallbackContent(value, options = {}, depth = 0) {
  if (depth > MAX_CONTENT_DEPTH) throw new HoYoLabApiError("Fallback content exceeds the depth processing limit", { code: "DOCUMENT_TOO_COMPLEX" });
  if (value == null) return "";
  if (typeof value === "string") return htmlToMarkdown(value, options);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => fallbackContent(item, options, depth + 1)).filter(Boolean).join("\n\n");
  if (!isObject(value)) return "";
  return Object.entries(value).filter(([key]) => !INTERNAL_KEYS.test(key) && !/^(type|kind|block_type)$/i.test(key))
    .map(([key, item]) => {
      const text = fallbackContent(item, options, depth + 1);
      return text ? `**${humanizeKey(key)}:** ${text}` : "";
    }).filter(Boolean).join("\n\n");
}

function compactMetadata(metadata) {
  const compacted = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );
  // Retained metadata also reaches YAML and revision hashing; bound it before either recursive serializer runs.
  assertContentComplexity(compacted);
  return compacted;
}

function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const date = new Date(number * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function frontmatter(metadata) {
  return "---\n" + YAML.stringify(compactMetadata(metadata), { lineWidth: 0 }).trimEnd() + "\n---";
}

function indentBlock(value, prefix = "  ") {
  return String(value).split("\n").map((line) => prefix + line).join("\n");
}

export function cleanMarkdown(value) {
  return mapMarkdownProse(String(value ?? "").replace(/\r\n?/g, "\n"), (text) => text
    .replace(/\u00a0/g, " ")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")).trim();
}

// Keep literal code out of prose cleanup, heading numbering and hierarchy extraction.
function mapMarkdownProse(value, transform) {
  const result = [];
  let pending = [];
  let fenced;
  const flush = () => { if (pending.length) { result.push(transform(pending.join("\n"))); pending = []; } };
  for (const line of String(value ?? "").split("\n")) {
    const mark = !fenced && openingFence(line);
    if (mark || fenced) {
      flush(); result.push(line);
      if (mark) fenced = mark;
      else if (isClosingFence(line, fenced)) fenced = undefined;
    } else pending.push(line);
  }
  flush();
  return result.join("\n");
}

function stripResidualHtml(value) {
  const strip = (text) => text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*|\/?\s*)>/gi, "");
  return mapMarkdownProse(value, (text) => {
    let output = "";
    let start = 0;
    for (const match of text.matchAll(/(?<![\\`])(`+)([\s\S]*?)\1(?!`)/g)) {
      output += strip(text.slice(start, match.index)) + match[0];
      start = match.index + match[0].length;
    }
    return output + strip(text.slice(start));
  });
}

function scopedHeading(title, context = {}) {
  const value = String(title ?? "").trim();
  if (!value) return "";
  return context.ownerPath ? `${context.ownerPath} > ${value}` : value;
}

function hierarchyItemNumber(context = {}, itemIndex = context.itemIndex) {
  if (context.numberItems === false) return "";
  const indexes = [context.moduleIndex, context.componentIndex, itemIndex];
  return indexes.every((value) => Number.isInteger(value) && value > 0) ? indexes.join(".") : "";
}

function hierarchyItemPrefix(context = {}, itemIndex) {
  const number = hierarchyItemNumber(context, itemIndex);
  // The number already identifies the structural depth, so display headings do not repeat type labels.
  return number ? `${number}. ` : "";
}

function numberedItemHeading(title, context = {}) {
  const heading = scopedHeading(title, context);
  if (!heading) return "";
  return `#### ${hierarchyItemPrefix(context)}${heading}`;
}

function numberMarkdownItems(value, context = {}) {
  if (!hierarchyItemNumber(context, 1)) return value;
  let itemIndex = 0;
  return mapMarkdownProse(value, (text) => text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, title) => {
    itemIndex += 1;
    return `${hashes} ${hierarchyItemPrefix(context, itemIndex)}${title.trim()}`;
  }));
}

function markdownHeadings(value) {
  const titles = [];
  mapMarkdownProse(value, (text) => { for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) titles.push(match[1].trim()); return text; });
  return titles;
}

function nestArticleBody(value) {
  return mapMarkdownProse(value, (text) => text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, title) => {
      const level = Math.min(6, hashes.length + 1);
      const label = hashes.length <= 2 ? "Section" : "Subsection";
      return `${"#".repeat(level)} ${label}: ${title.trim()}`;
    }));
}

function nestWikiBody(value, ownerLevel) {
  let minimum = 7;
  mapMarkdownProse(value, (text) => {
    for (const match of text.matchAll(/^(#{1,6})\s+/gm)) minimum = Math.min(minimum, match[1].length);
    return text;
  });
  const offset = Math.max(0, ownerLevel + 1 - minimum);
  if (!offset) return value;
  // Embedded headings belong to their source owner even when the upstream HTML starts at h1/h2.
  return mapMarkdownProse(value, (text) => text.replace(/^(#{1,6})(\s+)/gm,
    (_match, hashes, space) => "#".repeat(Math.min(6, hashes.length + offset)) + space));
}

export function safeUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlAttribute(attributes, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = String(attributes ?? "").match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function normalizeEmbeddedHtml(value, options = {}) {
  // Replace HoYoLAB custom elements with ordinary links and media before the HTML-to-Markdown conversion.
  let source = String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?hoyolab>/gi, "")
    .replace(/\s+(?:on\w+|style)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");

  source = source.replace(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>/gi, (_match, attributes) => {
    const url = safeUrl(htmlAttribute(attributes, "src"));
    return url ? `<p><a href="${escapeHtmlAttribute(url)}">Video</a></p>` : "";
  });

  source = source.replace(/<custom-image\b([^>]*)>(?:[\s\S]*?<\/custom-image>)?/gi, (_match, attributes) => {
    const url = safeUrl(htmlAttribute(attributes, "url"));
    return url ? `<p><img src="${escapeHtmlAttribute(url)}" alt="Image"></p>` : "";
  });

  source = source.replace(/<custom-entry\b([^>]*)>(?:[\s\S]*?<\/custom-entry>)?/gi, (_match, attributes) => {
    const id = htmlAttribute(attributes, "epid");
    const name = htmlAttribute(attributes, "name") || (id ? `Wiki entry ${id}` : "Wiki entry");
    const wikiUrl = options.wikiApp && id ? wikiSourceUrl(options.wikiApp, id) : "";
    const href = wikiUrl || safeUrl(htmlAttribute(attributes, "url"));
    return href
      ? `<p><a href="${escapeHtmlAttribute(href)}">${escapeHtmlAttribute(name)}</a></p>`
      : `<p>${escapeHtmlAttribute(name)}</p>`;
  });

  source = source.replace(/<custom-post\b([^>]*)>(?:[\s\S]*?<\/custom-post>)?/gi, (_match, attributes) => {
    const id = htmlAttribute(attributes, "posts") || htmlAttribute(attributes, "post_id");
    const href = id ? articleSourceUrl(id) : "";
    return href
      ? `<p><a href="${escapeHtmlAttribute(href)}">HoYoLAB article ${escapeHtmlAttribute(id)}</a></p>`
      : "";
  });

  // The HTML representation has no poll payload in the vote-app placeholder, so Delta remains authoritative for poll details.
  source = source.replace(
    /<div\b[^>]*class\s*=\s*["'][^"']*\bmhy-ql-vote\b[^"']*["'][^>]*>\s*<div\b[^>]*class\s*=\s*["'][^"']*\bvote-app\b[^"']*["'][^>]*>\s*<\/div>\s*<\/div>/gi,
    "<p><strong>Poll</strong></p>"
  );
  source = source.replace(/<div\b[^>]*class\s*=\s*["'][^"']*\bql-divider\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "<hr>");

  return source;
}

export function htmlToMarkdown(value, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  const source = normalizeEmbeddedHtml(value, options);
  try {
    return cleanMarkdown(stripResidualHtml(turndown.turndown(source)));
  } catch {
    return cleanMarkdown(stripResidualHtml(source));
  }
}

export function cleanTitle(value) {
  const source = String(value ?? "")
    .replace(/<\/?hoyolab>/gi, "")
    .trim();
  const converted = HTML_VALUE.test(source) ? htmlToMarkdown(source) : source;
  return converted.replace(/\s+/g, " ").trim() || "Untitled HoYoLAB document";
}

function parseMaybeJson(value) {
  let parsed = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try { parsed = JSON.parse(text); } catch { return value; }
  }
  assertContentComplexity(parsed);
  return parsed;
}

function humanizeKey(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function markdownCell(value) {
  const text = stripResidualHtml(cleanMarkdown(value).replace(/<br\s*\/?>/gi, "\n"));
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " / ") || " ";
}

function renderMarkdownTable(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0) return "";
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  const header = [...headers, ...Array(Math.max(0, width - headers.length)).fill("")];
  const separator = Array(width).fill("---");
  const normalizedRows = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  return [
    "| " + header.map(markdownCell).join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...normalizedRows.map((row) => "| " + row.map(markdownCell).join(" | ") + " |")
  ].join("\n");
}

function articleTextValue(value, options = {}) {
  // Article text can be plain text or embedded HTML, and both forms should preserve paragraph boundaries.
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    return HTML_VALUE.test(text) ? htmlToMarkdown(text, options) : cleanMarkdown(text);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function tableCellValue(value, options = {}, path = "table.cell") {
  if (!isObject(value)) return articleTextValue(value, options);
  conversionWarning(options, "UNSUPPORTED_TABLE_CELL", path, "A structured cell was retained as readable fallback text.");
  return fallbackContent(value, options);
}

function articleTableExtras(value, handled, options, path) {
  return Object.entries(value).filter(([key]) => !handled.has(key) && !INTERNAL_KEYS.test(key) && !/^(type|kind|block_type)$/i.test(key))
    .map(([key, item]) => {
      const text = fallbackContent(item, options);
      if (!text) return "";
      conversionWarning(options, "UNRECOGNIZED_TABLE_FIELD", `${options.sourcePath || "table"}.${path}.${key}`, "Additional table information was retained with its source owner.");
      return `**${path} — ${humanizeKey(key)}:** ${text}`;
    }).filter(Boolean);
}

function articleMediaUrl(value) {
  if (typeof value === "string") return safeUrl(value);
  if (!isObject(value)) return "";
  return safeUrl(value.url || value.image_url || value.img_url || value.src || value.image || value.img || value.video);
}

function articleMediaMarkdown(value, kind = "image", options = {}) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const url = articleMediaUrl(item);
    if (!url) {
      const text = isObject(item) ? fallbackContent(item, options) : "";
      if (text) conversionWarning(options, "UNSUPPORTED_MEDIA_ITEM", options.sourcePath, "Media without a usable URL was retained as readable fallback text.");
      return text;
    }
    const handled = new Set();
    if (isObject(item)) for (const key of ["url", "image_url", "img_url", "src", "image", "img", "video"]) {
      if (safeUrl(item[key]) === url) handled.add(key);
    }
    const titleValues = isObject(item) ? ["alt", "name", "title", "description"].map((key) => ({ key, text: articleTextValue(item[key], options) })) : [];
    const title = titleValues.find((value) => value.text)?.text || (kind === "video" ? "Video" : "Image");
    for (const value of titleValues) if (value.text === title) handled.add(value.key);
    const link = markdownLink(title, url, { image: kind !== "video" });
    const extras = isObject(item) ? Object.entries(item).filter(([key]) => !handled.has(key) && !INTERNAL_KEYS.test(key))
      .map(([key, value]) => {
        const text = fallbackContent(value, options);
        if (!text) return "";
        conversionWarning(options, "UNRECOGNIZED_MEDIA_FIELD", `${options.sourcePath || "media"}.${key}`, "Additional media information was retained beside its source reference.");
        return `**${humanizeKey(key)}:** ${text}`;
      }).filter(Boolean) : [];
    return [link, ...extras].join("\n\n");
  }).filter(Boolean).join("\n\n");
}

function tableColumnName(value, index, options = {}) {
  if (isObject(value)) {
    return articleTextValue(value.label || value.name || value.title || value.key || value.id, options)
      || `Column ${index + 1}`;
  }
  return articleTextValue(value, options) || `Column ${index + 1}`;
}

function tableColumnKey(value, index) {
  if (isObject(value)) return value.key || value.name || value.id || value.label || value.title || index;
  return value;
}

function articleTableMarkdown(value, options = {}) {
  // Convert only explicit header-and-row objects so arbitrary JSON metadata is never presented as a table.
  const table = parseMaybeJson(value);
  if (!isObject(table) || Array.isArray(table)) return "";

  const headerValues = table.headers || table.header || table.columns;
  const rowValues = table.rows || table.body || table.data || table.items;
  if (!Array.isArray(headerValues) || !Array.isArray(rowValues) || headerValues.length < 1) return "";

  const headers = headerValues.map((header, index) => tableColumnName(header, index, options));
  const columns = headerValues.map((header, index) => tableColumnKey(header, index));
  const extras = [];
  const rows = rowValues.map((row, rowIndex) => {
    const rowPath = `Row ${rowIndex + 1}`;
    if (Array.isArray(row)) return row.map((cell, index) => tableCellValue(cell, options, `${options.sourcePath || "table"}.${rowPath}.cell[${index + 1}]`));
    if (!isObject(row)) return [articleTextValue(row, options)];
    const handled = new Set();
    const cells = columns.map((column, index) => {
      const key = [String(column), String(index)].find((key) => row[key] != null);
      if (key !== undefined) handled.add(key);
      return tableCellValue(key === undefined ? undefined : row[key], options, `${options.sourcePath || "table"}.${rowPath}.cell[${index + 1}]`);
    });
    extras.push(...articleTableExtras(row, handled, options, rowPath));
    return cells;
  });

  if (!headers.every(Boolean)) return "";
  const headerKey = ["headers", "header", "columns"].find((key) => table[key]);
  const rowKey = ["rows", "body", "data", "items"].find((key) => table[key]);
  for (const [index, header] of headerValues.entries()) if (isObject(header)) extras.push(...articleTableExtras(header, new Set(["label", "name", "title", "key", "id"]), options, `Column ${index + 1}`));
  extras.push(...articleTableExtras(table, new Set([headerKey, rowKey]), options, "Table"));
  return [renderMarkdownTable(headers, rows), ...extras].join("\n\n");
}

function articleTablesMarkdown(value, options = {}, path = "body.table") {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, index) => {
    const parsed = parseMaybeJson(item);
    if (parsed == null || parsed === "") return "";
    const location = Array.isArray(value) ? `${path}[${index + 1}]` : path;
    const table = articleTableMarkdown(parsed, { ...options, sourcePath: location });
    if (table) return table;
    conversionWarning(options, "UNSUPPORTED_ARTICLE_TABLE", location, "A structured table could not be rendered as rows; readable values were retained as fallback text.");
    return fallbackContent(parsed, options);
  }).filter(Boolean).join("\n\n");
}

function renderArticleJsonBlock(value, options = {}) {
  const block = parseMaybeJson(value);
  if (block === undefined || block === null || block === "") return "";
  if (typeof block === "string" || typeof block === "number" || typeof block === "boolean") {
    return articleTextValue(block, options);
  }
  if (Array.isArray(block)) {
    return block.map((item) => renderArticleJsonBlock(item, options)).filter(Boolean).join("\n\n");
  }
  if (!isObject(block)) return "";

  const type = String(block.type || block.kind || block.block_type || "").toLocaleLowerCase();
  const parts = [];
  const handled = new Set(["type", "kind", "block_type"]);
  const add = (value) => { if (value && !parts.includes(value)) parts.push(value); };
  if (type.includes("table") || block.table !== undefined) {
    const source = block.table || block;
    const table = articleTableMarkdown(source, options);
    if (table) {
      add(table);
      if (source === block) {
        for (const key of Object.keys(block)) handled.add(key);
      } else handled.add("table");
    }
  }
  if (type.includes("image") || type === "img") {
    const image = articleMediaMarkdown(block.image || block.img || block.url || block.src || block, "image", options);
    if (image) { add(image); for (const key of ["image", "img", "url", "src"]) handled.add(key); }
  }
  if (type.includes("video")) {
    const video = articleMediaMarkdown(block.video || block.url || block.src || block, "video", options);
    if (video) { add(video); for (const key of ["video", "url", "src"]) handled.add(key); }
  }

  for (const key of ["text", "describe", "description", "html", "value"]) {
    if (block[key] !== undefined && !handled.has(key)) {
      const text = isObject(block[key]) ? fallbackContent(block[key], options) : articleTextValue(block[key], options);
      if (isObject(block[key])) conversionWarning(options, "UNSUPPORTED_ARTICLE_BLOCK", `${options.sourcePath || "body"}.${key}`, "Structured text was retained as fallback content.");
      add(text); handled.add(key);
    }
  }
  for (const key of ["content", "children", "blocks", "sections", "paragraphs"]) {
    if (block[key] !== undefined && !handled.has(key)) {
      const nested = renderArticleJsonBlock(block[key], options);
      add(nested); handled.add(key);
    }
  }
  for (const key of ["table", "tables", "data_table"]) {
    if (block[key] !== undefined && !handled.has(key)) {
      const table = articleTablesMarkdown(block[key], options, `${options.sourcePath || "body"}.${key}`);
      if (table) { add(table); handled.add(key); }
    }
  }
  for (const key of ["image", "img", "images", "imgs", "gallery"]) {
    if (block[key] !== undefined && !handled.has(key)) {
      const image = articleMediaMarkdown(block[key], "image", options);
      if (image) { add(image); handled.add(key); }
    }
  }
  for (const key of ["video", "videos"]) {
    if (block[key] !== undefined && !handled.has(key)) {
      const video = articleMediaMarkdown(block[key], "video", options);
      if (video) { add(video); handled.add(key); }
    }
  }
  for (const [key, value] of Object.entries(block)) {
    if (handled.has(key) || INTERNAL_KEYS.test(key)) continue;
    const text = fallbackContent(value, options);
    if (!text) continue;
    conversionWarning(options, "UNSUPPORTED_ARTICLE_BLOCK", `${options.sourcePath || type || "body"}.${key}`, "An article block used fallback text extraction; its original presentation may be incomplete.");
    add(`**${humanizeKey(key)}:** ${text}`);
  }
  return parts.join("\n\n");
}

function articleJsonToMarkdown(value, options = {}) {
  // Legacy article bodies store readable text and media under describe, imgs, and video keys instead of HTML.
  const parsed = parseMaybeJson(value);
  if (!isObject(parsed)) return "";
  if (deltaOps(parsed)) return "";

  if (Array.isArray(parsed)) return cleanMarkdown(renderArticleJsonBlock(parsed, options));

  const parts = [];
  for (const key of ["describe", "description", "body", "text", "html"]) {
    if (parsed[key] !== undefined) {
      const text = renderArticleJsonBlock(parsed[key], options);
      if (text) parts.push(text);
    }
  }
  for (const key of ["content", "blocks", "sections", "paragraphs"]) {
    if (parsed[key] !== undefined) {
      const nested = renderArticleJsonBlock(parsed[key], options);
      if (nested) parts.push(nested);
    }
  }
  for (const key of ["table", "tables", "data_table"]) {
    if (parsed[key] !== undefined) {
      const table = articleTablesMarkdown(parsed[key], options, `${options.sourcePath || "body"}.${key}`);
      if (table) parts.push(table);
    }
  }
  for (const key of ["image", "img", "images", "imgs", "gallery"]) {
    if (parsed[key] !== undefined) {
      const image = articleMediaMarkdown(parsed[key], "image", options);
      if (image) parts.push(image);
    }
  }
  for (const key of ["video", "videos"]) {
    if (parsed[key] !== undefined) {
      const video = articleMediaMarkdown(parsed[key], "video", options);
      if (video) parts.push(video);
    }
  }

  const known = new Set(["describe", "description", "body", "text", "html", "content", "blocks", "sections", "paragraphs", "table", "tables", "data_table", "image", "img", "images", "imgs", "gallery", "video", "videos", "type", "kind", "block_type"]);
  // Delta is decoded separately; do not render its protocol fields as ordinary article text.
  if (!parts.length && deltaOps(parsed)) return "";
  for (const [key, value] of Object.entries(parsed)) {
    if (known.has(key) || INTERNAL_KEYS.test(key)) continue;
    const recovered = fallbackContent(value, options);
    if (!recovered) continue;
    conversionWarning(options, "UNRECOGNIZED_ARTICLE_FIELD", key, "An additional article field used generic text extraction.");
    parts.push(`**${humanizeKey(key)}:** ${recovered}`);
  }

  return cleanMarkdown(parts.join("\n\n"));
}

function htmlTableToMarkdown(node) {
  const captionNode = Array.from(node.children).find((child) => child.tagName === "CAPTION");
  const caption = captionNode ? stripResidualHtml(cleanMarkdown(turndown.turndown(captionNode.innerHTML))) : "";
  const prefix = caption ? `\n**Caption:** ${caption}\n\n` : "\n";
  const rows = Array.from(node.querySelectorAll("tr"))
    .filter((row) => row.closest("table") === node)
    .map((row) => {
      const cells = Array.from(row.children).filter((cell) => /^(TD|TH)$/i.test(cell.tagName));
      const values = [];
      const cellInfo = [];
      let hasSpan = false;
      for (const cell of cells) {
        const value = stripResidualHtml(cleanMarkdown(turndown.turndown(cell.innerHTML)));
        values.push(value);
        const colspan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") || "1", 10) || 1);
        const rowspan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") || "1", 10) || 1);
        if (colspan > 1 || rowspan > 1) hasSpan = true;
        cellInfo.push({
          isHeader: /^TH$/i.test(cell.tagName),
          inHeader: /^THEAD$/i.test(row.parentElement?.tagName || ""),
          isBold: Boolean(cell.querySelector("strong, b")),
          hasMedia: Boolean(cell.querySelector("img, video, iframe, custom-image, custom-entry, custom-post")),
          text: cleanMarkdown(cell.textContent || "").replace(/\s+/g, " ")
        });
        for (let index = 1; index < colspan; index += 1) values.push("");
      }
      return {
        values,
        cellInfo,
        hasSpan
      };
    })
    .filter((row) => row.values.length > 0);

  if (!rows.length) return caption ? prefix : "";

  const values = rows.map((row) => row.values);
  const width = Math.max(...values.map((row) => row.length));
  const normalized = values.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  const firstRow = rows[0];
  const hasExplicitHeader = firstRow.cellInfo.length > 0
    && firstRow.cellInfo.every((cell) => cell.isHeader || cell.inHeader);
  const hasInferredHeader = firstRow.cellInfo.length === width
    && firstRow.cellInfo.every((cell) => cell.isBold && !cell.hasMedia && cell.text.length > 0 && cell.text.length <= 80);
  const isRectangular = width >= 2
    && rows.length >= 2
    && normalized.every((row) => row.length === width)
    && rows.every((row) => !row.hasSpan);
  const headers = firstRow.cellInfo.map((cell) => cell.text);
  const useTable = isRectangular
    && headers.every(Boolean)
    && (hasExplicitHeader || hasInferredHeader);

  if (!useTable) {
    const blocks = rows
      .map((row) => row.values.filter(Boolean).join("\n\n"))
      .filter(Boolean);
    return blocks.length ? `${prefix}${blocks.join("\n\n")}\n` : prefix;
  }

  normalized.shift();

  return `${prefix}${renderMarkdownTable(headers, normalized)}\n`;
}

function parseEmbeddedItem(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\$([\s\S]+)\$$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function renderEmbeddedItems(value, context = {}) {
  const items = parseEmbeddedItem(value);
  if (!items) return "";
  return items.map((item) => {
    if (!isObject(item)) return String(item);
    const id = item.ep_id ?? item.entry_page_id;
    const label = inlineValue(item.nickname || item.name || (id ? `Wiki entry ${id}` : "Wiki item"), context);
    const url = id && context.wikiApp ? wikiSourceUrl(context.wikiApp, id) : safeUrl(item.url);
    const amount = item.amount !== undefined && item.amount !== null && Number(item.amount) > 0
      ? ` ×${item.amount}`
      : "";
    return url ? `${markdownLink(label, url)}${amount}` : `${label}${amount}`;
  }).filter(Boolean).join(", ");
}

function inlineValue(value, context = {}) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    const embedded = renderEmbeddedItems(value, context);
    if (embedded) return embedded;
    const text = HTML_VALUE.test(value) ? htmlToMarkdown(value, context) : cleanMarkdown(value);
    return text.replace(/[ \t]+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function collapseComponentData(value) {
  let current = parseMaybeJson(value);
  for (let index = 0; index < 4; index += 1) {
    if (!isObject(current) || Array.isArray(current) || Object.keys(current).length !== 1 || !Object.hasOwn(current, "data")) break;
    current = parseMaybeJson(current.data);
  }
  return current;
}

function compactValue(value, context = {}) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((item) => !isObject(item))) {
      return value.map((item) => inlineValue(item, context)).filter(Boolean).join(", ");
    }
    return renderStructured(value, context);
  }
  if (isObject(value)) return renderStructured(value, context);
  return inlineValue(value, context);
}

function wikiItemExtras(item, handled, context = {}) {
  return Object.entries(item).filter(([key]) => !handled.has(key) && !INTERNAL_KEYS.test(key))
    .map(([key, value]) => {
      const text = compactValue(value, context);
      if (!text) return "";
      conversionWarning(context, "UNRECOGNIZED_ITEM_FIELD", `${context.sourcePath || "item"}.${key}`, "An additional Wiki field was retained using generic rendering.");
      return `- **${humanizeKey(key)}:** ${text.replace(/\n/g, "\n  ")}`;
    }).filter(Boolean).join("\n");
}

function renderKeyValueList(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (!list.every((item) => isObject(item) && Object.hasOwn(item, "key") && Object.hasOwn(item, "value"))) return "";
  return list.map((item, index) => {
    const key = inlineValue(item.key, context) || "Value";
    const value = compactValue(item.value, context);
    const extras = wikiItemExtras(item, new Set(["key", "value"]), { ...context, sourcePath: `${context.sourcePath || "list"}[${index + 1}]` });
    if (!value && !extras) return "";
    const prefix = hierarchyItemPrefix(context, index + 1);
    const line = value.includes("\n") ? `- ${prefix}**${key}:**\n${indentBlock(value)}` : `- ${prefix}**${key}:** ${value}`;
    return line + (extras ? `\n${indentBlock(extras)}` : "");
  }).filter(Boolean).join("\n");
}

function renderImageList(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (!list.every((item) => isObject(item) && Object.hasOwn(item, "key") && Object.hasOwn(item, "img"))) return "";
  return list.map((item, index) => {
    const key = inlineValue(item.key, context) || "Image";
    const url = safeUrl(item.img);
    const image = url ? markdownLink(key, url, { image: true }) : "";
    const description = inlineValue(item.imgDesc, context);
    const fallback = !url ? compactValue(item.img, { ...context, numberItems: false }) : "";
    if (!url) conversionWarning(context, "UNSUPPORTED_MEDIA_URL", `${context.sourcePath || "list"}[${index + 1}].img`, "An image has no usable HTTP/HTTPS URL; readable image data was retained.");
    const detail = [image, description, fallback].filter(Boolean).join(" — ");
    const extras = wikiItemExtras(item, new Set(["key", "img", "imgDesc"]), context);
    return `- ${hierarchyItemPrefix(context, index + 1)}**${key}:** ${detail || "Unavailable"}` + (extras ? `\n${indentBlock(extras)}` : "");
  }).join("\n");
}

function renderValuesTable(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const rows = list.filter((item) => isObject(item) && Array.isArray(item.values));
  if (rows.length === 0) return "";
  const cell = (value) => {
    if (!isObject(value)) return inlineValue(value, context);
    conversionWarning(context, "UNSUPPORTED_TABLE_CELL", context.sourcePath || "wiki.table", "A structured Wiki cell was retained as fallback text.");
    return compactValue(value, context);
  };
  const firstValues = rows[0].values.map(cell);
  const headers = [rows[0].key ? inlineValue(rows[0].key, context) : "Field", ...firstValues];
  const dataRows = rows.slice(1).map((item) => [
    inlineValue(item.key, context),
    ...item.values.map(cell)
  ]);
  const extras = rows.map((item, index) => {
    const text = wikiItemExtras(item, new Set(["key", "values"]), context);
    return text ? `**${index === 0 ? "Column headings" : `Row ${index}`}**\n\n${text}` : "";
  }).filter(Boolean);
  return [renderMarkdownTable(headers, dataRows), ...extras].join("\n\n");
}

function renderMaterials(materials, context = {}) {
  if (!Array.isArray(materials) || materials.length === 0) return "";
  const values = materials.flatMap((value) => {
    const embedded = renderEmbeddedItems(value, context);
    const text = embedded || compactValue(value, context);
    return text ? [text] : [];
  });
  return values.length ? `- **Materials:** ${values.join(", ")}` : "";
}

function renderDescriptiveItem(item, context = {}) {
  if (!isObject(item)) return inlineValue(item, context);
  const lines = [];
  const handled = new Set();
  const nestedContext = { ...context, numberItems: false };
  // Consume only the alias actually rendered; different values in other aliases remain readable extra fields.
  const choose = (keys, render) => {
    const values = keys.map((key) => ({ key, text: render(item[key]) }));
    const chosen = values.find((value) => value.text);
    if (!chosen) return "";
    for (const value of values) if (value.text === chosen.text) handled.add(value.key);
    return chosen.text;
  };
  const heading = choose(["title", "name", "key", "position"], (value) => inlineValue(value, nestedContext));
  const image = choose(["img", "icon_url", "image"], safeUrl);
  if (image) lines.push(markdownLink(heading || "Image", image, { image: true }));

  const description = choose(["desc", "description", "imgDesc"], (value) => compactValue(value, nestedContext));
  if (description) lines.push(description);

  if (Array.isArray(item.attributes)) {
    const table = renderList(item.attributes, nestedContext);
    if (table) lines.push(table);
    handled.add("attributes");
  }
  if (Array.isArray(item.combatList)) {
    const table = renderList(item.combatList, nestedContext);
    if (table) lines.push(table);
    handled.add("combatList");
  }
  if (Array.isArray(item.materials)) {
    const materials = renderMaterials(item.materials, nestedContext);
    if (materials) lines.push(materials);
    handled.add("materials");
  }
  for (const [key, label] of [["videos", "Video"], ["audios", "Audio"]]) {
    if (Array.isArray(item[key])) {
      const media = renderWikiMediaList(item[key], label, nestedContext);
      if (media) lines.push(media);
      handled.add(key);
    }
  }
  const extras = wikiItemExtras(item, handled, nestedContext);
  if (extras) lines.push(extras);
  const body = lines.join("\n\n");
  return [heading ? numberedItemHeading(heading, context) : "", nestWikiBody(body, heading ? 4 : 3)].filter(Boolean).join("\n\n");
}

function renderWikiMediaList(list, label, context) {
  return list.map((media, index) => {
    const location = { ...context, sourcePath: `${context.sourcePath || "item"}.${label.toLowerCase()}[${index + 1}]` };
    if (!isObject(media) || Array.isArray(media)) {
      const text = compactValue(media, location);
      if (text) conversionWarning(location, "UNSUPPORTED_MEDIA_ITEM", location.sourcePath, "Unexpected media data was retained as readable text.");
      return text ? `- **${label}:** ${text}` : "";
    }
    const url = safeUrl(media.url);
    const labelKey = label === "Audio" ? ["name", "title"] : ["title", "name"];
    const titleKey = labelKey.find((key) => inlineValue(media[key], location));
    const title = titleKey ? inlineValue(media[titleKey], location) : label;
    const handled = new Set(["url"]);
    for (const key of labelKey) if (inlineValue(media[key], location) === title) handled.add(key);
    const duration = inlineValue(media.duration, location);
    if (duration) handled.add("duration");
    if (!url) conversionWarning(location, "UNSUPPORTED_MEDIA_URL", `${location.sourcePath}.url`, "A media reference has no usable HTTP/HTTPS URL; its label and notes were retained.");
    const link = url ? markdownLink(title, url) : `**${title}:** Unavailable`;
    const extras = wikiItemExtras(media, handled, location);
    return `- ${link}${duration ? ` (${duration}s)` : ""}` + (extras ? `\n${indentBlock(extras)}` : "");
  }).filter(Boolean).join("\n");
}

function renderList(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const keyValues = renderKeyValueList(list, context);
  if (keyValues) return keyValues;
  const images = renderImageList(list, context);
  if (images) return images;

  if (list.every((item) => isObject(item) && Object.hasOwn(item, "key") && Array.isArray(item.combatList))) {
    return list.map((item, index) => {
      const title = inlineValue(item.key, context) || "Level";
      const nestedContext = { ...context, numberItems: false };
      const table = renderList(item.combatList, nestedContext);
      const materials = renderMaterials(item.materials, nestedContext);
      const handled = new Set(["key", "combatList"]);
      if (Array.isArray(item.materials)) handled.add("materials");
      const extras = wikiItemExtras(item, handled, nestedContext);
      return [numberedItemHeading(title, { ...context, itemIndex: index + 1 }), nestWikiBody([table, materials, extras].filter(Boolean).join("\n\n"), 4)].filter(Boolean).join("\n\n");
    }).join("\n\n");
  }

  if (list.every((item) => isObject(item) && Array.isArray(item.values))) return renderValuesTable(list, context);
  if (list.some((item) => isObject(item) && Array.isArray(item.values))) {
    conversionWarning(context, "UNSUPPORTED_MIXED_WIKI_LIST", context.sourcePath || "wiki.list", "A mixed table-and-description list was retained item by item instead of discarding non-table items.");
    return list.map((item, index) => renderDescriptiveItem(item, { ...context, itemIndex: index + 1 })).filter(Boolean).join("\n\n");
  }

  if (list.some((item) => isObject(item) && Array.isArray(item.videos))) {
    return list.map((item, index) => renderDescriptiveItem(item, { ...context, itemIndex: index + 1 })).filter(Boolean).join("\n\n");
  }
  if (list.some((item) => isObject(item) && Array.isArray(item.audios))) {
    return list.map((item, index) => renderDescriptiveItem(item, { ...context, itemIndex: index + 1 })).filter(Boolean).join("\n\n");
  }
  if (list.some((item) => isObject(item) && (item.title !== undefined || item.name !== undefined || item.desc !== undefined))) {
    return list.map((item, index) => renderDescriptiveItem(item, { ...context, itemIndex: index + 1 })).filter(Boolean).join("\n\n");
  }

  return list.map((item, index) => {
    const rendered = compactValue(item, context);
    return rendered ? `- ${hierarchyItemPrefix(context, index + 1)}${rendered.replace(/\n/g, "\n  ")}` : "";
  }).filter(Boolean).join("\n");
}

function renderStructured(value, context = {}) {
  const current = collapseComponentData(value);
  if (current === undefined || current === null || current === "") return "";
  if (typeof current === "string") return numberMarkdownItems(inlineValue(current, context), context);
  if (!isObject(current)) return inlineValue(current, context);

  if (Array.isArray(current)) return renderList(current, context);

  const lines = [];
  const handled = new Set();
  if (typeof current.pic === "string") {
    const url = safeUrl(current.pic);
    if (url) { lines.push(markdownLink("Gallery", url, { image: true })); handled.add("pic"); }
  }

  if (Array.isArray(current.list)) {
    const listContent = renderList(current.list, context);
    if (listContent) lines.push(listContent);
    handled.add("list");
  }

  if (isObject(current.artifact_list) && !Array.isArray(current.artifact_list)) {
    for (const [index, [key, item]] of Object.entries(current.artifact_list).entries()) {
      const rendered = isObject(item) && !Array.isArray(item)
        ? renderDescriptiveItem({ ...item, position: item.position || humanizeKey(key) }, { ...context, itemIndex: index + 1 })
        : wikiItemExtras({ [key]: item }, new Set(), context);
      if (rendered) lines.push(rendered);
    }
    handled.add("artifact_list");
  }

  if (typeof current.data === "string" && current.data.trim()) {
    const rendered = numberMarkdownItems(htmlToMarkdown(current.data, context), context);
    if (rendered) lines.push(rendered);
    handled.add("data");
  }

  for (const [key, nested] of Object.entries(current)) {
    if (handled.has(key) || INTERNAL_KEYS.test(key)) continue;
    const rendered = compactValue(nested, context);
    if (!rendered) continue;
    if (["list", "pic", "artifact_list", "data"].includes(key)) conversionWarning(context, "UNSUPPORTED_WIKI_FIELD", `${context.sourcePath || "component"}.${key}`, "An unexpected Wiki field shape was retained as readable text.");
    const label = humanizeKey(key);
    if (rendered.includes("\n")) lines.push(`- **${label}:**\n${indentBlock(rendered)}`);
    else lines.push(`- **${label}:** ${rendered}`);
  }

  return lines.filter(Boolean).join("\n");
}

function formatInlineDeltaText(value, attributes = {}) {
  let text = String(value ?? "").replace(/\u200b/g, "");
  if (!text) return "";
  const link = safeUrl(attributes.link);
  if (link) text = escapeMarkdownText(text);

  if (attributes.code) text = `\`${text.replace(/`/g, "\\`")}\``;
  if (attributes.bold) text = `**${text}**`;
  if (attributes.italic) text = `*${text}*`;
  if (attributes.underline) text = `<u>${text}</u>`;
  if (attributes.strike) text = `~~${text}~~`;

  return link ? markdownLink(text, link, { formattedLabel: true }) : text;
}

function deltaListKind(value) {
  if (!value) return "";
  if (value === "ordered" || value === "number") return "ordered";
  if (value === "bullet" || value === "checked" || value === "unchecked") return "bullet";
  return "";
}

function renderVote(vote) {
  if (!isObject(vote)) return "**Poll**";
  const title = inlineValue(vote.title) || "Untitled poll";
  const lines = [`**Poll:** ${title}`];
  const options = Array.isArray(vote.vote_options) ? vote.vote_options : (Array.isArray(vote.options) ? vote.options : []);
  for (const option of options) {
    const label = isObject(option) ? (option.title || option.name || option.text || option.option) : option;
    if (label) lines.push(`- ${inlineValue(label)}`);
  }
  if (vote.vote_limit !== undefined) lines.push(`- **Vote limit:** ${vote.vote_limit}`);
  if (vote.end_time !== undefined) lines.push(`- **Deadline:** ${epochToIso(vote.end_time) || vote.end_time}`);
  if (vote.status) lines.push(`- **Status:** ${humanizeKey(String(vote.status).replace(/^VoteStatus/i, ""))}`);

  const results = vote.vote_results || vote.results;
  if (Array.isArray(results)) {
    for (const result of results) {
      const label = result?.title || result?.name || result?.option || result?.text;
      const count = result?.count ?? result?.vote_count ?? result?.votes;
      if (label && count !== undefined) lines.push(`- ${inlineValue(label)}: ${count}`);
    }
  }
  return lines.join("\n");
}

function renderCardGroup(group) {
  const cards = Array.isArray(group?.article_cards)
    ? group.article_cards
    : (Array.isArray(group?.cards) ? group.cards : []);
  if (!cards.length) return "**Related articles**";
  const lines = ["**Related articles**"];
  for (const card of cards) {
    const meta = card?.meta || {};
    const info = card?.info || card || {};
    const id = meta.meta_id || info.post_id || info.id;
    const title = cleanTitle(info.title || info.subject || (id ? `Article ${id}` : "Article"));
    const url = safeUrl(info.jump_url) || safeUrl(meta.origin_url) || articleSourceUrl(id);
    const author = inlineValue(card?.user?.nickname);
    const views = info.view_num ? ` · ${info.view_num} views` : "";
    const suffix = [author, views.replace(/^ · /, "")].filter(Boolean).join(" · ");
    const detail = suffix ? ` — ${suffix}` : "";
    lines.push(url ? `- ${markdownLink(title, url)}${detail}` : `- ${title}${detail}`);
  }
  return lines.join("\n");
}

function deltaMediaMarkdown(value, kind, options) {
  if (Array.isArray(value)) return value.map((item) => deltaMediaMarkdown(item, kind, options)).filter(Boolean).join("\n\n");
  const media = isObject(value) ? { ...value } : { url: value };
  const notes = [];
  // Image captions are often stored on the Delta operation, not inside insert.image. Layout attributes are not caption text.
  for (const key of ["alt", "name", "title", "description", "caption", "transcript", "text"]) {
    const attribute = options.deltaAttributes?.[key];
    const text = articleTextValue(attribute, options);
    if (!text) continue;
    const existing = articleTextValue(media[key], options);
    if (!existing) media[key] = attribute;
    else if (existing !== text) {
      notes.push(`**${humanizeKey(key)} (operation):** ${text}`);
      conversionWarning(options, "UNRECOGNIZED_MEDIA_FIELD", `${options.sourcePath || "delta"}.attributes.${key}`, "Distinct media information on the Delta operation was retained beside the embedded reference.");
    }
  }
  return [articleMediaMarkdown(media, kind, options), ...notes].filter(Boolean).join("\n\n");
}

function renderDeltaEmbed(insert, options = {}) {
  if (!isObject(insert)) return "";
  if (insert.type === "ContentTypeText" && insert.text !== undefined) {
    return inlineValue(insert.text);
  }
  if (insert.emoticon) {
    const url = safeUrl(insert.emoticon.url || insert.emoticon.image || insert.emoticon.src);
    if (url) return markdownLink("Emoji", url, { image: true });
    return inlineValue(insert.backup?.text || insert.text);
  }
  if (insert.emoji) {
    const url = safeUrl(insert.emoji.url || insert.emoji.image || insert.emoji.src);
    if (url) return markdownLink("Emoji", url, { image: true });
    return inlineValue(insert.emoji.text || insert.backup?.text || insert.text);
  }
  if (insert.mention) {
    const mention = isObject(insert.mention)
      ? (insert.mention.nickname || insert.mention.name || insert.mention.text || insert.mention.uid)
      : insert.mention;
    return mention ? `@${inlineValue(mention)}` : "";
  }
  if (insert.backup?.text !== undefined) return inlineValue(insert.backup.text);
  if (insert.image) {
    return deltaMediaMarkdown(insert.image, "image", options);
  }
  if (insert.video) {
    return deltaMediaMarkdown(insert.video, "video", options);
  }
  if (insert.divider !== undefined) return "---";
  if (insert.vote) return renderVote(insert.vote);
  if (insert.card_group) return renderCardGroup(insert.card_group);

  const [key, value] = Object.entries(insert)[0] || [];
  if (!key) return "";
  const url = isObject(value) ? safeUrl(value.url || value.src) : safeUrl(value);
  const label = humanizeKey(key);
  conversionWarning(options, "UNSUPPORTED_DELTA_EMBED", options.sourcePath || key, "An unrecognized embedded block was retained where possible; presentation may be incomplete.");
  return url ? markdownLink(label, url) : fallbackContent(insert, options);
}

function isInlineDeltaEmbed(insert) {
  return isObject(insert) && (
    insert.type === "ContentTypeText" ||
    insert.emoticon !== undefined ||
    insert.emoji !== undefined ||
    insert.mention !== undefined ||
    insert.backup !== undefined
  );
}

function deltaOps(value) {
  // Delta payloads may be arrays, {ops}, or row containers depending on the endpoint and language variant.
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed) && parsed.some((op) => isObject(op) && Object.hasOwn(op, "insert"))) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.ops)) return parsed.ops;
  if (isObject(parsed) && Array.isArray(parsed.rows)) return deltaOps(parsed.rows);
  if (Array.isArray(parsed)) {
    const flattened = [];
    for (const row of parsed) {
      if (isObject(row) && Object.hasOwn(row, "insert")) flattened.push(row);
      else if (isObject(row) && Array.isArray(row.ops)) flattened.push(...row.ops);
      else if (isObject(row) && row.content !== undefined) {
        const nested = deltaOps(row.content);
        if (nested) flattened.push(...nested);
      }
    }
    return flattened.some((op) => Object.hasOwn(op, "insert")) ? flattened : null;
  }
  return null;
}

function meaningfulDelta(ops) {
  return Array.isArray(ops) && ops.some((op) => {
    if (!isObject(op) || !Object.hasOwn(op, "insert")) return false;
    if (typeof op.insert === "string") return op.insert.trim().length > 0;
    return isObject(op.insert) && Object.keys(op.insert).length > 0;
  });
}

export function quillDeltaToMarkdown(value, options = {}) {
  const ops = deltaOps(value);
  if (!meaningfulDelta(ops)) return "";

  const lines = [];
  let segments = [];
  let plainSegments = [];
  let codeLines = [];
  let codeLanguage = "";
  let listKind = "";
  let listIndex = 0;
  let pendingBlockAttributes = {};

  const flushCode = () => {
    if (!codeLines.length) return;
    const text = codeLines.join("\n");
    const length = Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1));
    const marker = "`".repeat(length);
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`${marker}${codeLanguage}`, ...codeLines, marker, "");
    codeLines = [];
    listKind = ""; listIndex = 0;
  };

  const finishLine = (attributes = {}) => {
    const code = attributes["code-block"] ?? attributes.codeBlock;
    if (code) {
      const language = typeof code === "string" && /^[a-z0-9_+-]{1,30}$/i.test(code) ? code : "";
      if (codeLines.length && language !== codeLanguage) flushCode();
      codeLanguage = language;
      codeLines.push(plainSegments.join(""));
      segments = []; plainSegments = [];
      return;
    }
    flushCode();
    let text = segments.join("").trimEnd();
    const header = Number(attributes.header);
    if (Number.isInteger(header) && header >= 1 && header <= 6 && text) {
      text = `${"#".repeat(header)} ${text}`;
    }

    const currentList = deltaListKind(attributes.list);
    if (currentList) {
      if (currentList !== listKind) listIndex = 0;
      listKind = currentList;
      listIndex += 1;
      const indent = Number.isInteger(Number(attributes.indent)) ? "  ".repeat(Math.max(0, Number(attributes.indent))) : "";
      text = `${indent}${currentList === "ordered" ? `${listIndex}.` : "-"} ${text}`.trimEnd();
    } else {
      listKind = "";
      listIndex = 0;
    }

    lines.push(text);
    segments = []; plainSegments = [];
  };

  const addBlock = (block) => {
    if (!block) return;
    if (segments.length) finishLine(pendingBlockAttributes);
    flushCode();
    pendingBlockAttributes = {};
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...String(block).split("\n"));
    lines.push("");
    listKind = "";
    listIndex = 0;
  };

  for (const [opIndex, op] of ops.entries()) {
    const attributes = isObject(op.attributes) ? op.attributes : {};
    if (typeof op.insert === "string") {
      const parts = op.insert.split("\n");
      const hasBlockAttributes = ["header", "list", "indent", "code-block", "codeBlock"].some((key) => Object.hasOwn(attributes, key));
      parts.forEach((part, index) => {
        if (part) { segments.push(formatInlineDeltaText(part, attributes)); plainSegments.push(part); }
        if (index < parts.length - 1) {
          finishLine({ ...pendingBlockAttributes, ...attributes });
          pendingBlockAttributes = {};
        }
      });
      if (parts.length === 1 && hasBlockAttributes) pendingBlockAttributes = { ...pendingBlockAttributes, ...attributes };
      continue;
    }
    if (isInlineDeltaEmbed(op.insert)) {
      const rendered = renderDeltaEmbed(op.insert, { ...options, deltaAttributes: attributes, sourcePath: `${options.sourcePath || "delta"}.ops[${opIndex}]` });
      if (rendered) { segments.push(rendered); plainSegments.push(rendered); }
      continue;
    }
    addBlock(renderDeltaEmbed(op.insert, { ...options, deltaAttributes: attributes, sourcePath: `${options.sourcePath || "delta"}.ops[${opIndex}]` }));
  }

  if (segments.length) finishLine(pendingBlockAttributes);
  flushCode();
  return cleanMarkdown(lines.join("\n"));
}

function articleSourceUrl(postId, sourceUrl) {
  if (sourceUrl && !/\/community\/post\/wapi\//i.test(sourceUrl)) return sourceUrl;
  return postId ? `https://www.hoyolab.com/article/${postId}` : undefined;
}

function wikiSourceUrl(wikiApp, entryId, sourceUrl) {
  if (sourceUrl && !/\/hoyowiki\/[^/]+\/wapi\//i.test(sourceUrl)) return sourceUrl;
  return wikiApp && entryId ? `https://wiki.hoyolab.com/pc/${wikiApp}/entry/${entryId}` : undefined;
}

function inferWikiApp(sourceUrl) {
  if (typeof sourceUrl !== "string") return undefined;
  const match = sourceUrl.match(/\/hoyowiki\/([^/]+)\//) || sourceUrl.match(/\/pc\/([^/]+)\/entry\//);
  return match?.[1];
}

export function unwrapApiData(payload) {
  if (isObject(payload) && isObject(payload.data) && (Object.hasOwn(payload, "retcode") || Object.hasOwn(payload, "message"))) {
    return payload.data;
  }
  return payload;
}

export function detectKind(payload) {
  const data = unwrapApiData(payload);
  if (isObject(data?.page) && Array.isArray(data.page.modules)) return "wiki";
  if (isObject(data?.post?.post) && (data.post.post.content !== undefined || data.post.post.structured_content !== undefined || data.post.post.post_id !== undefined)) return "article";
  if (isObject(data?.post) && (data.post.content !== undefined || data.post.structured_content !== undefined || data.post.post_id !== undefined)) return "article";
  throw new Error("Unsupported HoYoLAB payload: expected an article post or Wiki page response.");
}

function isReadableArticleHtml(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  // Only observed full locale codes are placeholders; short words and media-only HTML are real bodies.
  return !LOCALE_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function hasMarkdownTable(value) {
  return /^\|[^\n]*\|\s*\n\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|/m.test(String(value ?? ""));
}

function markdownTextLength(value) {
  return cleanMarkdown(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|-]/g, "")
    .replace(/\s/g, "")
    .length;
}

function shouldPreferArticleHtml(source, htmlBody, structuredBody) {
  if (!htmlBody || !structuredBody) return false;
  if (/<table\b/i.test(String(source ?? "")) && !hasMarkdownTable(structuredBody)) return true;

  const htmlTextLength = markdownTextLength(htmlBody);
  const structuredTextLength = markdownTextLength(structuredBody);
  if (structuredTextLength === 0 && htmlTextLength > 0) return true;
  return htmlTextLength >= 160 && htmlTextLength > structuredTextLength * 1.35;
}

export function richTextToMarkdown({ content, desc, structuredContent, structuredRows } = {}, options = {}) {
  // Prefer a complete structured body, then recover missing paragraphs or tables from the HTML representation.
  const jsonContent = articleJsonToMarkdown(content, options);
  if (jsonContent) return { body: jsonContent, source: "json-content" };

  const contentIsJsonObject = isObject(parseMaybeJson(content));
  const htmlContent = !contentIsJsonObject && isReadableArticleHtml(content)
    ? htmlToMarkdown(content, options)
    : "";

  const structured = deltaOps(structuredContent);
  if (meaningfulDelta(structured)) {
    const body = quillDeltaToMarkdown(structured, options);
    if (body) {
      if (shouldPreferArticleHtml(content, htmlContent, body)) return { body: htmlContent, source: "html" };
      return { body, source: "quill-delta" };
    }
  }

  const contentDelta = deltaOps(content);
  if (meaningfulDelta(contentDelta)) {
    const body = quillDeltaToMarkdown(contentDelta, options);
    if (body) {
      if (shouldPreferArticleHtml(content, htmlContent, body)) return { body: htmlContent, source: "html" };
      return { body, source: "quill-delta-content" };
    }
  }

  if (htmlContent) return { body: htmlContent, source: "html" };

  const rows = deltaOps(structuredRows);
  if (meaningfulDelta(rows)) {
    const body = quillDeltaToMarkdown(rows, options);
    if (body) return { body, source: "quill-delta-rows" };
  }

  const jsonDesc = articleJsonToMarkdown(desc, options);
  if (jsonDesc) return { body: jsonDesc, source: "json-desc" };

  if (isReadableArticleHtml(desc)) {
    const body = htmlToMarkdown(desc, options);
    if (body) return { body, source: "html-desc" };
  }
  return { body: "", source: "none" };
}

function articleBody(post, options = {}) {
  return richTextToMarkdown({
    content: post.content,
    desc: post.desc,
    structuredContent: post.structured_content,
    structuredRows: post.structured_content_rows
  }, options);
}

function wikiPageInfo(payload, options = {}) {
  const data = unwrapApiData(payload);
  const page = data?.page ?? data;
  const wikiApp = options.wikiApp || inferWikiApp(options.sourceUrl) || "unknown";
  const entryId = page?.id === undefined ? undefined : String(page.id);
  return { data, page, wikiApp, entryId, context: { wikiApp } };
}

function wikiModuleTitle(module, index) {
  return cleanTitle(module?.name || `Section ${index}`);
}

function wikiComponentTitle(component) {
  return humanizeKey(component?.component_id || "subsection");
}

function hierarchyItemLabel(item, index, context) {
  if (isObject(item)) {
    const label = inlineValue(item.title || item.name || item.key || item.position, context);
    return label || `Item ${index}`;
  }
  return inlineValue(item, context) || `Item ${index}`;
}

function hierarchyItems(component, context) {
  const current = collapseComponentData(component?.data);
  if (Array.isArray(current)) {
    return current.map((item, index) => hierarchyItemLabel(item, index + 1, context));
  }
  if (!isObject(current)) {
    if (typeof current === "string") {
      return markdownHeadings(htmlToMarkdown(current, context));
    }
    return [];
  }
  if (Array.isArray(current.list)) {
    return current.list.map((item, index) => hierarchyItemLabel(item, index + 1, context));
  }
  if (isObject(current.artifact_list)) {
    return Object.entries(current.artifact_list).map(([key, item], index) => hierarchyItemLabel({ ...item, position: item?.position || humanizeKey(key) }, index + 1, context));
  }
  if (typeof current.data === "string" && current.data.trim()) {
    return markdownHeadings(htmlToMarkdown(current.data, context));
  }
  return [];
}

export function wikiHierarchy(payload, options = {}) {
  // Structured hierarchy fields retain API locations while labels stay compact for model-facing output.
  const { page, wikiApp, entryId, context } = wikiPageInfo(payload, options);
  const modules = (page?.modules || []).map((module, moduleIndex) => {
    const moduleNumber = moduleIndex + 1;
    const moduleTitle = wikiModuleTitle(module, moduleNumber);
    const components = (module.components || []).map((component, componentIndex) => {
      const componentNumber = componentIndex + 1;
      const componentTitle = wikiComponentTitle(component);
      const componentContext = {
        ...context,
        moduleIndex: moduleNumber,
        componentIndex: componentNumber,
        componentId: component.component_id,
        ownerPath: `${moduleTitle} > ${componentTitle}`
      };
      const items = hierarchyItems(component, componentContext);
      return {
        component_index: componentNumber,
        number: `${moduleNumber}.${componentNumber}`,
        label: `${moduleNumber}.${componentNumber}. ${componentTitle}`,
        component_id: component.component_id || "",
        name: componentTitle,
        location: `module[${moduleNumber}].component[${componentNumber}]`,
        items: items.map((title, itemIndex) => ({
          item_index: itemIndex + 1,
          number: `${moduleNumber}.${componentNumber}.${itemIndex + 1}`,
          label: `${moduleNumber}.${componentNumber}.${itemIndex + 1}. ${title}`,
          title,
          location: `module[${moduleNumber}].component[${componentNumber}].item[${itemIndex + 1}]`
        })),
        has_content: Boolean(renderStructured(collapseComponentData(component.data), componentContext))
      };
    });
    return {
      module_index: moduleNumber,
      number: String(moduleNumber),
      label: `${moduleNumber}. ${moduleTitle}`,
      name: moduleTitle,
      location: `module[${moduleNumber}]`,
      components
    };
  });
  return {
    schema: "hoyolab.wiki-hierarchy.v1",
    source: "HoYoWiki",
    kind: "wiki-hierarchy",
    wiki_app: wikiApp,
    entry_page_id: entryId,
    title: cleanTitle(page?.name),
    language: page?.lang,
    requested_language: options.language,
    actual_language: page?.lang,
    source_url: wikiSourceUrl(wikiApp, entryId, options.sourceUrl),
    modules
  };
}

function selectorValue(selector, label) {
  const value = String(selector ?? "").trim();
  if (!value) throw new Error(`${label} selector is required`);
  return value;
}

export function resolveWikiModule(page, selector) {
  // Accept numeric, path-based, and name-based selectors so callers can use hierarchy output or human labels.
  const value = selectorValue(selector, "module");
  const modules = page?.modules || [];
  const indexSelector = value.match(/^(?:module\[(\d+)\]|(\d+))$/i);
  if (indexSelector) {
    const index = Number(indexSelector[1] || indexSelector[2]) - 1;
    if (modules[index]) return { module: modules[index], index };
  }
  const normalized = value.toLocaleLowerCase();
  const index = modules.findIndex((module) => wikiModuleTitle(module, 0).toLocaleLowerCase() === normalized || String(module?.name || "").toLocaleLowerCase() === normalized);
  if (index >= 0) return { module: modules[index], index };
  const available = modules.map((module, index) => `${index + 1}:${wikiModuleTitle(module, index + 1)}`).join(", ");
  throw new Error(`Unknown module selector '${value}'. Available modules: ${available || "none"}`);
}

export function resolveWikiComponent(module, selector, expectedModuleIndex) {
  const value = selectorValue(selector, "component");
  const components = module?.components || [];
  const pathSelector = value.match(/^module\[(\d+)\]\.component\[(\d+)\]$/i);
  const indexSelector = value.match(/^component\[(\d+)\]$/i) || value.match(/^(\d+)$/);
  if (pathSelector && expectedModuleIndex !== undefined && Number(pathSelector[1]) !== expectedModuleIndex) {
    throw new Error(`Component selector '${value}' does not belong to module[${expectedModuleIndex}]`);
  }
  const componentIndex = pathSelector ? Number(pathSelector[2]) : indexSelector ? Number(indexSelector[1]) : undefined;
  if (componentIndex !== undefined) {
    const index = componentIndex - 1;
    if (components[index]) return { component: components[index], index };
  }
  const normalized = value.toLocaleLowerCase();
  const index = components.findIndex((component) => (
    String(component?.component_id || "").toLocaleLowerCase() === normalized
    || wikiComponentTitle(component).toLocaleLowerCase() === normalized
  ));
  if (index >= 0) return { component: components[index], index };
  const available = components.map((component, index) => `${index + 1}:${component?.component_id || wikiComponentTitle(component)}`).join(", ");
  throw new Error(`Unknown component selector '${value}'. Available components: ${available || "none"}`);
}

function wikiMetadata(page, wikiApp, entryId, options = {}) {
  return {
    schema: "hoyolab.wiki.v2",
    source: "HoYoWiki",
    kind: "wiki",
    wiki_app: wikiApp,
    entry_page_id: entryId,
    title: cleanTitle(page?.name),
    menu: page?.menu_name,
    status: page?.status,
    version: page?.version,
    language: page?.lang,
    requested_language: options.language,
    actual_language: page?.lang,
    icon_url: safeUrl(page?.icon_url),
    header_img_url: safeUrl(page?.header_img_url),
    source_url: wikiSourceUrl(wikiApp, entryId, options.sourceUrl),
    body_format: "structured-markdown"
  };
}

// These adapters preserve the existing rich-text renderers while exposing a shared document input.
// Each section carries its upstream location; the document layer assigns bounded, revision-scoped blocks.
export function articleDocumentParts(payload, options = {}) {
  const data = unwrapApiData(payload);
  const bundle = isObject(data?.post?.post) ? data.post : data;
  const post = bundle?.post ?? {};
  const warnings = [];
  const body = articleBody(post, { ...options, warnings, sourcePath: "post.body" });
  if (body.source.endsWith("desc")) warnings.push({ code: "DESCRIPTION_FALLBACK", path: "post.desc", message: "Only the description fallback was readable; a complete article body could not be confirmed." });
  const title = cleanTitle(post.subject || post.title);
  return {
    metadata: compactMetadata({
      schema: "hoyolab.article.v3", source: "HoYoLAB", kind: "article", post_id: String(post.post_id), title,
      game_id: post.game_id, game: bundle?.game?.game_name, author: bundle?.user?.nickname,
      created_at: epochToIso(post.created_at), updated_at: epochToIso(post.last_modify_time),
      language: post.lang, api_origin_lang: post.origin_lang, is_multilingual: post.is_multi_language,
      available_languages: post.multi_language_info?.langs, source_url: articleSourceUrl(post.post_id),
      body_source: body.source, body_format: "markdown"
    }),
    sections: [{ level: 1, title: `Article: ${title}`, location: "post" },
      { level: 2, title: "Article body", location: "post.body", markdown: nestArticleBody(body.body) }],
    warnings, hasBody: Boolean(body.body), bodySource: body.source
  };
}

export function wikiDocumentParts(payload, options = {}) {
  const { page, wikiApp, entryId, context } = wikiPageInfo(payload, options);
  const warnings = [];
  const intro = [];
  const header = safeUrl(page.header_img_url);
  if (header) intro.push(markdownLink("Header", header, { image: true }));
  if (page.desc) intro.push(nestWikiBody(htmlToMarkdown(page.desc, options), 1));
  const sections = [{ level: 1, title: cleanTitle(page.name), location: "page", markdown: intro.filter(Boolean).join("\n\n") }];
  for (const [moduleIndex, module] of page.modules.entries()) {
    const moduleNumber = moduleIndex + 1;
    const moduleTitle = wikiModuleTitle(module, moduleNumber);
    sections.push({ level: 2, title: `${moduleNumber}. ${moduleTitle}`, location: `module[${moduleNumber}]` });
    for (const [componentIndex, component] of (module.components || []).entries()) {
      const componentNumber = componentIndex + 1;
      const componentTitle = wikiComponentTitle(component);
      const location = `module[${moduleNumber}].component[${componentNumber}]`;
      const markdown = renderStructured(collapseComponentData(component.data), {
        ...context, warnings, sourcePath: `${location}.data`, moduleIndex: moduleNumber, componentIndex: componentNumber,
        componentId: component.component_id, ownerPath: `${moduleTitle} > ${componentTitle}`
      });
      sections.push({ level: 3, title: `${moduleNumber}.${componentNumber}. ${componentTitle}`, location,
        component_id: component.component_id, markdown: nestWikiBody(markdown, 3) });
    }
  }
  const { status: upstreamStatus, ...metadata } = wikiMetadata(page, wikiApp, entryId, options);
  return { metadata: compactMetadata({ ...metadata, upstream_status: upstreamStatus, schema: "hoyolab.wiki.v3", language: page.lang,
    available_languages: page.langs, source_url: wikiSourceUrl(wikiApp, entryId), updated_at: epochToIso(page.last_modify_time ?? page.updated_at) }),
    sections, warnings, hasBody: sections.some((section) => Boolean(section.markdown)), bodySource: "wiki-structured" };
}

export function wikiLocationToMdx(payload, options = {}, selectors = {}) {
  // Scoped reads reuse the full-entry numbering scheme so locations remain stable across tools.
  const { page, wikiApp, entryId, context } = wikiPageInfo(payload, options);
  const moduleResult = resolveWikiModule(page, selectors.module);
  const moduleNumber = moduleResult.index + 1;
  const moduleTitle = wikiModuleTitle(moduleResult.module, moduleNumber);
  const componentResults = selectors.component === undefined || selectors.component === null
    ? (moduleResult.module.components || []).map((component, index) => ({ component, index }))
    : [resolveWikiComponent(moduleResult.module, selectors.component, moduleNumber)];
  const componentBlocks = componentResults.map(({ component, index }) => {
    const componentNumber = index + 1;
    const componentTitle = wikiComponentTitle(component);
    const componentContext = {
      ...context,
      moduleIndex: moduleNumber,
      componentIndex: componentNumber,
      componentId: component.component_id,
      ownerPath: `${moduleTitle} > ${componentTitle}`
    };
    const rendered = renderStructured(collapseComponentData(component.data), componentContext);
    return `### ${moduleNumber}.${componentNumber}. ${componentTitle}\n\n${nestWikiBody(rendered, 3) || "> No readable structured content was returned."}`;
  });
  const sections = [
    frontmatter(wikiMetadata(page, wikiApp, entryId, options)),
    `# ${cleanTitle(page?.name)}`,
    `## ${moduleNumber}. ${moduleTitle}`,
    ...componentBlocks
  ];
  return sections.join("\n\n").trim() + "\n";
}

export function articleToMdx(payload, options = {}) {
  const data = unwrapApiData(payload);
  const bundle = isObject(data?.post?.post) ? data.post : data;
  const post = bundle?.post ?? {};
  const user = bundle?.user ?? {};
  const game = bundle?.game ?? {};
  const postId = post.post_id === undefined ? undefined : String(post.post_id);
  const title = cleanTitle(post.subject || post.title);
  const bodyResult = articleBody(post, options);
  const metadata = {
    schema: "hoyolab.article.v2",
    source: "HoYoLAB",
    kind: "article",
    post_id: postId,
    title,
    game_id: post.game_id,
    game: game.game_name,
    author: user.nickname,
    created_at: epochToIso(post.created_at),
    updated_at: epochToIso(post.last_modify_time),
    language: post.lang,
    requested_language: options.language,
    actual_language: post.lang,
    api_origin_lang: post.origin_lang,
    is_multilingual: post.is_multi_language,
    available_languages: post.multi_language_info?.langs,
    source_url: articleSourceUrl(postId, options.sourceUrl),
    body_source: bodyResult.source,
    body_format: "markdown"
  };
  const body = bodyResult.body ? nestArticleBody(bodyResult.body) : "";
  const sections = [frontmatter(metadata), `# Article: ${title}`, "## Article body", body || "> No readable article body was returned."];
  return sections.filter(Boolean).join("\n\n").trim() + "\n";
}

export function wikiToMdx(payload, options = {}) {
  // The Wiki title is sufficient as the document heading because frontmatter already identifies its kind.
  const { page, wikiApp, entryId, context } = wikiPageInfo(payload, options);
  const title = cleanTitle(page?.name);
  const description = htmlToMarkdown(page?.desc || "", context);
  const metadata = wikiMetadata(page, wikiApp, entryId, options);
  const headerImage = safeUrl(page?.header_img_url);
  const sections = [frontmatter(metadata), `# ${title}`];
  if (headerImage) sections.push(markdownLink("Page header", headerImage, { image: true }));
  if (description) sections.push(`> ${description.replace(/\n/g, "\n> ")}`);

  for (const [moduleIndex, module] of (page?.modules || []).entries()) {
    const moduleNumber = moduleIndex + 1;
    const moduleTitle = wikiModuleTitle(module, moduleNumber);
    const componentBlocks = [];
    for (const [componentIndex, component] of (module.components || []).entries()) {
      const componentNumber = componentIndex + 1;
      const dataValue = collapseComponentData(component.data);
      const componentTitle = wikiComponentTitle(component);
      const componentContext = {
        ...context,
        moduleIndex: moduleNumber,
        componentIndex: componentNumber,
        componentId: component.component_id,
        ownerPath: `${moduleTitle} > ${componentTitle}`
      };
      const rendered = renderStructured(dataValue, componentContext);
      if (!rendered) continue;
      componentBlocks.push(`### ${moduleNumber}.${componentNumber}. ${componentTitle}\n\n${nestWikiBody(rendered, 3)}`);
    }
    if (!componentBlocks.length) continue;
    sections.push(`## ${moduleNumber}. ${moduleTitle}\n\n${componentBlocks.join("\n\n")}`);
  }

  if (sections.length === 2) sections.push("> No readable structured Wiki content was returned.");
  return sections.join("\n\n").trim() + "\n";
}

export function convertPayload(payload, options = {}) {
  const kind = options.kind && options.kind !== "auto" ? options.kind : detectKind(payload);
  if (kind === "article") return articleToMdx(payload, options);
  if (kind === "wiki") return wikiToMdx(payload, options);
  throw new Error("Unsupported conversion kind: " + kind);
}
