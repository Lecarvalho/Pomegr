import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSlugger,
  decodeCharacterReferences,
  loadDocsContent,
  parseFrontMatter,
  serializeDocsContent,
  slugifyHeading,
  validateManifest,
} from "../../scripts/docs-content.mjs";
import {
  FENCE,
  JPG,
  PNG,
  alphaWith,
  baseManifest,
  cleanupScratch,
  doc,
  frontMatter,
  inlinesOf,
  inspect,
  loaded,
  makeRepo,
  pageOf,
  put,
  rejected,
  sha256,
  standard,
} from "./docs-fixtures";

afterEach(cleanupScratch);

describe("heading slugs", () => {
  it("follows the GitHub anchor rules", () => {
    expect(slugifyHeading("Spot a possible full refill")).toBe("spot-a-possible-full-refill");
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("What's new in v0.5?")).toBe("whats-new-in-v05");
    expect(slugifyHeading("Cache & tokens")).toBe("cache--tokens");
    expect(slugifyHeading("snake_case stays")).toBe("snake_case-stays");
    expect(slugifyHeading("Cost (estimate)")).toBe("cost-estimate");
    expect(slugifyHeading("  Trim me  ")).toBe("trim-me");
    expect(slugifyHeading("\u00dcberblick \u00fcber")).toBe("\u00fcberblick-\u00fcber");
  });

  it("suffixes repeats and never reuses an earlier ID", () => {
    const slug = createSlugger();
    expect(["A", "A", "A 1", "A", "Other"].map(slug)).toEqual(["a", "a-1", "a-1-1", "a-2", "other"]);
  });

  it("decodes only a fixed set of named character references", () => {
    expect(decodeCharacterReferences("Fish &amp; chips &copy; &bogus; &amp;lt;")).toBe("Fish & chips \u00a9 &bogus; &lt;");
  });
});

describe("manifest validation", () => {
  const source = (path: string) => ({ version: 1, groups: [{ id: "get-started", title: "Get started", pages: [path] }] });

  it("derives one unique route per selected page, in reading order", () => {
    const { groups, issues } = validateManifest({
      version: 1,
      groups: [
        { id: "concepts", title: "Concepts", pages: ["concepts/context-and-tokens.md", "concepts/cache-reuse.md"] },
        { id: "help", title: "Help", pages: [] },
      ],
    });
    expect(issues).toEqual([]);
    expect(groups.flatMap((group) => group.pages.map((page) => page.route))).toEqual([
      "/docs/concepts/context-and-tokens",
      "/docs/concepts/cache-reuse",
    ]);
  });

  const invalidManifests: Array<[unknown, string]> = [
    [null, "must be a JSON object"],
    [[], "must be a JSON object"],
    [{ version: 2, groups: [] }, "version must be the integer 1"],
    [{ version: "1", groups: [] }, "version must be the integer 1"],
    [{ version: 1 }, "groups must be an array"],
    [{ version: 1, groups: [], extra: true }, 'unknown field "extra"'],
    [{ version: 1, groups: [{ id: "guides", title: "Guides", pages: [] }] }, "must be one of get-started"],
    [{ version: 1, groups: [{ id: "help", title: "", pages: [] }] }, "title must be non-empty plain text"],
    [{ version: 1, groups: [{ id: "help", title: "Help", pages: "help/a.md" }] }, "pages must be an array"],
    [{ version: 1, groups: [{ id: "help", title: "Help", pages: [], order: 1 }] }, 'unknown field "order"'],
    [{ version: 1, groups: [{ id: "help", title: "A", pages: [] }, { id: "help", title: "B", pages: [] }] }, '"help" is duplicated'],
    [source("help/a.md"), 'must start with "get-started/"'],
    [{ version: 1, groups: [{ id: "get-started", title: "G", pages: ["get-started/a.md", "get-started/a.md"] }] }, "is listed more than once"],
  ];

  it.each(invalidManifests)("rejects %j", (raw, message) => {
    expect(validateManifest(raw).issues.join("\n")).toContain(message);
  });

  it.each([
    "../internal/architecture/overview.md",
    "get-started/../../internal/x.md",
    "./get-started/a.md",
    "/get-started/a.md",
    "C:/docs/public/get-started/a.md",
    "\\\\server\\share\\a.md",
    "get-started\\a.md",
    "get-started/%2e%2e/a.md",
    "get-started/a.md#section",
    "get-started/a.md?x=1",
    "get-started/*.md",
    "get-started/{a,b}.md",
    "get-started/A.md",
    "get-started/a_b.md",
    "get-started/nested/a.md",
    "get-started/a.txt",
    "get-started/a.markdown",
    "get-started/a",
    "get-started//a.md",
    " get-started/a.md",
    "",
    42,
  ])("rejects the page path %j", (path) => {
    const { groups, issues } = validateManifest(source(path as string));
    expect(issues.length).toBeGreaterThan(0);
    expect(groups.flatMap((group) => group.pages)).toEqual([]);
  });

  it("treats an empty manifest as selecting nothing, never discovering pages", () => {
    const repo = standard({}, { version: 1, groups: [] });
    const content = loaded(repo);
    expect(content.pages).toEqual([]);
    expect(content.navigation).toEqual([]);
    expect(content.images).toEqual([]);
    expect(content.entry).toBeNull();
    expect(JSON.stringify(content)).not.toContain("HIDDEN_SENTINEL");
  });

  it("omits empty groups from navigation and keeps the unlisted page out", () => {
    const repo = standard({}, { ...baseManifest, groups: [...baseManifest.groups, { id: "help", title: "Help", pages: [] }] });
    const content = loaded(repo);
    expect(content.navigation.map((group) => group.id)).toEqual(["get-started", "concepts"]);
    expect(content.pages.map((page) => page.route)).toEqual(["/docs/get-started/alpha", "/docs/get-started/beta", "/docs/concepts/gamma"]);
    expect(JSON.stringify(content)).not.toContain("HIDDEN_SENTINEL");
  });

  it("reports unreadable or unsupported manifests", () => {
    expect(rejected(makeRepo("{ not json"))).toContain("docs/site.json is not valid JSON");
    expect(rejected(makeRepo(baseManifest, {}))).toContain("does not exist");
  });
});

describe("front matter", () => {
  const good = (yaml: string) => `---\n${yaml}\n---\n\n# T\n`;

  it("accepts quoted and plain single-line values", () => {
    expect(parseFrontMatter(good('title: "It\'s a \\"title\\""\ndescription: \'It\'\'s fine\'')).metadata).toEqual({
      title: 'It\'s a "title"',
      description: "It's fine",
    });
    expect(parseFrontMatter(good("title: Plain title\ndescription: A plain sentence.")).metadata).toEqual({
      title: "Plain title",
      description: "A plain sentence.",
    });
  });

  const invalidFrontMatter: Array<[string, string, string]> = [
    ["no block", "# T\n", "must begin with a --- front matter block"],
    ["an unclosed block", '---\ntitle: "T"\n# T\n', "is not closed"],
    ["an unknown key", good('title: "T"\ndescription: "D"\ndraft: true'), 'unknown front matter key "draft"'],
    ["a repeated key", good('title: "T"\ntitle: "U"\ndescription: "D"'), 'key "title" is repeated'],
    ["a missing description", good('title: "T"'), 'missing "description"'],
    ["an empty title", good('title: ""\ndescription: "D"'), "title must be non-empty"],
    ["markup in the title", good('title: "<b>T</b>"\ndescription: "D"'), "without < or >"],
    ["a flow sequence", good('title: [a, b]\ndescription: "D"'), "use a quoted string"],
    ["a multi-line value", good('title: "T"\ndescription: >\n  folded'), "use a quoted string"],
    ["an indented continuation", good('title: "T"\ndescription: "D"\n  more: text'), "unsupported front matter line"],
    ["a trailing comment", good('title: "T" # note\ndescription: "D"'), "one complete string"],
  ];

  it.each(invalidFrontMatter)("rejects %s", (_name, markdown, message) => {
    expect(parseFrontMatter(markdown).issues.map((issue) => issue.message).join("\n")).toContain(message);
  });

  it("requires exactly one matching first title and no skipped heading levels", () => {
    expect(rejected(standard({ "get-started/beta.md": `${frontMatter("Beta")}\nIntro.\n\n# Beta\n` }))).toContain("must be the first element");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", "# Again") }))).toContain("exactly one # title");
    expect(rejected(standard({ "get-started/beta.md": `${frontMatter("Beta")}\n# Different\n` }))).toContain("must equal the front matter title");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", "### Skips a level") }))).toContain("skips from 1 to 3");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", "##### Too deep") }))).toContain("deeper than ####");
    expect(rejected(standard({ "get-started/beta.md": `${frontMatter("Beta")}\nNo title here.\n` }))).toContain("exactly one # title");
  });
});

describe("page structure", () => {
  const rich = [
    "Intro with *em*, **strong**, `code`, a [link](beta.md), and ![Alt *text*](../images/topic/shot.jpg).",
    "",
    "> **Note:** Watch out.",
    "",
    "> **Caution:** Be careful",
    "> here.",
    "",
    "3. First",
    "4. Second",
    "   - Nested",
    "",
    "| Name | Value |",
    "| :-- | --: |",
    "| A \\| B | `x` |",
    "",
    `${FENCE}powershell`,
    "Get-Item",
    FENCE,
  ].join("\n");

  it("emits a compact structured tree with callouts, lists, tables, code and images", () => {
    const page = pageOf(loaded(standard(alphaWith(rich))), "get-started/alpha.md");
    expect(page.blocks.map((block) => block.type)).toEqual(["heading", "heading", "paragraph", "callout", "callout", "list", "table", "codeblock"]);

    const paragraph = page.blocks[2];
    expect(paragraph).toEqual({
      type: "paragraph",
      children: [
        { type: "text", text: "Intro with " },
        { type: "em", children: [{ type: "text", text: "em" }] },
        { type: "text", text: ", " },
        { type: "strong", children: [{ type: "text", text: "strong" }] },
        { type: "text", text: ", " },
        { type: "code", text: "code" },
        { type: "text", text: ", a " },
        { type: "link", href: "/docs/get-started/beta", external: false, children: [{ type: "text", text: "link" }] },
        { type: "text", text: ", and " },
        { type: "image", src: "/docs/images/topic/shot.jpg", alt: "Alt text" },
        { type: "text", text: "." },
      ],
    });
    expect(page.blocks[3]).toEqual({ type: "callout", kind: "note", blocks: [{ type: "paragraph", children: [{ type: "text", text: "Watch out." }] }] });
    expect(page.blocks[4]).toEqual({ type: "callout", kind: "caution", blocks: [{ type: "paragraph", children: [{ type: "text", text: "Be careful here." }] }] });
    expect(page.blocks[5]).toMatchObject({ type: "list", ordered: true, start: 3 });
    expect(page.blocks[6]).toEqual({
      type: "table",
      align: ["left", "right"],
      header: [[{ type: "text", text: "Name" }], [{ type: "text", text: "Value" }]],
      rows: [[[{ type: "text", text: "A | B" }], [{ type: "code", text: "x" }]]],
    });
    expect(page.blocks[7]).toEqual({ type: "codeblock", lang: "powershell", text: "Get-Item" });
  });

  it("decodes character references in text and headings", () => {
    const page = pageOf(loaded(standard(alphaWith("Fish &amp; chips &copy; &bogus;.\n\n## Fish &amp; chips"))), "get-started/alpha.md");
    expect(page.headings.map((heading) => heading.id)).toEqual(["alpha", "alpha-section", "fish--chips"]);
    expect(page.blocks[2]).toEqual({ type: "paragraph", children: [{ type: "text", text: "Fish & chips \u00a9 &bogus;." }] });
  });

  it("collects every heading with its anchor, suffixing repeats", () => {
    const page = pageOf(loaded(standard(alphaWith("## Repeat\n\n## Repeat\n\n### `Code` and **bold**"))), "get-started/alpha.md");
    expect(page.headings).toEqual([
      { depth: 1, id: "alpha", text: "Alpha" },
      { depth: 2, id: "alpha-section", text: "Alpha section" },
      { depth: 2, id: "repeat", text: "Repeat" },
      { depth: 2, id: "repeat-1", text: "Repeat" },
      { depth: 3, id: "code-and-bold", text: "Code and bold" },
    ]);
  });

  it("chains previous and next links across groups in manifest order", () => {
    const content = loaded(standard());
    expect(content.entry).toBe("/docs/get-started/alpha");
    expect(content.pages.map((page) => [page.previous?.route ?? null, page.route, page.next?.route ?? null])).toEqual([
      [null, "/docs/get-started/alpha", "/docs/get-started/beta"],
      ["/docs/get-started/alpha", "/docs/get-started/beta", "/docs/concepts/gamma"],
      ["/docs/get-started/beta", "/docs/concepts/gamma", null],
    ]);
    expect(content.navigation).toEqual([
      { id: "get-started", title: "Get started", pages: [{ route: "/docs/get-started/alpha", title: "Alpha" }, { route: "/docs/get-started/beta", title: "Beta" }] },
      { id: "concepts", title: "Concepts", pages: [{ route: "/docs/concepts/gamma", title: "Gamma" }] },
    ]);
  });

  it("rejects unsupported Markdown instead of guessing", () => {
    const cases: Array<[string, string]> = [
      ["- [ ] a task", "task lists are not supported"],
      ["~~struck~~", "strikethrough is not supported"],
      ["Paragraph.\n\n---", "horizontal rules are not supported"],
      ["    indented code", "indented code blocks are not supported"],
      [`${FENCE}\nno language\n${FENCE}`, "must name its language"],
      [`${FENCE}powershell title=x\nx\n${FENCE}`, "must name its language"],
      ["> **Warning:** nope", 'unsupported callout label "Warning:"'],
      ["- item\n\n  ## Nested heading", "headings must be top-level"],
      ["> ## Quoted heading", "headings must be top-level"],
      ["[ref][id]\n\n[id]: beta.md", "reference-style link definitions are not supported"],
      ['[titled](beta.md "Title")', "link titles are not supported"],
    ];
    for (const [body, message] of cases) expect(rejected(standard(alphaWith(body)))).toContain(message);
  });
});

describe("raw HTML is never accepted", () => {
  it.each([
    "<div>block</div>",
    "Some <span>inline</span> text.",
    "<!-- hidden comment -->",
    "Use the <type> placeholder.",
    "Line<br>break",
    '<img src="x.png" alt="x">',
    "<script>alert(1)</script>",
    "- item <b>bold</b>",
    "| a |\n| - |\n| <i>b</i> |",
    "> <em>quoted</em>",
  ])("rejects %j", (body) => {
    expect(rejected(standard(alphaWith(body)))).toContain("raw HTML is not allowed");
  });

  it("allows angle brackets inside code", () => {
    const content = loaded(standard(alphaWith(`Use \`<type>\`.\n\n${FENCE}text\n<div>not html</div>\n${FENCE}`)));
    const page = pageOf(content, "get-started/alpha.md");
    expect(page.blocks[3]).toEqual({ type: "codeblock", lang: "text", text: "<div>not html</div>" });
  });
});

describe("links", () => {
  const link = (target: string, label = "link") => alphaWith(`Go to [${label}](${target}).`);

  it("rewrites relative Markdown links to docs routes and preserves validated fragments", () => {
    const repo = standard(alphaWith("[same](#alpha-section) [sibling](beta.md) [across](../concepts/gamma.md#gamma-heading) [dot](./beta.md)"));
    const links = [...inlinesOf(pageOf(loaded(repo), "get-started/alpha.md").blocks)].filter((node) => node.type === "link");
    expect(links.map((node) => (node.type === "link" ? node.href : ""))).toEqual([
      "#alpha-section",
      "/docs/get-started/beta",
      "/docs/concepts/gamma#gamma-heading",
      "/docs/get-started/beta",
    ]);
  });

  it("keeps https, http and mailto links external", () => {
    const repo = standard(alphaWith("[a](https://example.com/x?y=1#z) [b](http://example.com) [c](mailto:docs@example.com) <https://auto.example.com>"));
    const links = [...inlinesOf(pageOf(loaded(repo), "get-started/alpha.md").blocks)].filter((node) => node.type === "link");
    expect(links.map((node) => (node.type === "link" ? [node.href, node.external] : null))).toEqual([
      ["https://example.com/x?y=1#z", true],
      ["http://example.com", true],
      ["mailto:docs@example.com", true],
      ["https://auto.example.com", true],
    ]);
  });

  it("fails a link to a page the manifest does not select", () => {
    expect(rejected(standard(link("../help/hidden.md")))).toContain("which the manifest does not select");
    expect(rejected(standard(link("../help/hidden.md#hidden")))).toContain("which the manifest does not select");
    expect(rejected(standard(link("gamma.md")))).toContain("which the manifest does not select");
  });

  it("fails a link that leaves docs/public, including to internal documentation", () => {
    const message = rejected(standard(link("../../internal/secret.md")));
    expect(message).toContain("resolves outside docs/public/");
    expect(message).not.toContain("INTERNAL_SENTINEL");
    expect(rejected(standard(link("../../../etc/passwd.md")))).toContain("resolves outside docs/public/");
  });

  it("fails a missing or malformed fragment", () => {
    expect(rejected(standard(link("beta.md#nope")))).toContain("heading anchor that does not exist in get-started/beta.md");
    expect(rejected(standard(link("#nope")))).toContain("heading anchor that does not exist");
    expect(rejected(standard(link("beta.md#a%20b")))).toContain("is not a heading anchor");
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vbscript:x",
    "ftp://example.com/x",
    "//evil.example/x",
    "/docs/get-started/beta",
    "C:\\docs\\public\\get-started\\beta.md",
    "\\\\server\\share\\beta.md",
    "beta.md?x=1",
    "beta.txt",
    "beta",
    "%2e%2e/beta.md",
    "beta%2emd",
    "http://user:secret@example.com/",
    "mailto:",
  ])("rejects the destination %j", (target) => {
    expect(rejected(standard(link(target))).length).toBeGreaterThan(0);
  });

  it("requires visible link text", () => {
    expect(rejected(standard(link("beta.md", "")))).toContain("a link needs visible text");
  });

  it("makes every internal link of the real pages resolve", () => {
    const { content } = loadDocsContent();
    const pages = new Map(content.pages.map((page) => [page.route, new Set(page.headings.map((heading) => heading.id))]));
    let checked = 0;
    for (const page of content.pages) {
      for (const node of inlinesOf(page.blocks)) {
        if (node.type !== "link" || node.external) continue;
        const [route, fragment] = node.href.split("#");
        const anchors = route === "" ? pages.get(page.route) : pages.get(route);
        expect(anchors, `${page.route} links to ${node.href}`).toBeDefined();
        if (fragment) expect(anchors?.has(fragment), `${page.route} links to ${node.href}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("images", () => {
  const image = (target: string, alt = "A screenshot") => alphaWith(`![${alt}](${target})`);

  it("resolves images to /docs/images routes and copies only referenced files", () => {
    const repo = standard(image("../images/topic/shot.jpg"));
    const { content, assets, issues } = inspect(repo);
    expect(issues).toEqual([]);
    expect(content?.images).toEqual([{ route: "/docs/images/topic/shot.jpg", bytes: JPG.length, sha256: sha256(JPG) }]);
    expect(assets.map((asset) => [asset.route, asset.relativePath, asset.data.equals(JPG)])).toEqual([["/docs/images/topic/shot.jpg", "topic/shot.jpg", true]]);
    expect(JSON.stringify(content)).not.toContain("unused.jpg");
  });

  it("accepts png images and several references to one file", () => {
    const repo = standard({ ...alphaWith("![One](../images/topic/a.png) ![Two](../images/topic/a.png)"), "images/topic/a.png": PNG });
    expect(loaded(repo).images).toHaveLength(1);
  });

  const invalidImages: Array<[string, string, string, string]> = [
    ["an empty alt", "../images/topic/shot.jpg", "", "needs alt text"],
    ["a blank alt", "../images/topic/shot.jpg", " ", "needs alt text"],
    ["a remote image", "https://example.com/x.png", "Remote", "relative path"],
    ["a data URL", "data:image/png;base64,AAAA", "Inline", "relative path"],
    ["a protocol-relative image", "//example.com/x.png", "Remote", "relative path"],
    ["an image with a query", "../images/topic/shot.jpg?x=1", "Query", "relative path"],
    ["an image with a fragment", "../images/topic/shot.jpg#x", "Fragment", "relative path"],
    ["a missing file", "../images/topic/missing.jpg", "Missing", "does not exist"],
    ["an image outside images/", "../concepts/pic.png", "Wrong place", "must resolve to docs/public/images/<topic>/<file>"],
    ["an image directly under images/", "../images/shot.jpg", "No topic", "must resolve to docs/public/images/<topic>/<file>"],
    ["an unsupported extension", "../images/topic/drawing.svg", "Vector", "png, jpg, jpeg, webp or gif"],
    ["an uppercase extension", "../images/topic/SHOT.JPG", "Shouting", "png, jpg, jpeg, webp or gif"],
    ["an escape from docs/public", "../../../internal/secret.png", "Escape", "resolves outside docs/public/"],
    ["an encoded traversal", "../images/%2e%2e/shot.jpg", "Encoded", "plain relative path"],
  ];

  it.each(invalidImages)("rejects %s", (_name, target, alt, message) => {
    const text = rejected(standard({ ...image(target, alt), "images/topic/drawing.svg": "<svg/>" }));
    expect(text).toContain(message);
  });

  it("rejects image titles and files whose bytes do not match their extension", () => {
    expect(rejected(standard(alphaWith('![Titled](../images/topic/shot.jpg "Title")')))).toContain("image titles are not supported");
    expect(rejected(standard({ ...image("../images/topic/fake.png"), "images/topic/fake.png": "not a png" }))).toContain("does not contain png data");
    expect(rejected(standard({ ...image("../images/topic/fake.gif"), "images/topic/fake.gif": PNG }))).toContain("does not contain gif data");
  });

  it("loads every image the real pages reference with matching bytes", () => {
    const { content, assets } = loadDocsContent();
    expect(content.images.length).toBeGreaterThanOrEqual(19);
    expect(assets.map((asset) => asset.route)).toEqual(content.images.map((entry) => entry.route));
    for (const asset of assets) expect(sha256(asset.data)).toBe(asset.sha256);
    const referenced = new Set<string>();
    for (const page of content.pages) for (const node of inlinesOf(page.blocks)) if (node.type === "image") {
      referenced.add(node.src);
      expect(node.alt.trim().length).toBeGreaterThan(0);
    }
    expect([...referenced].sort()).toEqual(content.images.map((entry) => entry.route));
  });
});

describe("determinism and revision", () => {
  it("serializes identically on repeated loads, without timestamps", () => {
    const repo = standard(alphaWith("![Shot](../images/topic/shot.jpg)"));
    const first = serializeDocsContent(loaded(repo));
    expect(serializeDocsContent(loaded(repo))).toBe(first);
    expect(first.endsWith("}\n")).toBe(true);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(first).not.toContain(repo.root.replaceAll("\\", "\\\\"));
  });

  it("is independent of line endings, so Windows and Linux checkouts agree", () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    const lf = loaded(standard());
    const windows = loaded(
      standard({
        "get-started/alpha.md": crlf(doc("Alpha", "## Alpha section\n\nText.")),
        "get-started/beta.md": `${String.fromCodePoint(0xfeff)}${crlf(doc("Beta"))}`,
        "concepts/gamma.md": crlf(doc("Gamma", "## Gamma heading\n\nText.")),
      }),
    );
    expect(windows.revision).toBe(lf.revision);
    expect(serializeDocsContent(windows)).toBe(serializeDocsContent(lf));
  });

  it("changes the revision when a page, an image, or the manifest changes", () => {
    const withImage = (bytes: Buffer) => standard({ ...alphaWith("![Shot](../images/topic/shot.jpg)"), "images/topic/shot.jpg": bytes });
    const revisions = new Set([
      loaded(standard()).revision,
      loaded(standard({ "get-started/beta.md": doc("Beta", "Changed body.") })).revision,
      loaded(withImage(JPG)).revision,
      loaded(withImage(Buffer.concat([JPG, Buffer.from([9])]))).revision,
      loaded(standard({}, { ...baseManifest, groups: [baseManifest.groups[1], baseManifest.groups[0]] })).revision,
      loaded(standard({}, { ...baseManifest, groups: [{ ...baseManifest.groups[0], title: "Begin" }, baseManifest.groups[1]] })).revision,
    ]);
    expect(revisions.size).toBe(6);
    for (const revision of revisions) expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not change when an unselected file changes", () => {
    const before = loaded(standard()).revision;
    const repo = standard({ "help/hidden.md": doc("Hidden", "Different.") });
    put(join(repo.publicRoot, "images", "topic", "unused.jpg"), Buffer.concat([JPG, Buffer.from([7])]));
    expect(loaded(repo).revision).toBe(before);
  });
});
