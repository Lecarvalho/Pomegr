import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DocsMarkdown } from "../../app/docs/render-markdown";
import type { DocsBlock, DocsContent, DocsInline } from "../../scripts/docs-content.mjs";
import { FENCE, IMAGE_HEIGHT, IMAGE_WIDTH, alphaWith, cleanupScratch, loaded, pageOf, rejected, standard } from "./docs-fixtures";

afterEach(cleanupScratch);

const text = (value: string): DocsInline => ({ type: "text", text: value });
const code = (value: string): DocsInline => ({ type: "code", text: value });
const paragraph = (...children: DocsInline[]): DocsBlock => ({ type: "paragraph", children });
const link = (href: string, external: boolean, label = "label"): DocsInline => ({ type: "link", href, external, children: [text(label)] });
const render = (blocks: DocsBlock[], strict = true) => renderToStaticMarkup(<DocsMarkdown blocks={blocks} strict={strict} />);
const unknownBlock = (value: unknown) => value as DocsBlock;
const unknownInline = (value: unknown) => value as DocsInline;
const count = (html: string, needle: string) => html.split(needle).length - 1;
const tagsOf = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const attributesOf = (tag: string) => Object.fromEntries([...tag.matchAll(/\s([a-z][\w-]*)="([^"]*)"/g)].map((match) => [match[1], match[2]]));

describe("headings", () => {
  const headings = render([1, 2, 3, 4].map((depth) => ({
    type: "heading" as const,
    depth: depth as 1 | 2 | 3 | 4,
    id: `level-${depth}`,
    children: [text(`Level ${depth}`)],
  })));

  it("renders h1 to h4 with the generated id set directly on the element", () => {
    for (const depth of [1, 2, 3, 4]) expect(headings).toContain(`<h${depth} id="level-${depth}">Level ${depth}</h${depth}>`);
  });

  it("gives every heading below the title an accessible self-link outside the heading text", () => {
    expect(headings).not.toContain('href="#level-1"');
    for (const depth of [2, 3, 4]) {
      expect(headings).toMatch(new RegExp(`</h${depth}><a [^>]*href="#level-${depth}" aria-label="Link to this section: Level ${depth}"><span aria-hidden="true">#</span></a>`));
    }
    expect(count(headings, "Link to this section")).toBe(3);
  });

  it("builds the permalink label from the visible heading text, not its markup", () => {
    const html = render([{ type: "heading", depth: 2, id: "a-b", children: [text("A "), code("b"), { type: "strong", children: [text(" c")] }] }]);
    expect(html).toContain('aria-label="Link to this section: A b c"');
    expect(html).toContain("<h2 id=\"a-b\">A <code");
  });

  it("keeps a heading with an unusable id but drops its permalink (and fails loudly when strict)", () => {
    const heading: DocsBlock = { type: "heading", depth: 2, id: "bad id", children: [text("Title")] };
    const html = render([heading], false);
    expect(html).toContain("<h2>Title</h2>");
    expect(html).not.toContain("<a ");
    expect(() => render([heading])).toThrow(/heading anchor/);
  });
});

describe("text blocks and inlines", () => {
  it("renders paragraphs with code, strong, em, br, and nested emphasis", () => {
    const html = render([
      paragraph(
        text("Plain "),
        code("npm test"),
        text(" "),
        { type: "strong", children: [text("bold "), { type: "em", children: [text("both")] }] },
        { type: "br" },
        { type: "em", children: [text("italic")] },
      ),
    ]);
    expect(html).toMatch(/<p>Plain <code[^>]*>npm test<\/code> <strong>bold <em>both<\/em><\/strong><br\/><em>italic<\/em><\/p>/);
  });

  it("always escapes text, code, and alt text as text", () => {
    const hostile = '<script>alert("x")</script> & <img src=x onerror=y>';
    const html = render([
      paragraph(text(hostile), code(hostile)),
      { type: "codeblock", lang: "text", text: hostile },
      { type: "callout", kind: "note", blocks: [paragraph(text(hostile))] },
    ]);
    expect(html).not.toMatch(/<script|<img src=x/);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=y&gt;");
  });

  it("renders a quote with its own blocks", () => {
    const html = render([{ type: "quote", blocks: [paragraph(text("First")), paragraph(text("Second"))] }]);
    expect(html).toMatch(/<blockquote[^>]*><p>First<\/p><p>Second<\/p><\/blockquote>/);
  });
});

describe("lists", () => {
  it("renders unordered, ordered, and nested lists with block items", () => {
    const html = render([
      {
        type: "list",
        ordered: false,
        start: null,
        items: [
          [paragraph(text("One")), { type: "list", ordered: true, start: 1, items: [[paragraph(text("Nested"))]] }],
          [paragraph(text("Two"))],
        ],
      },
    ]);
    expect(html).toMatch(/<ul[^>]*><li><p>One<\/p><ol[^>]*><li><p>Nested<\/p><\/li><\/ol><\/li><li><p>Two<\/p><\/li><\/ul>/);
    expect(html).not.toContain(" start=");
  });

  it("keeps a start number other than 1", () => {
    const html = render([{ type: "list", ordered: true, start: 3, items: [[paragraph(text("Third"))]] }]);
    expect(html).toMatch(/<ol [^>]*start="3"/);
  });
});

describe("tables", () => {
  const table = render([
    {
      type: "table",
      align: ["left", "center", "right", null],
      header: [[text("Name")], [text("Status")], [text("Count")], [text("Note")]],
      rows: [
        [[text("a")], [code("ok")], [text("1")], [text("x")]],
        [[text("b")], [text("late")], [text("2")], [text("y")]],
      ],
    },
  ]);

  it("wraps the table in a named, focusable, scrollable region", () => {
    expect(table).toMatch(/<div [^>]*role="region" aria-label="Table: Name, Status, Count, Note" tabindex="0"><table /);
    expect(count(table, "<table")).toBe(1);
  });

  it("uses thead with column-scoped headers and a tbody of cells", () => {
    expect(table).toMatch(/<thead><tr><th scope="col"[^>]*>Name<\/th>/);
    expect(count(table, 'scope="col"')).toBe(4);
    expect(count(table, "<th ")).toBe(4);
    expect(table).toMatch(/<tbody><tr><td[^>]*>a<\/td>/);
    expect(count(table, "<td")).toBe(8);
  });

  it("applies column alignment through classes, never inline styles", () => {
    expect(table).toMatch(/<th scope="col" class="[^"]*alignCenter[^"]*">Status/);
    expect(table).toMatch(/<td class="[^"]*alignRight[^"]*">1<\/td>/);
    expect(table).not.toMatch(/style=|align=/);
  });

  it("truncates a very long accessible name", () => {
    const header = Array.from({ length: 30 }, (_, index) => [text(`Column ${index}`)]);
    const html = render([{ type: "table", align: header.map(() => null), header, rows: [] }]);
    const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith("...")).toBe(true);
  });
});

describe("code blocks", () => {
  it("renders a keyboard-focusable pre with a language class and verbatim text", () => {
    const html = render([{ type: "codeblock", lang: "powershell", text: "Get-ChildItem\n  -Path .\n" }]);
    expect(html).toMatch(/<pre [^>]*tabindex="0"><code class="language-powershell">Get-ChildItem\n {2}-Path \.\n<\/code><\/pre>/);
  });

  it("rejects a language that is not a plain identifier", () => {
    const block: DocsBlock = { type: "codeblock", lang: 'x" onclick="y', text: "a" };
    expect(render([block], false)).toMatch(/<code>a<\/code>/);
    expect(() => render([block])).toThrow(/code language/);
  });
});

describe("callouts", () => {
  it("labels a note and a caution visibly and marks them as notes", () => {
    const html = render([
      { type: "callout", kind: "note", blocks: [paragraph(text("Context is a snapshot."))] },
      { type: "callout", kind: "caution", blocks: [paragraph(text("Close the app first.")), { type: "list", ordered: false, start: null, items: [[paragraph(text("item"))]] }] },
    ]);
    expect(html).toMatch(/<div class="[^"]*callout[^"]*note[^"]*" role="note"><p class="[^"]*calloutLabel[^"]*">Note<\/p><p>Context is a snapshot\.<\/p><\/div>/);
    expect(html).toMatch(/<div class="[^"]*callout[^"]*caution[^"]*" role="note"><p class="[^"]*calloutLabel[^"]*">Caution<\/p><p>Close the app first\.<\/p><ul/);
    expect(count(html, 'role="note"')).toBe(2);
  });

  it("rejects an unknown callout kind", () => {
    const block = unknownBlock({ type: "callout", kind: "tip", blocks: [] });
    expect(render([block], false)).not.toContain("note");
    expect(() => render([block])).toThrow(/callout kind/);
  });
});

describe("links", () => {
  it("renders docs routes and in-page anchors as ordinary same-tab links", () => {
    const html = render([paragraph(link("/docs/concepts/cache-reuse", false), link("/docs/get-started/install#step-one", false), link("#local-anchor", false))]);
    expect(html).toContain('href="/docs/concepts/cache-reuse"');
    expect(html).toContain('href="/docs/get-started/install#step-one"');
    expect(html).toContain('href="#local-anchor"');
    expect(html).not.toMatch(/target=|rel=/);
  });

  it("opens external web links in a new tab with noopener noreferrer and announces it", () => {
    const html = render([paragraph(link("https://github.com/Lecarvalho/pomegr", true, "Source"), link("http://example.com/a?b=1#c", true, "Plain"))]);
    expect(count(html, 'target="_blank" rel="noopener noreferrer"')).toBe(2);
    expect(html).toMatch(/Source<span class="[^"]*visuallyHidden[^"]*"> \(opens in a new tab\)<\/span>/);
    expect(html).toContain('href="http://example.com/a?b=1#c"');
  });

  it("renders mailto links without a new-tab target", () => {
    const html = render([paragraph(link("mailto:hello@example.com", true, "Write"))]);
    expect(html).toContain('href="mailto:hello@example.com"');
    expect(html).not.toContain("target=");
  });

  it("renders link content such as emphasis and images inside the anchor", () => {
    const html = render([paragraph({ type: "link", href: "/docs/concepts/cache-reuse", external: false, children: [{ type: "strong", children: [text("Cache")] }, text(" reuse")] })]);
    expect(html).toMatch(/<a [^>]*href="\/docs\/concepts\/cache-reuse"><strong>Cache<\/strong> reuse<\/a>/);
  });

  it.each([
    ["a page outside the published docs routes", "/internal/plans/migration", false],
    ["a repository-relative Markdown path", "../internal/plans/x.md", false],
    ["a protocol-relative URL", "//evil.example/x", false],
    ["an unsafe scheme", "javascript:alert(1)", true],
    ["a data URL", "data:text/html,x", true],
    ["an internal route marked external", "/docs/concepts/cache-reuse", true],
    ["an empty destination", "", false],
  ])("drops the anchor for %s but keeps the text (and fails loudly when strict)", (_name, href, external) => {
    const block = paragraph(link(href, external, "kept text"));
    const html = render([block], false);
    expect(html).toContain("kept text");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(() => render([block])).toThrow(/link destination/);
  });
});

describe("images", () => {
  it("renders an image with alt text, its pixel size, lazy loading, and async decoding", () => {
    const html = render([paragraph({ type: "image", src: "/docs/images/cache-reuse/refill.jpg", width: 1200, height: 675, alt: 'Cache "reads" drop after <compaction>' }), paragraph({ type: "em", children: [text("Figure: a caption.")] })]);
    expect(html).toMatch(/<p class="[^"]*imageBlock[^"]*"><img class="[^"]*" src="\/docs\/images\/cache-reuse\/refill\.jpg" alt="Cache &quot;reads&quot; drop after &lt;compaction&gt;" width="1200" height="675" loading="lazy" decoding="async"\/><\/p>/);
    expect(html).toContain("<p><em>Figure: a caption.</em></p>");
  });

  it.each([
    ["an external URL", "https://example.com/x.png"],
    ["a route outside the docs image folder", "/landing/about/x.png"],
    ["a traversal", "/docs/images/topic/../../secret.png"],
    ["a non-image file", "/docs/images/topic/file.svg"],
  ])("rejects %s as an image source", (_name, src) => {
    const block = paragraph({ type: "image", src, width: 3, height: 2, alt: "Alt" });
    expect(render([block], false)).not.toContain("<img");
    expect(() => render([block])).toThrow(/image/);
  });

  it("rejects an image without alt text", () => {
    expect(() => render([paragraph({ type: "image", src: "/docs/images/topic/a.jpg", width: 3, height: 2, alt: " " })])).toThrow(/image/);
  });

  it.each([
    ["a missing size", undefined, undefined],
    ["a zero width", 0, 2],
    ["a fractional height", 3, 1.5],
    ["a size given as text", "3", "2"],
  ])("rejects an image with %s", (_name, width, height) => {
    const block = paragraph(unknownInline({ type: "image", src: "/docs/images/topic/a.jpg", width, height, alt: "Alt" }));
    expect(render([block], false)).not.toContain("<img");
    expect(() => render([block])).toThrow(/image/);
  });
});

describe("unknown nodes", () => {
  it("renders nothing for an unknown block or inline in production mode and fails loudly when strict", () => {
    const html = render([unknownBlock({ type: "html", text: "<b>raw</b>" }), paragraph(text("Before "), unknownInline({ type: "html", text: "<i>raw</i>" }), text("after"))], false);
    expect(html).toMatch(/<p>Before after<\/p>/);
    expect(html).not.toMatch(/raw|<b>|<i>/);
    expect(() => render([unknownBlock({ type: "html", text: "<b>raw</b>" })])).toThrow(/block type "html"/);
    expect(() => render([paragraph(unknownInline({ type: "html", text: "x" }))])).toThrow(/inline type "html"/);
    expect(() => render([unknownBlock({ type: "hr" })])).toThrow(/Unsupported documentation/);
    expect(() => render([unknownBlock(null)])).toThrow(/Unsupported documentation/);
  });

  it("never puts node content in the error", () => {
    let message = "";
    try {
      render([unknownBlock({ type: "secret-token-value", text: "TOKEN_SENTINEL" })]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Unsupported documentation block type");
    expect(message).not.toContain("TOKEN_SENTINEL");
  });

  it("defaults to production behavior when strict is omitted", () => {
    const html = renderToStaticMarkup(<DocsMarkdown blocks={[unknownBlock({ type: "html" }), paragraph(text("ok"))]} />);
    expect(html).toMatch(/<p>ok<\/p>/);
  });
});

describe("the renderer source", () => {
  const source = readFileSync(new URL("../../app/docs/render-markdown.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../app/docs/markdown.module.css", import.meta.url), "utf8");

  it("has no raw-HTML path", () => {
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|__html|createContextualFragment|insertAdjacentHTML/);
  });

  it("imports only types from the build-time loader", () => {
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, isType, specifier] of imports) {
      if (specifier.includes("scripts/")) expect(isType).toBeTruthy();
    }
    for (const [, , specifier] of imports) expect(specifier).not.toMatch(/generated|docs-content\.json/);
  });

  it("gives heading permalinks a 44 px hit area on touch without changing their 28 px box", () => {
    expect(css).toMatch(/\.anchor\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px/);
    const touch = /@media \(hover: none\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(touch).toMatch(/\.anchor\s*\{[^}]*position:\s*relative;[^}]*opacity:\s*1/);
    // 28 px plus 8 px on every side is 44 px, and a pseudo-element cannot move the layout.
    expect(touch).toMatch(/\.anchor::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*-8px/);
    expect(touch.replace(/\.anchor::after\s*\{[^}]*\}/, "")).not.toMatch(/width|height|margin|padding/);
  });

  it("only references style classes that the stylesheet defines", () => {
    const names = new Set([...source.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(css, `.${name}`).toMatch(new RegExp(`\\.${name}(?![A-Za-z0-9_-])`));
  });
});

describe("Markdown converted by the real loader", () => {
  const markdown = [
    "### Sub heading",
    "",
    "Text with `code`, **bold**, *italic*, [Beta](beta.md), [Gamma](../concepts/gamma.md#gamma-heading), [Jump](#alpha-section), [Site](https://example.com/page), and [Mail](mailto:team@example.com).",
    "",
    "#### Deep heading",
    "",
    "1. First",
    "2. Second",
    "   - Nested",
    "",
    "| Name | Count | Note |",
    "| :--- | ---: | :---: |",
    "| a | 1 | `x` |",
    "",
    `${FENCE}powershell`,
    "npm test",
    FENCE,
    "",
    "![Shot alt text](../images/topic/shot.jpg)",
    "",
    "*A caption.*",
    "",
    "> **Note:** Context is the latest snapshot.",
    "",
    "> **Caution:** Close the app first.",
    "",
    "> A plain quotation.",
  ].join("\n");

  it("maps every supported element", () => {
    const blocks = pageOf(loaded(standard(alphaWith(markdown))), "get-started/alpha.md").blocks;
    const html = render(blocks);

    expect(html).toContain('<h1 id="alpha">Alpha</h1>');
    expect(html).toContain('<h2 id="alpha-section">Alpha section</h2>');
    expect(html).toContain('<h3 id="sub-heading">Sub heading</h3>');
    expect(html).toContain('<h4 id="deep-heading">Deep heading</h4>');
    expect(count(html, "Link to this section")).toBe(3);

    expect(html).toContain('href="/docs/get-started/beta"');
    expect(html).toContain('href="/docs/concepts/gamma#gamma-heading"');
    expect(html).toContain('href="#alpha-section"');
    expect(html).toMatch(/href="https:\/\/example\.com\/page" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('href="mailto:team@example.com"');

    expect(html).toMatch(/<ol [^>]*><li><p>First<\/p><\/li><li><p>Second<\/p><ul/);
    expect(html).toContain('<th scope="col">Name</th>');
    expect(html).toMatch(/<td class="[^"]*alignRight[^"]*">1<\/td>/);
    expect(html).toContain('<code class="language-powershell">npm test</code>');
    expect(attributesOf(tagsOf(html, "img")[0] ?? "")).toMatchObject({
      src: "/docs/images/topic/shot.jpg",
      alt: "Shot alt text",
      width: String(IMAGE_WIDTH),
      height: String(IMAGE_HEIGHT),
      loading: "lazy",
      decoding: "async",
    });
    expect(html).toContain("<p><em>A caption.</em></p>");

    expect(html).toMatch(/role="note"><p class="[^"]*">Note<\/p><p>Context is the latest snapshot\.<\/p>/);
    expect(html).toMatch(/role="note"><p class="[^"]*">Caution<\/p><p>Close the app first\.<\/p>/);
    expect(html).not.toMatch(/Note:|Caution:/);
    expect(html).toMatch(/<blockquote[^>]*><p>A plain quotation\.<\/p><\/blockquote>/);
  });

  it("never reaches the renderer with a link to a page the manifest does not publish", () => {
    const issues = rejected(standard(alphaWith("[Hidden](../help/hidden.md) and [Plan](../../internal/plans/x.md)")));
    expect(issues).toMatch(/manifest does not select/);
    expect(issues).toMatch(/resolves outside docs\/public\//);
  });
});

describe("the real generated pages", () => {
  const generated = new URL("../../generated/docs-content.json", import.meta.url);
  const content = JSON.parse(readFileSync(generated, "utf8")) as DocsContent;
  const routes = new Set(content.pages.map((page) => page.route));
  const imageRoutes = new Set(content.images.map((image) => image.route));

  it("has pages to render", () => {
    expect(content.pages.length).toBeGreaterThan(0);
  });

  it.each(content.pages.map((page) => [page.route, page] as const))("renders %s in strict mode", (_route, page) => {
    const html = render(page.blocks);

    // Headings: one h1, every generated id exactly once, a permalink for every heading below the title.
    expect(count(html, "<h1 ")).toBe(1);
    for (const heading of page.headings) {
      expect(count(html, ` id="${heading.id}"`), `${page.route}#${heading.id}`).toBe(1);
      expect(html).toContain(`<h${heading.depth} id="${heading.id}">`);
    }
    expect(count(html, "Link to this section: ")).toBe(page.headings.filter((heading) => heading.depth >= 2).length);

    // Links: published docs routes or anchors inside this page, and external links that never keep an opener.
    for (const match of html.matchAll(/<a [^>]*?href="([^"]*)"[^>]*>/g)) {
      const [tag, href] = match;
      if (href.startsWith("#")) expect(html, tag).toContain(` id="${href.slice(1)}"`);
      else if (href.startsWith("/docs/")) expect(routes.has(href.split("#")[0]), tag).toBe(true);
      else if (/^https?:/.test(href)) expect(tag).toMatch(/target="_blank" rel="noopener noreferrer"/);
      else expect(href, tag).toMatch(/^mailto:/);
    }

    // Images: a mirrored route, alt text, and lazy loading.
    for (const tag of tagsOf(html, "img")) {
      const attributes = attributesOf(tag);
      expect(imageRoutes.has(attributes.src ?? ""), tag).toBe(true);
      expect(attributes.alt?.trim(), tag).toBeTruthy();
      expect(attributes).toMatchObject({ loading: "lazy", decoding: "async" });
      expect(attributes.width, tag).toMatch(/^[1-9]\d*$/);
      expect(attributes.height, tag).toMatch(/^[1-9]\d*$/);
    }

    // Tables live in a named region; nothing executable or inline-styled is emitted.
    expect(count(html, 'role="region"')).toBe(count(html, "<table"));
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|<style|javascript:|\sstyle=|\son[a-z]+=/i);
  });
});
