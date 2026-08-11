import YAML from "yaml";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined"
});

turndown.use(gfm);
turndown.addRule("hoyolabIframe", {
  filter: "iframe",
  replacement: (_content, node) => {
    const url = safeUrl(node.getAttribute("src"));
    return url ? `\n[Video](${url})\n` : "";
  }
});
turndown.addRule("hoyolabTable", {
  filter: "table",
  replacement: (_content, node) => htmlTableToMarkdown(node)
});
turndown.remove(["script", "style", "noscript", "template", "object", "embed", "svg"]);

const INTERNAL_KEYS = /^(id|uid|suid|post_id|game_id|component_id|layout|style|origin_module_id|is_poped|is_customize_name|is_abstract|is_show_switch|switch|repeated|is_submodule|without_border|can_delete|is_hidden|rich_text_editing)$/i;
const HTML_VALUE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*|\/?\s*)>/i;
const LOCALE_PLACEHOLDER = /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i;

// Keep transport metadata in frontmatter while rendering only fields that describe the readable document.

function isObject(value) {
  return value !== null && typeof value === "object";
}

function compactMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );
}

function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number * 1000).toISOString();
}

function frontmatter(metadata) {
  return "---\n" + YAML.stringify(compactMetadata(metadata), { lineWidth: 0 }).trimEnd() + "\n---";
}

function indentBlock(value, prefix = "  ") {
  return String(value).split("\n").map((line) => prefix + line).join("\n");
}

export function cleanMarkdown(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripResidualHtml(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*|\/?\s*)>/gi, "");
}

function scopedHeading(title, context = {}) {
  const value = String(title ?? "").trim();
  if (!value) return "";
  return context.ownerPath ? `${context.ownerPath} > ${value}` : value;
}

function hierarchyItemNumber(context = {}, itemIndex = context.itemIndex) {
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
  return String(value).replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, title) => {
    itemIndex += 1;
    return `${hashes} ${hierarchyItemPrefix(context, itemIndex)}${title.trim()}`;
  });
}

function nestArticleBody(value) {
  return String(value ?? "").replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, title) => {
    const level = Math.min(6, hashes.length + 1);
    const label = hashes.length <= 2 ? "Section" : "Subsection";
    return `${"#".repeat(level)} ${label}: ${title.trim()}`;
  });
}

function safeUrl(value) {
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
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
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

function articleMediaUrl(value) {
  if (typeof value === "string") return safeUrl(value);
  if (!isObject(value)) return "";
  return safeUrl(value.url || value.image_url || value.img_url || value.src || value.image || value.img || value.video);
}

function articleMediaMarkdown(value, kind = "image", options = {}) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const url = articleMediaUrl(item);
    if (!url) return "";
    const title = isObject(item)
      ? articleTextValue(item.alt || item.name || item.title || item.description, options)
      : "";
    if (kind === "video") return `[${title || "Video"}](${url})`;
    return `![${title || "Image"}](${url})`;
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
  if (!Array.isArray(headerValues) || !Array.isArray(rowValues) || headerValues.length < 2 || rowValues.length < 1) return "";

  const headers = headerValues.map((header, index) => tableColumnName(header, index, options));
  const columns = headerValues.map((header, index) => tableColumnKey(header, index));
  const rows = rowValues.map((row) => {
    if (Array.isArray(row)) return row.map((cell) => articleTextValue(cell, options));
    if (!isObject(row)) return [articleTextValue(row, options)];
    return columns.map((column, index) => {
      const valueByKey = row[column] ?? row[String(column)] ?? row[index];
      return articleTextValue(valueByKey, options);
    });
  });

  if (!headers.every(Boolean) || rows.some((row) => row.length < 2)) return "";
  return renderMarkdownTable(headers, rows);
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
  if (type.includes("table") || block.table !== undefined) {
    const table = articleTableMarkdown(block.table || block, options);
    if (table) return table;
  }
  if (type.includes("image") || type === "img") {
    const image = articleMediaMarkdown(block.image || block.img || block.url || block.src || block, "image", options);
    if (image) return image;
  }
  if (type.includes("video")) {
    const video = articleMediaMarkdown(block.video || block.url || block.src || block, "video", options);
    if (video) return video;
  }

  for (const key of ["text", "describe", "description", "html", "value"]) {
    if (block[key] !== undefined) {
      const text = articleTextValue(block[key], options);
      if (text) return text;
    }
  }
  for (const key of ["content", "children", "blocks", "sections", "paragraphs"]) {
    if (block[key] !== undefined) {
      const nested = renderArticleJsonBlock(block[key], options);
      if (nested) return nested;
    }
  }
  for (const key of ["table", "tables", "data_table"]) {
    if (block[key] !== undefined) {
      const table = Array.isArray(block[key])
        ? block[key].map((item) => articleTableMarkdown(item, options)).filter(Boolean).join("\n\n")
        : articleTableMarkdown(block[key], options);
      if (table) return table;
    }
  }
  for (const key of ["image", "img", "images", "imgs", "gallery"]) {
    if (block[key] !== undefined) {
      const image = articleMediaMarkdown(block[key], "image", options);
      if (image) return image;
    }
  }
  for (const key of ["video", "videos"]) {
    if (block[key] !== undefined) {
      const video = articleMediaMarkdown(block[key], "video", options);
      if (video) return video;
    }
  }
  return "";
}

function articleJsonToMarkdown(value, options = {}) {
  // Legacy article bodies store readable text and media under describe, imgs, and video keys instead of HTML.
  const parsed = parseMaybeJson(value);
  if (!isObject(parsed)) return "";

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
      const table = Array.isArray(parsed[key])
        ? parsed[key].map((item) => articleTableMarkdown(item, options)).filter(Boolean).join("\n\n")
        : articleTableMarkdown(parsed[key], options);
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

  return cleanMarkdown(parts.join("\n\n"));
}

function htmlTableToMarkdown(node) {
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

  if (!rows.length) return "";

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
    return blocks.length ? `\n${blocks.join("\n\n")}\n` : "";
  }

  normalized.shift();

  return `\n${renderMarkdownTable(headers, normalized)}\n`;
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
    return url ? `[${label}](${url})${amount}` : `${label}${amount}`;
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

function renderKeyValueList(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (!list.every((item) => isObject(item) && Object.hasOwn(item, "key") && Object.hasOwn(item, "value"))) return "";
  return list.map((item, index) => {
    const key = inlineValue(item.key, context) || "Value";
    const value = compactValue(item.value, context);
    if (!value) return "";
    const prefix = hierarchyItemPrefix(context, index + 1);
    if (value.includes("\n")) return `- ${prefix}**${key}:**\n${indentBlock(value)}`;
    return `- ${prefix}**${key}:** ${value}`;
  }).filter(Boolean).join("\n");
}

function renderImageList(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (!list.every((item) => isObject(item) && Object.hasOwn(item, "key") && Object.hasOwn(item, "img"))) return "";
  return list.map((item, index) => {
    const key = inlineValue(item.key, context) || "Image";
    const url = safeUrl(item.img);
    const image = url ? `![${key}](${url})` : "";
    const description = inlineValue(item.imgDesc, context);
    const detail = [image, description].filter(Boolean).join(" — ");
    return `- ${hierarchyItemPrefix(context, index + 1)}**${key}:** ${detail || "Unavailable"}`;
  }).join("\n");
}

function renderValuesTable(list, context = {}) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const rows = list.filter((item) => isObject(item) && Array.isArray(item.values));
  if (rows.length === 0) return "";
  const firstValues = rows[0].values.map((value) => inlineValue(value, context));
  const headers = [rows[0].key ? inlineValue(rows[0].key, context) : "Field", ...firstValues];
  const dataRows = rows.slice(1).map((item) => [
    inlineValue(item.key, context),
    ...item.values.map((value) => inlineValue(value, context))
  ]);
  return renderMarkdownTable(headers, dataRows);
}

function renderMaterials(materials, context = {}) {
  if (!Array.isArray(materials) || materials.length === 0) return "";
  const values = materials.flatMap((value) => {
    const embedded = renderEmbeddedItems(value, context);
    return embedded ? [embedded] : [];
  });
  return values.length ? `- **Materials:** ${values.join(", ")}` : "";
}

function renderDescriptiveItem(item, context = {}) {
  if (!isObject(item)) return inlineValue(item, context);
  const lines = [];
  const heading = inlineValue(item.title || item.name || item.key || item.position, context);
  if (heading) lines.push(numberedItemHeading(heading, context));

  const image = safeUrl(item.img || item.icon_url || item.image);
  if (image) lines.push(`![${heading || "Image"}](${image})`);

  const description = inlineValue(item.desc || item.description || item.imgDesc, context);
  if (description) lines.push(description);

  if (Array.isArray(item.attributes)) {
    const table = renderValuesTable(item.attributes, context);
    if (table) lines.push(table);
  }
  if (Array.isArray(item.combatList)) {
    const table = renderValuesTable(item.combatList, context);
    if (table) lines.push(table);
  }
  if (Array.isArray(item.materials)) {
    const materials = renderMaterials(item.materials, context);
    if (materials) lines.push(materials);
  }
  if (Array.isArray(item.videos)) {
    for (const video of item.videos) {
      const url = safeUrl(video?.url);
      if (!url) continue;
      const title = inlineValue(video.title || "Video", context);
      const duration = video.duration ? ` (${video.duration}s)` : "";
      lines.push(`- [${title}](${url})${duration}`);
    }
  }
  if (Array.isArray(item.audios)) {
    for (const audio of item.audios) {
      const url = safeUrl(audio?.url);
      if (!url) continue;
      lines.push(`- [${inlineValue(audio.name || "Audio", context)}](${url})`);
    }
  }
  return lines.join("\n\n");
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
      const table = renderValuesTable(item.combatList, context);
      const materials = renderMaterials(item.materials, context);
      return [numberedItemHeading(title, { ...context, itemIndex: index + 1 }), table, materials].filter(Boolean).join("\n\n");
    }).join("\n\n");
  }

  const valuesTable = renderValuesTable(list, context);
  if (valuesTable && list.some((item) => isObject(item) && Array.isArray(item.values))) return valuesTable;

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

  if (Array.isArray(current)) return renderList(current, context);

  const lines = [];
  if (typeof current.pic === "string") {
    const url = safeUrl(current.pic);
    if (url) lines.push(`![Gallery](${url})`);
  }

  if (Array.isArray(current.list)) {
    const listContent = renderList(current.list, context);
    if (listContent) lines.push(listContent);
  }

  if (isObject(current.artifact_list)) {
    for (const [index, [key, item]] of Object.entries(current.artifact_list).entries()) {
      const rendered = renderDescriptiveItem(
        { ...item, position: item.position || humanizeKey(key) },
        { ...context, itemIndex: index + 1 }
      );
      if (rendered) lines.push(rendered);
    }
  }

  if (typeof current.data === "string" && current.data.trim()) {
    const rendered = numberMarkdownItems(htmlToMarkdown(current.data, context), context);
    if (rendered) lines.push(rendered);
  }

  for (const [key, nested] of Object.entries(current)) {
    if (["list", "pic", "artifact_list", "data"].includes(key) || INTERNAL_KEYS.test(key)) continue;
    const rendered = compactValue(nested, context);
    if (!rendered) continue;
    const label = humanizeKey(key);
    if (rendered.includes("\n")) lines.push(`- **${label}:**\n${indentBlock(rendered)}`);
    else lines.push(`- **${label}:** ${rendered}`);
  }

  return lines.filter(Boolean).join("\n");
}

function formatInlineDeltaText(value, attributes = {}) {
  let text = String(value ?? "").replace(/\u200b/g, "");
  if (!text) return "";

  if (attributes.code) text = `\`${text.replace(/`/g, "\\`")}\``;
  if (attributes.bold) text = `**${text}**`;
  if (attributes.italic) text = `*${text}*`;
  if (attributes.underline) text = `<u>${text}</u>`;
  if (attributes.strike) text = `~~${text}~~`;

  const link = safeUrl(attributes.link);
  return link ? `[${text.replace(/\]/g, "\\]")}](${link})` : text;
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
    lines.push(url ? `- [${title}](${url})${detail}` : `- ${title}${detail}`);
  }
  return lines.join("\n");
}

function renderDeltaEmbed(insert) {
  if (!isObject(insert)) return "";
  if (insert.type === "ContentTypeText" && insert.text !== undefined) {
    return inlineValue(insert.text);
  }
  if (insert.emoticon) {
    const url = safeUrl(insert.emoticon.url || insert.emoticon.image || insert.emoticon.src);
    if (url) return `![Emoji](${url})`;
    return inlineValue(insert.backup?.text || insert.text);
  }
  if (insert.emoji) {
    const url = safeUrl(insert.emoji.url || insert.emoji.image || insert.emoji.src);
    if (url) return `![Emoji](${url})`;
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
    const url = safeUrl(insert.image);
    return url ? `![Image](${url})` : "";
  }
  if (insert.video) {
    const url = safeUrl(insert.video);
    return url ? `[Video](${url})` : "";
  }
  if (insert.divider !== undefined) return "---";
  if (insert.vote) return renderVote(insert.vote);
  if (insert.card_group) return renderCardGroup(insert.card_group);

  const [key, value] = Object.entries(insert)[0] || [];
  if (!key) return "";
  const url = isObject(value) ? safeUrl(value.url || value.src) : safeUrl(value);
  const label = humanizeKey(key);
  return url ? `[${label}](${url})` : "";
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

export function quillDeltaToMarkdown(value) {
  const ops = deltaOps(value);
  if (!meaningfulDelta(ops)) return "";

  const lines = [];
  let segments = [];
  let listKind = "";
  let listIndex = 0;
  let pendingBlockAttributes = {};

  const finishLine = (attributes = {}) => {
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
    segments = [];
  };

  const addBlock = (block) => {
    if (!block) return;
    if (segments.length) finishLine(pendingBlockAttributes);
    pendingBlockAttributes = {};
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...String(block).split("\n"));
    lines.push("");
    listKind = "";
    listIndex = 0;
  };

  for (const op of ops) {
    const attributes = isObject(op.attributes) ? op.attributes : {};
    if (typeof op.insert === "string") {
      const parts = op.insert.split("\n");
      const hasBlockAttributes = Object.hasOwn(attributes, "header") || Object.hasOwn(attributes, "list") || Object.hasOwn(attributes, "indent");
      parts.forEach((part, index) => {
        if (part) segments.push(formatInlineDeltaText(part, attributes));
        if (index < parts.length - 1) {
          finishLine({ ...pendingBlockAttributes, ...attributes });
          pendingBlockAttributes = {};
        }
      });
      if (parts.length === 1 && hasBlockAttributes) pendingBlockAttributes = { ...pendingBlockAttributes, ...attributes };
      continue;
    }
    if (isInlineDeltaEmbed(op.insert)) {
      const rendered = renderDeltaEmbed(op.insert);
      if (rendered) segments.push(rendered);
      continue;
    }
    addBlock(renderDeltaEmbed(op.insert));
  }

  if (segments.length) finishLine(pendingBlockAttributes);
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
  const text = value.replace(/<[^>]+>/g, " ").trim();
  return Boolean(text) && !LOCALE_PLACEHOLDER.test(text);
}

function hasMarkdownTable(value) {
  return /^\|[^\n]*\|\s*\n\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|/m.test(String(value ?? ""));
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
    const body = quillDeltaToMarkdown(structured);
    if (body) {
      if (shouldPreferArticleHtml(content, htmlContent, body)) return { body: htmlContent, source: "html" };
      return { body, source: "quill-delta" };
    }
  }

  const contentDelta = deltaOps(content);
  if (meaningfulDelta(contentDelta)) {
    const body = quillDeltaToMarkdown(contentDelta);
    if (body) {
      if (shouldPreferArticleHtml(content, htmlContent, body)) return { body: htmlContent, source: "html" };
      return { body, source: "quill-delta-content" };
    }
  }

  if (htmlContent) return { body: htmlContent, source: "html" };

  const rows = deltaOps(structuredRows);
  if (meaningfulDelta(rows)) {
    const body = quillDeltaToMarkdown(rows);
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
      return [...htmlToMarkdown(current, context).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
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
    return [...htmlToMarkdown(current.data, context).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
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
    language: page?.lang || options.language,
    source_url: wikiSourceUrl(wikiApp, entryId, options.sourceUrl),
    modules
  };
}

function selectorValue(selector, label) {
  const value = String(selector ?? "").trim();
  if (!value) throw new Error(`${label} selector is required`);
  return value;
}

function resolveWikiModule(page, selector) {
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

function resolveWikiComponent(module, selector) {
  const value = selectorValue(selector, "component");
  const components = module?.components || [];
  const indexSelector = value.match(/^(?:module\[\d+\]\.)?component\[(\d+)\]$/i) || value.match(/^(\d+)$/);
  if (indexSelector) {
    const index = Number(indexSelector[1]) - 1;
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
    language: page?.lang || options.language,
    icon_url: safeUrl(page?.icon_url),
    header_img_url: safeUrl(page?.header_img_url),
    source_url: wikiSourceUrl(wikiApp, entryId, options.sourceUrl),
    body_format: "structured-markdown"
  };
}

export function wikiLocationToMdx(payload, options = {}, selectors = {}) {
  // Scoped reads reuse the full-entry numbering scheme so locations remain stable across tools.
  const { page, wikiApp, entryId, context } = wikiPageInfo(payload, options);
  const moduleResult = resolveWikiModule(page, selectors.module);
  const moduleNumber = moduleResult.index + 1;
  const moduleTitle = wikiModuleTitle(moduleResult.module, moduleNumber);
  const componentResults = selectors.component === undefined || selectors.component === null
    ? (moduleResult.module.components || []).map((component, index) => ({ component, index }))
    : [resolveWikiComponent(moduleResult.module, selectors.component)];
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
    return `### ${moduleNumber}.${componentNumber}. ${componentTitle}\n\n${rendered || "> No readable structured content was returned."}`;
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
    language: post.lang || options.language,
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
  if (headerImage) sections.push(`![Page header](${headerImage})`);
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
      componentBlocks.push(`### ${moduleNumber}.${componentNumber}. ${componentTitle}\n\n${rendered}`);
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
