import test from "node:test";
import assert from "node:assert/strict";

import {
  articleToMdx,
  detectKind,
  quillDeltaToMarkdown,
  richTextToMarkdown,
  wikiHierarchy,
  wikiLocationToMdx,
  wikiToMdx
} from "../src/transform/hoyolab-mdx.mjs";

test("converts article HTML to compact Markdown and removes executable markup", () => {
  const output = articleToMdx({
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "123",
          game_id: 2,
          subject: "A <hoyolab>highlighted</hoyolab> title",
          content: "<h2>Overview</h2><p>Hello <strong>Traveler</strong>.</p><script>alert(1)</script><ul><li>One</li><li>Two</li></ul>"
        },
        user: { nickname: "Author" },
        game: { game_name: "Genshin Impact" }
      }
    }
  });

  assert.equal(detectKind({ retcode: 0, data: { post: { post: { post_id: "1" } } } }), "article");
  assert.match(output, /^---\n/);
  assert.match(output, /title: A highlighted title/);
  assert.match(output, /body_source: html/);
  assert.match(output, /# Article: A highlighted title/);
  assert.match(output, /## Article body/);
  assert.match(output, /### Section: Overview/);
  assert.match(output, /Hello \*\*Traveler\*\*\./);
  assert.match(output, /-\s+One/);
  assert.doesNotMatch(output, /script|alert/);
});

test("uses Quill Delta when content is only a locale placeholder", () => {
  const output = articleToMdx({
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "45842980",
          subject: "Paimon's Paintings",
          content: "en-us",
          structured_content: JSON.stringify([
            { insert: "Summary" },
            { insert: "\n", attributes: { header: 2, align: "center" } },
            { insert: "Greetings, " },
            { insert: "Travelers", attributes: { bold: true } },
            { insert: "! Visit " },
            { insert: "HoYoLAB", attributes: { link: "https://www.hoyolab.com" } },
            { insert: "\n" },
            { insert: "First item" },
            { insert: "\n", attributes: { list: "ordered" } },
            { insert: "Second item" },
            { insert: "\n", attributes: { list: "ordered" } },
            { insert: { image: "https://example.com/image.png" } },
            { insert: { divider: "line_1" } },
            { insert: { video: "https://www.youtube.com/embed/example" } },
            { insert: { vote: { title: "Choose one", vote_options: ["A", "B"], vote_limit: 1, end_time: "1786112936", status: "VoteStatusPublished" } } },
            { insert: { card_group: { article_cards: [{ meta: { meta_id: "99" }, info: { title: "Related", view_num: "42" }, user: { nickname: "Author" } }] } } }
          ])
        },
        user: { nickname: "Author" },
        game: { game_name: "Genshin Impact" }
      }
    }
  });

  assert.match(output, /body_source: quill-delta/);
  assert.doesNotMatch(output, /^en-us$/m);
  assert.match(output, /# Article: Paimon's Paintings/);
  assert.match(output, /## Article body/);
  assert.match(output, /### Section: Summary/);
  assert.match(output, /Greetings, \*\*Travelers\*\*! Visit \[HoYoLAB\]\(https:\/\/www\.hoyolab\.com\/\)/);
  assert.match(output, /1\. First item/);
  assert.match(output, /2\. Second item/);
  assert.match(output, /!\[Image\]\(https:\/\/example\.com\/image\.png\)/);
  assert.match(output, /---/);
  assert.match(output, /\[Video\]\(https:\/\/www\.youtube\.com\/embed\/example\)/);
  assert.match(output, /\*\*Poll:\*\* Choose one/);
  assert.match(output, /\*\*Related articles\*\*/);
});

test("preserves multilingual article metadata from the selected API response", () => {
  const output = articleToMdx({
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "1",
          subject: "日本語タイトル",
          lang: "ja-jp",
          origin_lang: "en-us",
          is_multi_language: true,
          multi_language_info: { langs: ["en-us", "ja-jp"] },
          structured_content: JSON.stringify([{ insert: "日本語本文\n" }])
        }
      }
    }
  }, { language: "ja-jp" });

  assert.match(output, /language: ja-jp/);
  assert.match(output, /api_origin_lang: en-us/);
  assert.match(output, /is_multilingual: true/);
  assert.match(output, /available_languages:/);
  assert.match(output, /日本語本文/);
});

test("renders Quill Delta block attributes as Markdown", () => {
  const output = quillDeltaToMarkdown([
    { insert: "Heading" },
    { insert: "\n", attributes: { header: 3 } },
    { insert: "Bullet" },
    { insert: "\n", attributes: { list: "bullet" } }
  ]);
  assert.equal(output, "### Heading\n- Bullet");

  const textAttachedOutput = quillDeltaToMarkdown([
    { insert: "Text-attached heading", attributes: { header: 2 } },
    { insert: "\n" }
  ]);
  assert.equal(textAttachedOutput, "## Text-attached heading");

  const replyOutput = quillDeltaToMarkdown([
    { insert: "Reply text" },
    { insert: { backup: { type: "text", text: "[emoji]" }, emoticon: { url: "https://example.com/emoji.png" } } },
    { insert: "\n" }
  ]);
  assert.equal(replyOutput, "Reply text![Emoji](https://example.com/emoji.png)");
});

test("falls back from unusable structured text and identifies the actual body source", () => {
  assert.deepEqual(
    richTextToMarkdown({
      content: "<p>HTML fallback</p>",
      structuredContent: JSON.stringify([{ insert: { unsupported: {} } }])
    }),
    { body: "HTML fallback", source: "html" }
  );
});

test("converts legacy JSON article bodies into paragraphs, tables, media, and links", () => {
  const content = JSON.stringify({
    describe: "First paragraph\n\nSecond paragraph",
    table: {
      headers: ["Before", "After"],
      rows: [["Old value", "New value"]]
    },
    imgs: ["https://example.com/article.png"],
    video: "https://www.youtube.com/embed/article"
  });
  const result = richTextToMarkdown({ content });

  assert.equal(result.source, "json-content");
  assert.match(result.body, /First paragraph\n\nSecond paragraph/);
  assert.match(result.body, /\| Before \| After \|/);
  assert.match(result.body, /\| Old value \| New value \|/);
  assert.match(result.body, /!\[Image\]\(https:\/\/example\.com\/article\.png\)/);
  assert.match(result.body, /\[Video\]\(https:\/\/www\.youtube\.com\/embed\/article\)/);
  assert.doesNotMatch(result.body, /\{\s*["']describe["']/);

  const output = articleToMdx({
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "42626259",
          subject: "Legacy JSON article",
          content
        }
      }
    }
  });
  assert.match(output, /body_source: json-content/);
  assert.match(output, /## Article body/);
  assert.match(output, /First paragraph/);
  assert.match(output, /\| Before \| After \|/);
  assert.doesNotMatch(output, /\{\s*["']describe["']/);
});

test("keeps HTML article paragraphs and tables when Delta only contains partial content", () => {
  const result = richTextToMarkdown({
    content: "<p>Paragraph from HTML</p><table><tbody><tr><td><p><strong>Before</strong></p></td><td><p><strong>After</strong></p></td></tr><tr><td>Old</td><td>New</td></tr></tbody></table>",
    structuredContent: JSON.stringify([{ insert: "Only partial Delta content" }, { insert: "\n" }])
  });

  assert.equal(result.source, "html");
  assert.match(result.body, /Paragraph from HTML/);
  assert.match(result.body, /\| Before \| After \|/);
  assert.match(result.body, /\| Old \| New \|/);
  assert.doesNotMatch(result.body, /<\/?(?:table|tbody|tr|td|p|strong)\b/i);
});

test("converts Wiki modules, tables, linked items, media, and custom HTML", () => {
  const output = wikiToMdx({
    retcode: 0,
    data: {
      page: {
        id: "49",
        name: "Raiden Shogun",
        desc: "Her Excellency.<br>Welcome to Inazuma!",
        menu_name: "Character Archive",
        version: "1751691221",
        status: "Online",
        icon_url: "https://example.com/icon.png",
        header_img_url: "https://example.com/header.png",
        modules: [
          {
            name: "Attributes",
            components: [{
              component_id: "baseInfo",
              data: JSON.stringify({ list: [
                { key: "Name", value: ["Raiden Shogun"] },
                { key: "Namecard", value: ["$[{\"ep_id\":6158,\"name\":\"Raiden Shogun: Enlightenment\",\"amount\":0}]$"] },
                { key: "Version Released", value: ["<p>2.1</p>"] }
              ] })
            }]
          },
          {
            name: "Ascend",
            components: [{
              component_id: "ascension",
              data: JSON.stringify({ list: [{
                key: "Lv.20",
                combatList: [
                  { key: "", values: ["Before", "After"] },
                  { key: "Base HP", values: ["2606", "3468"] }
                ],
                materials: ["$[{\"ep_id\":757,\"nickname\":\"Mora\",\"amount\":20000}]$"]
              }] })
            }]
          },
          {
            name: "Gallery",
            components: [{
              component_id: "gallery_character",
              data: JSON.stringify({ list: [{ key: "Avatar", img: "https://example.com/avatar.png", imgDesc: "Original outfit" }] })
            }]
          },
          {
            name: "Media",
            components: [{
              component_id: "customize",
              data: JSON.stringify({ data: "<h3>Announcement</h3><custom-image url=\"https://example.com/media.png\"></custom-image><custom-entry epid=\"2046\" name=\"Aquila Favonia\"></custom-entry><custom-post posts=\"123\"></custom-post>" })
            }]
          }
        ]
      }
    }
  }, { wikiApp: "genshin" });

  assert.equal(detectKind({ retcode: 0, data: { page: { modules: [] } } }), "wiki");
  assert.match(output, /# Raiden Shogun/);
  assert.match(output, /icon_url: https:\/\/example\.com\/icon\.png/);
  assert.match(output, /header_img_url: https:\/\/example\.com\/header\.png/);
  assert.match(output, /!\[Page header\]\(https:\/\/example\.com\/header\.png\)/);
  assert.match(output, /## 1\. Attributes/);
  assert.match(output, /### 1\.1\. Base Info/);
  assert.match(output, /- 1\.1\.1\. \*\*Name:\*\*/);
  assert.match(output, /\*\*Name:\*\* Raiden Shogun/);
  assert.match(output, /\[Raiden Shogun: Enlightenment\]\(https:\/\/wiki\.hoyolab\.com\/pc\/genshin\/entry\/6158\)/);
  assert.match(output, /\*\*Version Released:\*\* 2\.1/);
  assert.match(output, /\| Field \| Before \| After \|/);
  assert.match(output, /\*\*Materials:\*\* \[Mora\]\(https:\/\/wiki\.hoyolab\.com\/pc\/genshin\/entry\/757\) ×20000/);
  assert.match(output, /!\[Avatar\]\(https:\/\/example\.com\/avatar\.png\)/);
  assert.match(output, /\[Aquila Favonia\]\(https:\/\/wiki\.hoyolab\.com\/pc\/genshin\/entry\/2046\)/);
  assert.match(output, /\[HoYoLAB article 123\]\(https:\/\/www\.hoyolab\.com\/article\/123\)/);
});

test("numbers and scopes Wiki hierarchy elements", () => {
  const payload = {
    retcode: 0,
    data: {
      page: {
        id: "7",
        name: "Numbered entry",
        modules: [{
          name: "Details",
          components: [{
            component_id: "customize",
            data: JSON.stringify({ list: [
              { title: "First", desc: "One" },
              { title: "Second", desc: "Two" }
            ] })
          }]
        }]
      }
    }
  };

  const hierarchy = wikiHierarchy(payload, { wikiApp: "genshin" });
  assert.equal(hierarchy.modules[0].label, "1. Details");
  assert.equal(hierarchy.modules[0].components[0].label, "1.1. Customize");
  assert.equal(hierarchy.modules[0].components[0].items[0].label, "1.1.1. First");

  const scoped = wikiLocationToMdx(payload, { wikiApp: "genshin" }, {
    module: "module[1]",
    component: "module[1].component[1]"
  });
  assert.match(scoped, /## 1\. Details/);
  assert.match(scoped, /### 1\.1\. Customize/);
  assert.match(scoped, /#### 1\.1\.1\. /);
  assert.throws(
    () => wikiLocationToMdx(payload, { wikiApp: "genshin" }, { module: "module[1]", component: "module[2].component[1]" }),
    /does not belong to module\[1\]/
  );
});

test("converts Wiki HTML tables without leaving raw HTML tags", () => {
  const output = wikiToMdx({
    retcode: 0,
    data: {
      page: {
        id: "1",
        name: "Table example",
        modules: [{
          name: "Details",
          components: [{
            component_id: "customize",
            data: JSON.stringify({
              data: "<table><tbody><tr><td><p>Cell A</p></td><td><p><strong>Cell B</strong></p></td></tr></tbody></table>"
            })
          }]
        }]
      }
    }
  });

  assert.match(output, /Cell A/);
  assert.match(output, /\*\*Cell B\*\*/);
  assert.doesNotMatch(output, /^\| /m);
  assert.doesNotMatch(output, /Column \d/);
  assert.doesNotMatch(output, /<\/?(?:table|tbody|tr|td|p|strong|br)\b/i);
});

test("infers headers only for simple Wiki HTML data tables", () => {
  const output = wikiToMdx({
    retcode: 0,
    data: {
      page: {
        id: "2",
        name: "Data table example",
        modules: [{
          name: "Details",
          components: [{
            component_id: "customize",
            data: JSON.stringify({
              data: "<table><tbody><tr><td><p><strong>Item</strong></p></td><td><p><strong>Cost</strong></p></td><td><p><strong>Stock</strong></p></td></tr><tr><td>Mora</td><td>100</td><td>30</td></tr></tbody></table>"
            })
          }]
        }]
      }
    }
  });

  assert.match(output, /\| Item \| Cost \| Stock \|/);
  assert.match(output, /\| Mora \| 100 \| 30 \|/);
  assert.doesNotMatch(output, /Column \d/);
});

test("short article bodies and HTML-only media are not locale placeholders", () => {
  for (const content of ["Hi", "Yes", "OK", "en", "ja", "<p>en-us</p>"]) {
    const result = richTextToMarkdown({ content });
    assert.equal(result.source, "html");
    assert.equal(result.body, content.replace(/<\/?p>/g, ""));
  }
  const media = richTextToMarkdown({ content: '<p><img src="https://example.com/image.png" alt="Only image"></p>' });
  assert.equal(media.source, "html");
  assert.match(media.body, /!\[Only image\]\(https:\/\/example\.com\/image\.png\)/);
  assert.equal(richTextToMarkdown({ content: "en-us", structuredContent: JSON.stringify([{ insert: "Real Delta body\n" }]) }).source, "quill-delta");
});

test("JSON table cells, row conditions and header/table metadata survive with warnings", () => {
  const warnings = [];
  const result = richTextToMarkdown({ content: JSON.stringify({ table: {
    caption: "Scaling caption", unit: "percent", notes: "Only while active",
    columns: [{ key: "level", title: "Level", note: "Measured at full stacks" }, { key: "damage", title: "Damage" }],
    rows: [{ level: "10", damage: { text: "42%", condition: "One target" }, note: "Row condition A" }]
  } }) }, { warnings });
  for (const text of ["Scaling caption", "percent", "Only while active", "Measured at full stacks", "42%", "One target", "Row condition A"]) {
    assert.ok(result.body.includes(text), text);
  }
  assert.match(result.body, /\| Level \| Damage \|/);
  assert.ok(warnings.some((warning) => warning.code === "UNSUPPORTED_TABLE_CELL"));
  assert.ok(warnings.some((warning) => warning.code === "UNRECOGNIZED_TABLE_FIELD"));
});

test("HTML data and layout tables retain captions without forcing layout into a table", () => {
  const data = richTextToMarkdown({ content: "<table><caption>Values in percent</caption><tr><th>Level</th><th>Damage</th></tr><tr><td>10</td><td>42</td></tr></table>" });
  assert.match(data.body, /Values in percent/);
  assert.match(data.body, /\| Level \| Damage \|/);
  const layout = richTextToMarkdown({ content: "<table><caption>Owner note</caption><tr><td>Single decorative cell</td></tr></table>" });
  assert.match(layout.body, /Owner note/);
  assert.match(layout.body, /Single decorative cell/);
  assert.doesNotMatch(layout.body, /^\|/m);
});

test("mixed Wiki lists and attribute/material extras preserve every item", () => {
  const output = wikiToMdx({ retcode: 0, data: { page: { id: "9", name: "Mixed entry", modules: [{ name: "Details", components: [
    { component_id: "customize", data: JSON.stringify({ list: [{ key: "HP", values: ["100", "200"], note: "At level 10" }, { title: "Ordinary skill", desc: "Required ordinary description" }] }) },
    { component_id: "baseInfo", data: JSON.stringify({ list: [{ key: "Threshold", value: ["42%"], note: "Does not stack" }] }) },
    { component_id: "talent", data: JSON.stringify({ list: [{ title: "Damage skill", desc: "Damage description", attributes: [{ key: "Scaling", value: ["55%"], note: "Single target" }], materials: ["20 plain material", "$[{\"ep_id\":8,\"name\":\"Linked material\",\"amount\":2}]$"] }] }) }
  ] }] } } });
  for (const text of ["100", "200", "At level 10", "Ordinary skill", "Required ordinary description", "42%", "Does not stack", "Scaling", "55%", "Single target", "20 plain material", "Linked material"]) {
    assert.ok(output.includes(text), text);
  }
  assert.doesNotMatch(output, /^\| Field \|/m);
});

test("HTML and inline code literals remain intact while prose markup is converted", () => {
  const result = richTextToMarkdown({ content: "<p>Prose <strong>value</strong>, <code>&lt;p&gt;literal&lt;/p&gt;</code>.</p><pre><code># code heading\n&lt;p&gt;example&lt;/p&gt;\n\n\nsecond line</code></pre>" });
  assert.match(result.body, /Prose \*\*value\*\*/);
  assert.match(result.body, /`<p>literal<\/p>`/);
  assert.match(result.body, /# code heading\n<p>example<\/p>\n\n\nsecond line/);
  const payload = { retcode: 0, data: { page: { id: "9", name: "Code entry", modules: [{ name: "Code", components: [{ component_id: "customize", data: JSON.stringify({ data: "<pre><code># comment\n&lt;p&gt;example&lt;/p&gt;</code></pre><h3>Actual heading</h3><p>Body</p>" }) }] }] } } };
  const output = wikiToMdx(payload);
  assert.match(output, /\n# comment\n<p>example<\/p>/);
  assert.doesNotMatch(output, /\d+\.\d+\.\d+\. comment/);
  const items = wikiHierarchy(payload).modules[0].components[0].items;
  assert.equal(items.length, 1);
  assert.ok(items[0].label.includes("Actual heading"));
});

test("Delta code blocks retain raw content, blank lines and an unambiguous fence", () => {
  const output = quillDeltaToMarkdown([
    { insert: "# literal heading\n\n<p>example</p>\n```", attributes: { "code-block": "html" } },
    { insert: "\n", attributes: { "code-block": "html" } },
    { insert: "Ordinary paragraph.\n" }
  ]);
  assert.match(output, /^````html\n# literal heading\n\n<p>example<\/p>\n```\n````\n/);
  assert.match(output, /Ordinary paragraph\.$/);
});

test("unsafe HTML image URLs are removed and valid image labels stay readable", () => {
  const result = richTextToMarkdown({ content: '<img src="javascript:alert(1)" alt="Unsafe image"><img src="data:image/svg+xml,example" alt="Inline image"><img src="https://example.com/image.png" alt="Safe [image]">' });
  assert.doesNotMatch(result.body, /javascript:|data:/);
  assert.match(result.body, /Unsafe image/);
  assert.match(result.body, /Inline image/);
  assert.match(result.body, /https:\/\/example\.com\/image\.png/);
});

test("overly deep or wide structured content fails with DOCUMENT_TOO_COMPLEX", () => {
  let nested = { text: "Deep content" };
  for (let depth = 0; depth < 2000; depth += 1) nested = { content: nested };
  assert.throws(() => richTextToMarkdown({ content: JSON.stringify(nested) }), (error) => error.code === "DOCUMENT_TOO_COMPLEX");
  assert.throws(() => richTextToMarkdown({ content: JSON.stringify({ blocks: Array.from({ length: 26000 }, () => ({ text: "Wide" })) }) }), (error) => error.code === "DOCUMENT_TOO_COMPLEX");
});
