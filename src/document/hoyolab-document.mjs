import { createHash } from "node:crypto";
import YAML from "yaml";
import { HoYoLabApiError, normalizeHoYoLabLanguage, normalizeHoYoLabId } from "../hoyolab/api.mjs";
import { articleDocumentParts, wikiDocumentParts, wikiDocumentPartsWithHierarchy, unwrapApiData, resolveWikiModule, resolveWikiComponent } from "../transform/hoyolab-mdx.mjs";
import { openingFence, isClosingFence } from "../transform/markdown-syntax.mjs";
import { createTextPrefixes } from "../transform/text-prefix.mjs";

function fail(code, message) {
  throw new HoYoLabApiError(message, { code });
}

const heading = (line) => line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
const tableSeparator = (line) => line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Parse already-normalized leaf Markdown without interpreting HTML/JSX or discarding unknown text.
// Source line numbers refer to this normalized leaf, not byte offsets in the upstream HTML.
function appendMarkdown(document, markdown, sourceLocation, addSection) {
  const lines = String(markdown || "").split("\n");
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index += 1; continue; }
    const start = index;
    const title = heading(lines[index]);
    if (title) {
      const number = title[2].match(/^(\d+)\.(\d+)\.(\d+)\./);
      const location = number ? `module[${number[1]}].component[${number[2]}].item[${number[3]}]` : undefined;
      addSection(title[1].length, title[2], location, { representation: "normalized-markdown", line_start: index + 1, line_end: index + 1 });
      index += 1;
      continue;
    }
    let type = "paragraph";
    let table;
    const open = openingFence(lines[index]);
    if (open) {
      type = "code";
      index += 1;
      while (index < lines.length) {
        if (isClosingFence(lines[index++], open)) break;
      }
    } else if (index + 1 < lines.length && tableSeparator(lines[index + 1])) {
      type = "table";
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) index += 1;
      table = { header: lines[start], separator: lines[start + 1], rows: lines.slice(start + 2, index) };
    } else {
      if (/^\s*(?:[-+*]|\d+[.)])\s/.test(lines[index])) type = "list";
      if (/^\s*>/.test(lines[index])) type = "quote";
      if (/^!\[[^\]]*\]\(/.test(lines[index])) type = "media";
      index += 1;
      while (index < lines.length && lines[index].trim() && !heading(lines[index]) && !openingFence(lines[index])
        && !(index + 1 < lines.length && tableSeparator(lines[index + 1]))) index += 1;
    }
    const section = document.sections.at(-1);
    const text = lines.slice(start, index).join("\n");
    document.blocks.push({ id: `b${document.blocks.length + 1}`, index: document.blocks.length + 1, type, markdown: text,
      section_id: section.id, source_location: section.location || sourceLocation,
      source_position: { representation: "normalized-markdown", line_start: start + 1, line_end: index }, table });
    if (document.blocks.length > 10000) fail("DOCUMENT_TOO_COMPLEX", "Document exceeds the 10,000-block processing limit");
  }
}

export function createDocument(payload, options) {
  options = { ...options, language: normalizeHoYoLabLanguage(options.language) || undefined };
  const data = unwrapApiData(payload);
  const post = data?.post?.post || data?.post;
  const page = data?.page;
  const id = normalizeHoYoLabId(options.kind === "article" ? post?.post_id : page?.id);
  if (!id || id !== normalizeHoYoLabId(options.id)) fail("INVALID_DOCUMENT", "Upstream document ID is missing, malformed or does not match the requested ID");
  if (options.kind === "wiki" && (!Array.isArray(page.modules) || page.modules.some((module) => !isRecord(module)
    || (module.components != null && (!Array.isArray(module.components) || module.components.some((component) => !isRecord(component))))))) {
    fail("INVALID_DOCUMENT", "Upstream Wiki hierarchy is missing or malformed");
  }
  const wikiParts = options.kind === "wiki" ? wikiDocumentPartsWithHierarchy(payload, options) : undefined;
  const parts = options.kind === "article" ? articleDocumentParts(payload, options) : wikiParts?.parts || wikiDocumentParts(payload, options);
  const rawLanguage = typeof parts.metadata.language === "string" ? parts.metadata.language.trim() : "";
  try { parts.metadata.language = normalizeHoYoLabLanguage(rawLanguage) || undefined; }
  catch { parts.metadata.language = rawLanguage || undefined; }
  const document = { metadata: { ...parts.metadata, requested_language: options.language || undefined,
    actual_language: parts.metadata.language || undefined,
    language_status: !parts.metadata.language ? "unknown" : options.language && options.language !== parts.metadata.language ? "different" : "reported",
    retrieved_at: options.retrievedAt || new Date().toISOString(), content_trust: "external-untrusted", api_url: options.sourceUrl,
    model_schema: "hoyolab.document.v1" }, sections: [], blocks: [], warnings: [...parts.warnings] };
  if (!parts.hasBody) document.warnings.push({ code: "EMPTY_BODY", path: "body", message: "The API returned a valid document but no readable body; this is not evidence that the document has no content." });
  if (!parts.metadata.language) document.warnings.push({ code: "LANGUAGE_UNREPORTED", path: "language", message: "The API did not report the actual content language; the requested language is not treated as confirmed." });
  if (document.metadata.language_status === "different") document.warnings.push({ code: "LANGUAGE_DIFFERENT", path: "language", message: "The API reported a different language from the requested language." });
  const stack = [];
  const addSection = (level, title, location, sourcePosition) => {
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const parent = stack.at(-1);
    const section = { id: `s${document.sections.length + 1}`, level, title, parent_id: parent?.id, location: location || parent?.location, source_position: sourcePosition };
    document.sections.push(section);
    stack.push(section);
    if (document.sections.length > 10000) fail("DOCUMENT_TOO_COMPLEX", "Document exceeds the 10,000-section processing limit");
  };
  for (const part of parts.sections) {
    addSection(part.level, part.title, part.location);
    appendMarkdown(document, part.markdown, part.location, addSection);
  }
  // Give empty leaf headings real blocks so full reads, searches and pagination preserve their position in the document.
  const parents = new Set(document.sections.map((section) => section.parent_id));
  const ownedBlocks = new Map();
  for (const block of document.blocks) {
    if (!ownedBlocks.has(block.section_id)) ownedBlocks.set(block.section_id, []);
    ownedBlocks.get(block.section_id).push(block);
  }
  document.blocks = document.sections.flatMap((section) => ownedBlocks.get(section.id) || (parents.has(section.id) ? [] : [{
    type: "heading", markdown: `${"#".repeat(section.level)} ${section.title}`, section_id: section.id,
    source_location: section.location, source_position: section.source_position
  }]));
  if (document.blocks.length > 10000) fail("DOCUMENT_TOO_COMPLEX", "Document exceeds the 10,000-block processing limit");
  document.blocks.forEach((block, index) => { block.id = `b${index + 1}`; block.index = index + 1; });
  document.metadata.media_reading = "links-only-no-ocr";
  document.metadata.conversion_status = document.warnings.some((warning) => /UNSUPPORTED|UNRECOGNIZED|EMPTY_BODY|FALLBACK/.test(warning.code)) ? "partial" : "no-known-loss";
  // Hash content and its interpretation, excluding retrieval time and transport address.
  const { retrieved_at, api_url, ...revisionMetadata } = document.metadata;
  document.revision = createHash("sha256").update(JSON.stringify({ revisionMetadata, sections: document.sections, blocks: document.blocks })).digest("hex");
  document.metadata.revision = document.revision;
  if (options.kind === "wiki") {
    document.hierarchy = wikiParts.hierarchy;
    const locations = indexSections(document.sections).byLocation;
    for (const module of document.hierarchy.modules) {
      module.section_id = locations.get(module.location)?.id;
      for (const component of module.components) {
        component.section_id = locations.get(component.location)?.id;
        for (const item of component.items) item.section_id = locations.get(item.location)?.id;
      }
    }
  }
  return document;
}

function indexSections(sections) {
  const byId = new Map();
  const byLocation = new Map();
  const paths = new Map();
  for (const section of sections) {
    // The first section owns a location shared by nested headings, matching the previous first-match lookup.
    if (!byId.has(section.id)) byId.set(section.id, section);
    if (!byLocation.has(section.location)) byLocation.set(section.location, section);
  }
  return { byLocation, ancestors(sectionId) {
    if (!paths.has(sectionId)) {
      const path = [];
      let section = byId.get(sectionId);
      while (section) { path.unshift(section); section = byId.get(section.parent_id); }
      paths.set(sectionId, path);
    }
    return paths.get(sectionId);
  } };
}

function descendantIds(document, rootId) {
  const ids = new Set([rootId]);
  for (const section of document.sections) if (ids.has(section.parent_id)) ids.add(section.id);
  return ids;
}

function resolveSection(document, selector, locations) {
  const raw = String(selector).trim();
  const value = /^\d+(?:\.\d+)*\.$/.test(raw) ? raw.slice(0, -1) : raw;
  const locationMatch = locations.get(value);
  if (locationMatch) return locationMatch;
  const normalized = value.toLocaleLowerCase();
  const found = document.sections.filter((section) => section.id === value || section.location === value
    || section.title.toLocaleLowerCase() === normalized || section.title.match(/^(\d+(?:\.\d+)*)\./)?.[1] === value);
  if (found.length === 1) return found[0];
  fail(found.length ? "AMBIGUOUS_SECTION" : "SECTION_NOT_FOUND", "Use an exact section_id or location from view=outline for this document revision");
}

export function resolveWikiScope(document, moduleSelector, componentSelector) {
  try {
    const parent = resolveWikiModule({ modules: document.hierarchy.modules }, moduleSelector);
    if (componentSelector === undefined) return parent.module.location;
    return resolveWikiComponent(parent.module, componentSelector, parent.index + 1).component.location;
  } catch (error) {
    fail("SECTION_NOT_FOUND", "Module/component selector does not identify a section in this document; copy selectors from its pinned hierarchy");
  }
}

function preview(text) { return String(text).replace(/\s+/g, " ").slice(0, 180); }

export function validateDocumentSelection(options = {}) {
  const view = options.view || "full";
  if (!["full", "outline", "search"].includes(view)) fail("INVALID_SELECTION", "Unknown document view");
  if (view === "search" && !options.query?.trim()) fail("INVALID_SELECTION", "view=search requires a nonempty query");
  if (view !== "search" && options.query !== undefined) fail("INVALID_SELECTION", "query is used only with view=search");
  if (view !== "full" && options.table_block) fail("INVALID_SELECTION", "Table row selection is used only with view=full");
  if (options.table_block && (options.block_ids || options.block_ranges)) fail("INVALID_SELECTION", "Use either table_block with its surrounding text or an exact block selection, not both");
  if (options.block_ids && options.block_ranges) fail("INVALID_SELECTION", "Specify either block_ids or block_ranges, not both");
  if (view === "outline" && (options.start_block || options.end_block || options.block_ids || options.block_ranges)) fail("INVALID_SELECTION", "Use outline_start/outline_block_start to page an outline; block selections are for body reads");
  if ((options.row_start !== undefined || options.row_end !== undefined) && !options.table_block) fail("INVALID_SELECTION", "Row ranges require table_block from the outline");
  if (view !== "search" && [options.match_offset, options.max_matches, options.context_blocks].some((value) => value !== undefined)) fail("INVALID_SELECTION", "Search match options are used only with view=search");
  if (view !== "outline" && [options.outline_start, options.outline_size, options.outline_block_start].some((value) => value !== undefined)) fail("INVALID_SELECTION", "Outline paging options are used only with view=outline");
  if (options.start_block !== undefined && options.end_block !== undefined && options.start_block > options.end_block) fail("INVALID_SELECTION", "end_block must be at least start_block");
  if (options.row_start !== undefined && options.row_end !== undefined && options.row_start > options.row_end) fail("INVALID_SELECTION", "row_end must be at least row_start");
  if (options.block_ranges && (!Array.isArray(options.block_ranges) || !options.block_ranges.length || options.block_ranges.length > 1000
    || options.block_ranges.some((range) => !Array.isArray(range) || range.length !== 2
      || range.some((index) => !Number.isInteger(index) || index < 1 || index > 10000) || range[1] < range[0]))) {
    fail("INVALID_SELECTION", "block_ranges must contain 1 to 1000 inclusive [start, end] index ranges inside 1..10000");
  }
  return view;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function continuationBlocks(blocks, compact) {
  if (!compact && blocks.length <= 1000) return { block_ids: blocks.map((block) => block.id), block_ranges: undefined };
  // Contiguous source indexes make large selections small enough for the next call's input schema and budget.
  const ranges = mergeRanges(blocks.map((block) => [block.index, block.index]));
  if (ranges.length > 1000) fail("BUDGET_TOO_SMALL", "The remaining selection has too many separate ranges; narrow the section or request smaller block ranges");
  return { block_ids: undefined, block_ranges: ranges };
}

export function readDocument(document, options = {}) {
  const view = validateDocumentSelection(options);
  const resumeBase = options.continuation_input || options;
  // Indexes are local to a read, so no model fields, revision hashes or cache accounting change.
  const sections = indexSections(document.sections);
  const root = options.section ? resolveSection(document, options.section, sections.byLocation) : undefined;
  const allowed = root ? descendantIds(document, root.id) : new Set(document.sections.map((section) => section.id));
  let blocks = document.blocks.filter((block) => allowed.has(block.section_id));
  const sectionBlocks = blocks;
  const upper = options.end_block || document.blocks.length;
  blocks = blocks.filter((block) => block.index >= (options.start_block || 1) && block.index <= upper);
  if (options.block_ids) {
    const ids = new Set(options.block_ids);
    const available = new Set(blocks.map((block) => block.id));
    if (!ids.size || [...ids].some((id) => !available.has(id))) fail("BLOCK_NOT_FOUND", "Every block_id must exist inside the selected document scope and range");
    blocks = blocks.filter((block) => ids.has(block.id));
  }
  if (options.block_ranges) {
    const available = new Set(blocks.map((block) => block.index));
    const selected = new Set();
    for (const [start, end] of mergeRanges(options.block_ranges)) for (let index = start; index <= end; index += 1) {
      if (!available.has(index)) fail("BLOCK_NOT_FOUND", "Every block range index must exist inside the selected document scope and range");
      selected.add(index);
    }
    blocks = blocks.filter((block) => selected.has(block.index));
  }
  if (options.start_block && options.start_block > document.blocks.length) fail("INVALID_SELECTION", "start_block is outside the document");
  let matches;
  let matchCount;
  let nextMatchOffset;
  if (view === "search") {
    const terms = options.query.normalize("NFKC").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let currentSection;
    let currentTitles;
    const hits = blocks.filter((block) => {
      // Blocks retain document order; keep only the current title prefix to avoid copying a long ancestor title for every section.
      if (currentSection !== block.section_id || currentTitles === undefined) {
        currentSection = block.section_id;
        currentTitles = sections.ancestors(block.section_id).map((section) => section.title).join(" ");
      }
      const text = `${currentTitles} ${block.markdown}`.normalize("NFKC").toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    matchCount = hits.length;
    const offset = options.match_offset || 0;
    const selectedHits = hits.slice(offset, offset + (options.max_matches || 10));
    if (offset + selectedHits.length < hits.length) nextMatchOffset = offset + selectedHits.length;
    matches = selectedHits.map((block) => ({ block_id: block.id, block_index: block.index, section_id: block.section_id, location: block.source_location, preview: preview(block.markdown) }));
    const selected = new Set();
    for (const hit of selectedHits) {
      const index = blocks.indexOf(hit);
      const padding = options.context_blocks ?? 1;
      for (let at = Math.max(0, index - padding); at <= Math.min(blocks.length - 1, index + padding); at += 1) {
        if (blocks[at].section_id === hit.section_id) selected.add(blocks[at].id);
      }
    }
    blocks = blocks.filter((block) => selected.has(block.id));
  }
  if (options.table_block) {
    const table = sectionBlocks.find((block) => block.id === options.table_block && block.type === "table");
    if (!table) fail("TABLE_NOT_FOUND", "table_block must identify a table inside the selected document scope");
    if (table.index < (options.start_block || 1) || table.index > upper) fail("INVALID_SELECTION", "The selected block range excludes table_block");
    const start = options.row_start || 1;
    const end = options.row_end ?? table.table.rows.length;
    if (start > table.table.rows.length || end < start || end > table.table.rows.length) fail("INVALID_SELECTION", "Table row range is outside the available 1-based data rows");
    // Include the owner's surrounding paragraphs so units, conditions and notes are not silently dropped.
    blocks = sectionBlocks.filter((block) => block.id === table.id || (block.section_id === table.section_id && block.type !== "table"));
    blocks = blocks.map((block) => block.id !== table.id ? block : { ...block,
      markdown: [table.table.header, table.table.separator, ...table.table.rows.slice(start - 1, end)].join("\n"),
      selected_rows: { start, end, total: table.table.rows.length } });
    blocks = blocks.filter((block) => block.index >= (options.start_block || 1) && block.index <= upper);
  }
  const metadata = { ...document.metadata, view, selection_section: root?.id };
  const maxChars = options.max_chars || (view === "full" ? 60000 : 12000);
  // Measure the complete output, including selectors and resumable arguments, before accepting a page.
  // Only whole blocks/references are removed when metadata makes the tentative page too large.
  // Keep descending candidates: continuation and selector YAML can change size at boundaries, so total size is not assumed monotonic.
  const pack = (body, returned, continuation, outline, returnedCount = returned.length) => {
    const warnings = [...document.warnings];
    if (continuation) warnings.push({ code: "OUTPUT_LIMIT", path: "selection", message: "More selected content is available using the returned continuation arguments." });
    const coverage = { conversion: document.metadata.conversion_status, scope: view === "outline" ? "outline" : root || options.start_block || options.end_block || options.table_block || options.block_ids || options.block_ranges || view === "search" ? "selection" : "document",
      total_document_blocks: document.blocks.length, selected_blocks: blocks.length, returned_blocks: returnedCount,
      output_truncated: Boolean(continuation), all_selected_blocks_returned: view === "outline" ? undefined : !continuation,
      all_matching_blocks_returned: view === "search" ? !continuation && nextMatchOffset === undefined : undefined,
      media: document.metadata.media_reading, upstream_completeness: "not-verifiable" };
    const textMetadata = { ...metadata, status: warnings.length ? "partial" : "ok", coverage, warning_codes: [...new Set(warnings.map((warning) => warning.code))], continuation,
      next_match_offset: nextMatchOffset, selection: { section: options.section, table_block: options.table_block, row_start: options.row_start, row_end: options.row_end, block_ids: options.block_ids, block_ranges: options.block_ranges } };
    const mdx = "---\n" + YAML.stringify(textMetadata, { lineWidth: 0 }).trimEnd() + "\n---\n" + body.trimEnd() + "\n";
    return { mdx, metadata, revision: document.revision, warnings, outline, matches, match_count: matchCount,
      next_match_offset: nextMatchOffset, blocks: returned, continuation, coverage };
  };
  if (view === "outline") {
    const ownedBlocks = new Map();
    for (const block of document.blocks) {
      if (!ownedBlocks.has(block.section_id)) ownedBlocks.set(block.section_id, []);
      ownedBlocks.get(block.section_id).push(block);
    }
    const entries = document.sections.filter((section) => allowed.has(section.id)).map((section) => ({ section_id: section.id, title: section.title, level: section.level, location: section.location,
      blocks: (ownedBlocks.get(section.id) || []).map((block) => ({ block_id: block.id, index: block.index, type: block.type, characters: block.markdown.length,
        rows: block.table?.rows.length })) }));
    const offset = (options.outline_start || 1) - 1;
    if (offset >= entries.length && offset !== 0) fail("INVALID_SELECTION", "outline_start is outside the selected section list");
    const units = [];
    for (const [relativeIndex, entry] of entries.slice(offset, offset + (options.outline_size || 50)).entries()) {
      const blockStart = relativeIndex === 0 ? options.outline_block_start || 1 : 1;
      if (blockStart > entry.blocks.length + 1) fail("INVALID_SELECTION", "outline_block_start is outside this outline section");
      const sectionIndex = offset + relativeIndex;
      units.push({ entry, sectionIndex, blockStart, text: `${relativeIndex ? "\n" : ""}${"#".repeat(entry.level)} ${entry.title}\n- section_id: ${entry.section_id}${entry.location ? ` · location: ${entry.location}` : ""}\n` });
      for (let blockIndex = blockStart - 1; blockIndex < entry.blocks.length; blockIndex += 1) {
        const block = entry.blocks[blockIndex];
        units.push({ entry, sectionIndex, blockStart, blockIndex, block,
          text: `- ${block.block_id}: ${block.type} (${block.characters} chars${block.rows !== undefined ? `, ${block.rows} rows` : ""})\n` });
      }
    }
    let size = 0;
    let count = 0;
    while (count < units.length && size + units[count].text.length <= maxChars) { size += units[count].text.length; count += 1; }
    if (!units.length) {
      const result = pack("", [], undefined, []);
      if (result.mdx.length <= maxChars) return result;
    }
    const prefix = createTextPrefixes(units.slice(0, count).map((unit) => unit.text));
    for (; count > 0; count -= 1) {
      const last = units[count - 1];
      // A nonempty owner heading alone cannot advance its block cursor.
      if (!last.block && last.blockStart <= last.entry.blocks.length) continue;
      const next = units[count];
      const nextSection = next?.sectionIndex ?? last.sectionIndex + 1;
      const continuation = nextSection < entries.length ? { ...resumeBase, view, outline_start: nextSection + 1,
        outline_block_start: next?.block ? next.blockIndex + 1 : next?.blockStart || 1,
        max_chars: maxChars, revision: document.revision, refresh: undefined } : undefined;
      const result = pack(prefix(count), [], continuation);
      if (result.mdx.length <= maxChars) {
        // Build structured references only after the serialized page fits; failed candidates need just their text and cursor.
        const outline = [];
        for (let index = 0; index < count; index += 1) {
          const unit = units[index];
          if (!unit.block) outline.push({ ...unit.entry, blocks: [], total_section_blocks: unit.entry.blocks.length, block_start: unit.blockStart });
          else outline.at(-1).blocks.push(unit.block);
        }
        result.outline = outline;
        return result;
      }
    }
  } else {
    const emitted = new Set();
    const chunks = [];
    const returned = [];
    let size = 0;
    for (const block of blocks) {
      const chain = sections.ancestors(block.section_id);
      const headingChain = block.type === "heading" ? chain.slice(0, -1) : chain;
      const headings = headingChain.filter((section) => !emitted.has(section.id)).map((section) => `${"#".repeat(section.level)} ${section.title}`).join("\n\n");
      const chunk = `${headings ? headings + "\n\n" : ""}${block.markdown}\n\n`;
      if (size + chunk.length > maxChars) break;
      chunks.push(chunk); size += chunk.length;
      chain.forEach((section) => emitted.add(section.id));
      returned.push({ block_id: block.id, index: block.index, type: block.type, section_id: block.section_id, location: block.source_location, source_position: block.source_position, selected_rows: block.selected_rows });
    }
    if (!blocks.length) {
      const chain = root ? sections.ancestors(root.id) : document.sections.slice(0, 2);
      let body = chain.map((section) => `${"#".repeat(section.level)} ${section.title}`).join("\n\n") + "\n\n";
      body += view === "search" ? "> No matching readable blocks were found.\n" : "> No readable body blocks were returned.\n";
      const result = pack(body, [], undefined);
      if (result.mdx.length <= maxChars) return result;
    }
    const prefix = createTextPrefixes(chunks);
    const tableIndex = options.table_block ? returned.findIndex((block) => block.block_id === options.table_block) : -1;
    for (let count = returned.length; count > 0; count -= 1) {
      const tableAlreadyReturned = options.table_block && tableIndex >= 0 && tableIndex < count;
      const continuation = count === blocks.length ? undefined : view === "search" || options.block_ids || options.block_ranges || tableAlreadyReturned
        ? { ...resumeBase, view: "full", query: undefined, match_offset: undefined, max_matches: undefined, context_blocks: undefined,
          table_block: undefined, row_start: undefined, row_end: undefined,
          start_block: undefined, end_block: undefined, ...continuationBlocks(blocks.slice(count), Boolean(options.block_ranges || tableAlreadyReturned)), max_chars: maxChars, revision: document.revision, refresh: undefined }
        : { ...resumeBase, start_block: blocks[count].index, max_chars: maxChars, revision: document.revision, refresh: undefined };
      const result = pack(prefix(count), returned, continuation, undefined, count);
      if (result.mdx.length <= maxChars) {
        result.blocks = returned.slice(0, count);
        return result;
      }
    }
  }
  fail("BUDGET_TOO_SMALL", "Increase max_chars to fit metadata and the next complete block/reference, or select a smaller table row range; content is never cut mid-block");
}
