import test from "node:test";
import assert from "node:assert/strict";
import { createHoYoLabClient } from "../src/hoyolab/api.mjs";
import { createDocumentStore } from "../src/document/document-store.mjs";
import { createDocument, readDocument, validateDocumentSelection } from "../src/document/hoyolab-document.mjs";
import { articleToMdx, htmlToMarkdown, quillDeltaToMarkdown, wikiToMdx } from "../src/transform/hoyolab-mdx.mjs";

const article = (content, postId = "101") => ({ retcode: 0, data: { post: { post: { post_id: postId, subject: "Deep fixture", lang: "en-us", content } } } });
const document = (content) => createDocument(article(content), { kind: "article", id: "101", language: "en-us" });
const wiki = (data) => ({ retcode: 0, data: { page: { id: "202", name: "Deep Wiki fixture", lang: "en-us", modules: [
  { name: "Skills", components: [{ component_id: "talent", data: JSON.stringify(data) }] }
] } } });
const wikiDocument = (data) => createDocument(wiki(data), { kind: "wiki", id: "202", wikiApp: "genshin", language: "en-us" });

test("a pending old fetch stays old after another identity evicts the completed refresh", async () => {
  const pending = [];
  const store = createDocumentStore({ maxEntries: 1, apiClient: { getArticle: () => new Promise((resolve) => pending.push(resolve)) } });
  const args = { kind: "article", id: "101", language: "en-us" };
  const old = store.get(args);
  const refresh = store.get({ ...args, refresh: true });
  pending[1]({ payload: article("CURRENT") });
  const current = await refresh;
  const other = store.get({ ...args, id: "102" });
  pending[2]({ payload: article("OTHER", "102") });
  await other;
  pending[0]({ payload: article("STALE") });
  await old;
  const latest = store.get(args);
  if (pending[3]) pending[3]({ payload: article("CURRENT") });
  const result = await latest;
  assert.equal(result.document.revision, current.document.revision);
  assert.equal(result.cache_hit, false);
  assert.equal(pending.length, 4);
  assert.equal(store.stats().entries, 1);
});

test("an uncached large refresh cannot be overtaken by an older pending fetch", async () => {
  const pending = [];
  const store = createDocumentStore({ maxBytes: 5000, apiClient: { getArticle: () => new Promise((resolve) => pending.push(resolve)) } });
  const args = { kind: "article", id: "101", language: "en-us" };
  const old = store.get(args);
  const refresh = store.get({ ...args, refresh: true });
  const large = article("CURRENT ".repeat(3000));
  pending[1]({ payload: large });
  const current = await refresh;
  assert.equal(store.stats().entries, 0);
  pending[0]({ payload: article("STALE") });
  await old;
  const latest = store.get(args);
  if (pending[2]) pending[2]({ payload: large });
  assert.equal((await latest).document.revision, current.document.revision);
  assert.equal(pending.length, 3);
  assert.ok(store.stats().bytes <= 5000);
});

test("failed refreshes do not suppress a usable older successful fetch", async () => {
  const pending = [];
  const store = createDocumentStore({ apiClient: { getArticle: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } });
  const args = { kind: "article", id: "101", language: "en-us" };
  const older = store.get(args);
  const refresh = store.get({ ...args, refresh: true });
  pending[1].reject(new Error("temporary failure"));
  await assert.rejects(refresh, /temporary failure/);
  pending[0].resolve({ payload: article("USABLE") });
  const usable = await older;
  assert.equal((await store.get(args)).document.revision, usable.document.revision);
  assert.equal(pending.length, 2);
});

test("Wiki descriptions keep their headings beneath the numbered owning item", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const doc = wikiDocument({ list: [
      { title: "Skill A", desc: `<h${level}>Details A</h${level}><p>BODY-A</p>` },
      { title: "Skill B", desc: `<h${level}>Details B</h${level}><p>BODY-B</p>` }
    ] });
    const items = doc.hierarchy.modules[0].components[0].items;
    for (const [index, marker] of ["A", "B"].entries()) {
      const selected = readDocument(doc, { section: items[index].location });
      assert.ok(selected.mdx.includes(`BODY-${marker}`), `h${level}: missing item ${marker}`);
      assert.ok(!selected.mdx.includes(`BODY-${marker === "A" ? "B" : "A"}`));
      const heading = doc.sections.find((section) => section.title === `Details ${marker}`);
      assert.equal(heading.parent_id, items[index].section_id);
      assert.equal(heading.location, items[index].location);
      assert.ok(heading.level > doc.sections.find((section) => section.id === items[index].section_id).level);
    }
  }
});

test("Wiki alias fields, media notes and unexpected field shapes are retained with warnings", () => {
  const data = { list: [{ title: "MAIN-TITLE", name: "EXTRA-NAME", desc: "MAIN-DESCRIPTION", description: "EXTRA-DESCRIPTION",
    attributes: { note: "ATTRIBUTE-NOTE" }, materials: "MATERIAL-NOTE",
    videos: [{ url: "https://example.com/video", title: "Video", transcript: "TRANSCRIPT-NOTE" }, { url: "javascript:unsafe", title: "UNAVAILABLE-VIDEO" }],
    audios: [{ name: "UNAVAILABLE-AUDIO", text: "AUDIO-TEXT" }] }], data: { note: "DATA-NOTE" }, pic: { alt: "PIC-NOTE" } };
  const doc = wikiDocument(data);
  const output = readDocument(doc).mdx;
  for (const marker of ["MAIN-TITLE", "EXTRA-NAME", "MAIN-DESCRIPTION", "EXTRA-DESCRIPTION", "ATTRIBUTE-NOTE", "MATERIAL-NOTE",
    "TRANSCRIPT-NOTE", "UNAVAILABLE-VIDEO", "UNAVAILABLE-AUDIO", "AUDIO-TEXT", "DATA-NOTE", "PIC-NOTE"]) {
    assert.ok(output.includes(marker), `Missing ${marker}`);
  }
  assert.equal(doc.metadata.conversion_status, "partial");
  assert.ok(doc.warnings.some((warning) => /UNRECOGNIZED|UNSUPPORTED/.test(warning.code)));
  assert.doesNotMatch(output, /\]\(javascript:/i);
});

test("unexpected Wiki list and artifact values remain text, not character-by-character object fields", () => {
  for (const data of [{ list: "LIST-MARKER" }, { artifact_list: ["ARTIFACT-MARKER"] }, { data: { note: "DATA-MARKER" }, list: [] }]) {
    const output = readDocument(wikiDocument(data)).mdx;
    const marker = data.list === "LIST-MARKER" ? "LIST-MARKER" : Array.isArray(data.artifact_list) ? "ARTIFACT-MARKER" : "DATA-MARKER";
    assert.ok(output.includes(marker), `Missing ${marker}`);
  }
});

test("a table selection cannot silently exclude its table through a conflicting block range", () => {
  const doc = document("<p>Units.</p><table><tr><th>Level</th><th>Value</th></tr><tr><td>1</td><td>42%</td></tr></table><p>Condition.</p>");
  const table = doc.blocks.find((block) => block.type === "table");
  for (const range of [{ start_block: table.index + 1 }, { end_block: table.index - 1 }]) {
    assert.throws(() => readDocument(doc, { table_block: table.id, ...range }), (error) => error.code === "INVALID_SELECTION");
  }
});

test("table selection continuations preserve surrounding notes even after the table has been emitted", () => {
  const doc = document("<p>Units.</p><table><tr><th>Level</th><th>Value</th></tr><tr><td>1</td><td>20%</td></tr><tr><td>2</td><td>42%</td></tr></table>"
    + Array.from({ length: 12 }, (_, index) => `<p>NOTE-${index} ${"detail ".repeat(90)}</p>`).join("") + "<h2>Other</h2><p>Unrelated.</p>");
  const table = doc.blocks.find((block) => block.type === "table");
  const expected = doc.blocks.filter((block) => block.section_id === table.section_id).map((block) => block.id);
  const ids = [];
  const output = [];
  let args = { table_block: table.id, row_start: 2, row_end: 2, max_chars: 3000 };
  for (let page = 0; page < 40; page += 1) {
    const result = readDocument(doc, args);
    assert.ok(result.mdx.length <= 3000);
    output.push(result.mdx);
    ids.push(...result.blocks.map((block) => block.block_id));
    if (!result.continuation) break;
    assert.ok(result.blocks.length > 0);
    args = result.continuation;
  }
  assert.deepEqual(ids, expected);
  assert.match(output.join("\n"), /\| 2 \| 42% \|/);
  assert.doesNotMatch(output.join("\n"), /\| 1 \| 20% \||Unrelated/);
});

test("response size errors survive rejected or stalled cleanup and release the request slot", async () => {
  for (const mode of ["header", "stream"]) for (const cleanup of ["reject", "stall"]) {
    let finishCleanup;
    let called = false;
    let calls = 0;
    const body = new ReadableStream({ start(controller) { if (mode === "stream") controller.enqueue(new Uint8Array(200)); }, cancel() {
      called = true;
      return cleanup === "reject" ? Promise.reject(new Error("cleanup failed")) : new Promise((resolve) => { finishCleanup = resolve; });
    } });
    const api = createHoYoLabClient({ timeoutMs: 1000, minRequestIntervalMs: 0, maxRetries: 0, concurrency: 1, maxResponseBytes: 100,
      fetchImpl: async () => ++calls === 1 ? new Response(body, mode === "header" ? { headers: { "content-length": "200" } } : undefined)
        : new Response(JSON.stringify({ retcode: 0, data: {} })) });
    let timer;
    try {
      const outcome = await Promise.race([api.getArticle({ postId: "101" }).then(() => "unexpected success", (error) => error.code),
        new Promise((resolve) => { timer = setTimeout(() => resolve("CLEANUP_STALLED"), 150); })]);
      assert.equal(outcome, "RESPONSE_TOO_LARGE", `${mode}/${cleanup}`);
      assert.equal(called, true);
      assert.equal((await api.getArticle({ postId: "101" })).status, 200);
    } finally {
      clearTimeout(timer);
      finishCleanup?.();
    }
  }
});

test("fences followed by non-whitespace text do not end a literal code block", () => {
  for (const fence of ["```", "~~~~", "`````"]) {
    const code = `${fence}text\n${fence}not-a-close\n# literal heading\n\n\n\nCODE-END\n${fence} \t\n\nAfter`;
    const doc = document(JSON.stringify({ text: code }));
    assert.equal(doc.blocks.filter((block) => block.type === "code").length, 1);
    assert.equal(doc.sections.length, 2);
    assert.ok(doc.blocks[0].markdown.includes("# literal heading\n\n\n\nCODE-END"));
    assert.equal(doc.blocks.at(-1).markdown, "After");
    assert.ok(readDocument(doc).mdx.includes(code.trimEnd()));
  }
});

test("HTTP URLs containing parentheses cannot forge a second Markdown destination", () => {
  const url = "https://example.com/a)[injected](javascript:bad)";
  const encoded = "https://example.com/a%29[injected]%28javascript:bad%29";
  const html = htmlToMarkdown(`<a href="${url}">Click</a><iframe src="${url}"></iframe>`);
  assert.ok(html.includes(encoded));
  assert.doesNotMatch(html, /\]\(javascript:/i);
  const delta = quillDeltaToMarkdown([{ insert: "Click", attributes: { link: url } }, { insert: "\n" }, { insert: { image: url } }, { insert: { video: url } }]);
  assert.ok(delta.includes(encoded));
  assert.doesNotMatch(delta, /\]\(javascript:/i);
  const json = readDocument(document(JSON.stringify({ images: [{ url, alt: "Image" }], videos: [{ url, title: "Video" }] }))).mdx;
  assert.ok(json.includes(encoded));
  assert.doesNotMatch(json, /\]\(javascript:/i);
  const wikiOutput = wikiToMdx(wiki({ list: [{ title: "Item", img: url, videos: [{ title: "Video", url }], audios: [{ name: "Audio", url }] }] }), { wikiApp: "genshin" });
  assert.ok(wikiOutput.includes(encoded));
  assert.doesNotMatch(wikiOutput, /\]\(javascript:/i);
});

test("link and image labels retain bracket characters without becoming nested active links", () => {
  const title = "Name](javascript:bad)[suffix";
  const output = readDocument(document(JSON.stringify({ images: [{ url: "https://example.com/image", alt: title }], videos: [{ url: "https://example.com/video", title }] }))).mdx;
  assert.ok(output.includes("Name\\](javascript:bad)\\[suffix"));
  assert.doesNotMatch(output, /(?<!\\)\]\(javascript:/i);
  const linked = quillDeltaToMarkdown([{ insert: title, attributes: { link: "https://example.com/target", bold: true } }, { insert: "\n" }]);
  assert.ok(linked.includes("Name\\](javascript:bad)\\[suffix"));
  assert.doesNotMatch(linked, /(?<!\\)\]\(javascript:/i);
});

test("mixed Wiki shapes preserve deterministic text markers across all readable fields", () => {
  for (let sample = 0; sample < 48; sample += 1) {
    const markers = [];
    const marker = () => { const text = `SOURCE-${sample}-${markers.length}-KEEP`; markers.push(text); return text; };
    const forms = [
      () => ({ title: marker(), name: marker(), desc: `<h2>${marker()}</h2><p>${marker()}</p>`, description: marker(), attributes: [{ key: marker(), value: marker(), note: marker() }] }),
      () => ({ title: marker(), materials: [marker(), { note: marker() }], videos: [{ title: marker(), url: "https://example.com/a)b", transcript: marker() }], audios: [{ name: marker(), url: "", text: marker() }] }),
      () => ({ key: marker(), img: { alt: marker() }, imgDesc: marker(), note: marker() }),
      () => ({ key: marker(), combatList: [{ key: marker(), value: marker() }], materials: { note: marker() } }),
      () => ({ title: marker(), attributes: [{ title: marker(), desc: marker() }, { title: marker(), description: marker() }] }),
      () => ({ key: marker(), values: [marker(), { note: marker() }], note: marker() })
    ];
    const data = { list: [forms[sample % forms.length]()], data: { additional_note: marker() }, artifact_list: { slot: marker() } };
    const output = readDocument(wikiDocument(data)).mdx;
    for (const text of markers) assert.ok(output.includes(text), `Case ${sample}: missing ${text}`);
  }
});

test("structured article media retain captions and additional notes beside their source", () => {
  const doc = document(JSON.stringify({ images: [{ url: "https://example.com/image", alt: "PRIMARY-LABEL", description: "EXTRA-DESCRIPTION", caption: "EXTRA-CAPTION" }],
    videos: [{ url: "https://example.com/video", title: "VIDEO-LABEL", transcript: "EXTRA-TRANSCRIPT" }] }));
  const output = readDocument(doc).mdx;
  for (const marker of ["PRIMARY-LABEL", "EXTRA-DESCRIPTION", "EXTRA-CAPTION", "VIDEO-LABEL", "EXTRA-TRANSCRIPT"]) assert.ok(output.includes(marker), marker);
  assert.ok(doc.warnings.some((warning) => warning.code === "UNRECOGNIZED_MEDIA_FIELD"));
});

test("Delta media retain alternative text and distinct notes from operation attributes", () => {
  const warnings = [];
  const ops = [
    { insert: { image: "https://example.com/image" }, attributes: { alt: "ATTRIBUTE-ALT", caption: "ATTRIBUTE-CAPTION", width: "100%" } },
    { insert: { image: { url: "https://example.com/other", alt: "EMBED-ALT", caption: "EMBED-CAPTION" } }, attributes: { alt: "OTHER-ALT", caption: "OTHER-CAPTION" } },
    { insert: { video: { url: "https://example.com/video", title: "VIDEO-TITLE" } }, attributes: { title: "OTHER-TITLE", transcript: "ATTRIBUTE-TRANSCRIPT" } },
    { insert: { image: "javascript:unsafe" }, attributes: { alt: "UNAVAILABLE-ALT" } }
  ];
  const output = quillDeltaToMarkdown(ops, { warnings });
  for (const marker of ["ATTRIBUTE-ALT", "ATTRIBUTE-CAPTION", "EMBED-ALT", "EMBED-CAPTION", "OTHER-ALT", "OTHER-CAPTION",
    "VIDEO-TITLE", "OTHER-TITLE", "ATTRIBUTE-TRANSCRIPT", "UNAVAILABLE-ALT"]) assert.ok(output.includes(marker), marker);
  assert.doesNotMatch(output, /\]\(javascript:|\*\*Width:\*\*/i);
  assert.match(output, /!\[ATTRIBUTE-ALT\]\(https:\/\/example.com\/image\)/);
  assert.ok(warnings.some((warning) => /UNSUPPORTED|UNRECOGNIZED/.test(warning.code)));
  const payload = article("");
  payload.data.post.post.structured_content = JSON.stringify(ops);
  const doc = createDocument(payload, { kind: "article", id: "101", language: "en-us" });
  assert.ok(readDocument(doc).mdx.includes("ATTRIBUTE-CAPTION"));
  assert.equal(doc.metadata.body_source, "quill-delta");
});

test("retained article and Wiki metadata obey the same bounded complexity rules as structured bodies", () => {
  let nested = "VALUE";
  for (let depth = 0; depth < 80; depth += 1) nested = { nested };
  const tooComplex = (error) => error.code === "DOCUMENT_TOO_COMPLEX" && !(error instanceof RangeError);
  for (const field of ["available_languages", "author", "version"]) {
    const payload = field === "version" ? wiki({ list: [] }) : article("READABLE BODY");
    if (field === "version") payload.data.page.version = nested;
    else if (field === "author") payload.data.post.user = { nickname: nested };
    else payload.data.post.post.multi_language_info = { langs: nested };
    const options = { kind: field === "version" ? "wiki" : "article", id: field === "version" ? "202" : "101", wikiApp: "genshin", language: "en-us" };
    assert.throws(() => createDocument(payload, options), tooComplex, field);
    assert.throws(() => (field === "version" ? wikiToMdx : articleToMdx)(payload, options), tooComplex, field);
  }
  const manyLanguages = article("BODY");
  manyLanguages.data.post.post.multi_language_info = { langs: Array.from({ length: 50000 }, () => "en-us") };
  assert.throws(() => createDocument(manyLanguages, { kind: "article", id: "101", language: "en-us" }), tooComplex);
});

test("compact block ranges merge overlaps, preserve ordering and respect exact scope", () => {
  const doc = document("<h2>First</h2><p>First A.</p><p>First B.</p><h2>Second</h2><p>Second A.</p><p>Second B.</p><p>Second C.</p>");
  const ranges = [[4, 5], [1, 2], [2, 2]];
  const original = structuredClone(ranges);
  const result = readDocument(doc, { block_ranges: ranges });
  assert.deepEqual(result.blocks.map((block) => block.index), [1, 2, 4, 5]);
  assert.equal(result.coverage.scope, "selection");
  assert.deepEqual(ranges, original);
  assert.throws(() => readDocument(doc, { block_ranges: [[1, 2]], section: "Section: Second" }), (error) => error.code === "BLOCK_NOT_FOUND");
  assert.throws(() => readDocument(doc, { block_ranges: [[6, 6]] }), (error) => error.code === "BLOCK_NOT_FOUND");
  for (const options of [{ block_ranges: [] }, { block_ranges: [[3, 1]] }, { block_ranges: [[0, 1]] }, { block_ranges: [[1.5, 2]] },
    { block_ranges: [[1, 1]], block_ids: ["b1"] }, { block_ranges: [[1, 1]], table_block: "b1" }, { block_ranges: [[1, 1]], view: "outline" }]) {
    assert.throws(() => validateDocumentSelection(options), (error) => error.code === "INVALID_SELECTION");
  }
  const search = readDocument(doc, { block_ranges: [[3, 4]], view: "search", query: "second", context_blocks: 0 });
  assert.deepEqual(search.blocks.map((block) => block.index), [3, 4]);
});

test("range continuations keep a sparse exact selection within the output budget", () => {
  const doc = document(Array.from({ length: 200 }, (_, index) => `<p>PARA-${index}: ${"detail ".repeat(20)}</p>`).join(""));
  const seen = [];
  let args = { block_ranges: [[1, 70], [101, 180]], max_chars: 4000 };
  for (let page = 0; page < 50; page += 1) {
    const result = readDocument(doc, args);
    assert.ok(result.mdx.length <= 4000);
    seen.push(...result.blocks.map((block) => block.index));
    if (!result.continuation) break;
    assert.ok(result.blocks.length > 0);
    assert.ok(result.continuation.block_ranges.length <= 2);
    args = result.continuation;
  }
  assert.deepEqual(seen, [...Array.from({ length: 70 }, (_, index) => index + 1), ...Array.from({ length: 80 }, (_, index) => index + 101)]);
});
