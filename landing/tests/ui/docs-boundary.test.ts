import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadDocsContent, serializeDocsContent, writePreparedDocs } from "../../scripts/docs-content.mjs";
import { buildSearchIndex, serializeSearchIndex } from "../../scripts/docs-search.mjs";
import {
  JPG,
  PNG,
  alphaWith,
  baseManifest,
  cleanupScratch,
  doc,
  makeRepo,
  put,
  rejected,
  sha256,
  standard,
  temporaryDirectory,
} from "./docs-fixtures";

afterEach(cleanupScratch);

describe("content boundary", () => {
  function symlinkOrSkip(target: string, path: string, type: "file" | "dir" | "junction"): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch {
      return false;
    }
  }

  it("never reads internal documentation, even when the manifest names it", () => {
    for (const path of ["../internal/secret.md", "internal/secret.md", "get-started/../../internal/secret.md"]) {
      const text = rejected(standard({}, { version: 1, groups: [{ id: "get-started", title: "G", pages: [path] }] }));
      expect(text).not.toContain("INTERNAL_SENTINEL");
    }
    const repo = standard({}, { version: 1, groups: [{ id: "get-started", title: "G", pages: ["get-started/secret.md"] }] });
    expect(rejected(repo)).toContain("does not exist");
  });

  it("rejects a selected page that is a directory junction into internal documentation", () => {
    const repo = makeRepo({ version: 1, groups: [{ id: "get-started", title: "G", pages: ["get-started/alpha.md"] }] });
    put(join(repo.docs, "internal", "area", "alpha.md"), doc("Alpha", "JUNCTION_SENTINEL"));
    expect(symlinkOrSkip(join(repo.docs, "internal", "area"), join(repo.publicRoot, "get-started"), "junction")).toBe(true);
    const text = rejected(repo);
    expect(text).toContain("passes through a symbolic link or junction");
    expect(text).not.toContain("JUNCTION_SENTINEL");
  });

  it("rejects a public root that is itself a link", () => {
    const repo = makeRepo({ version: 1, groups: [] });
    rmSync(repo.publicRoot, { recursive: true });
    put(join(repo.docs, "internal", "alpha.md"), doc("Alpha"));
    expect(symlinkOrSkip(join(repo.docs, "internal"), repo.publicRoot, "junction")).toBe(true);
    expect(rejected(repo)).toContain("docs/public/ must be a real directory, not a link");
  });

  it("rejects an image directory that links elsewhere", () => {
    const repo = standard(alphaWith("![Shot](../images/linked/shot.jpg)"));
    put(join(repo.docs, "internal", "pictures", "shot.jpg"), JPG);
    expect(symlinkOrSkip(join(repo.docs, "internal", "pictures"), join(repo.publicRoot, "images", "linked"), "junction")).toBe(true);
    expect(rejected(repo)).toContain("passes through a symbolic link or junction");
  });

  it("rejects linked page files and a linked manifest when the platform allows file links", (context) => {
    const repo = standard();
    const outside = join(repo.docs, "internal", "beta.md");
    put(outside, doc("Beta", "LINK_SENTINEL"));
    rmSync(join(repo.publicRoot, "get-started", "beta.md"));
    if (!symlinkOrSkip(outside, join(repo.publicRoot, "get-started", "beta.md"), "file")) context.skip();
    const text = rejected(repo);
    expect(text).toContain("passes through a symbolic link or junction");
    expect(text).not.toContain("LINK_SENTINEL");

    const manifestRepo = standard();
    const realManifest = join(manifestRepo.docs, "internal", "site.json");
    put(realManifest, JSON.stringify(baseManifest));
    rmSync(join(manifestRepo.docs, "site.json"));
    if (!symlinkOrSkip(realManifest, join(manifestRepo.docs, "site.json"), "file")) context.skip();
    expect(rejected(manifestRepo)).toContain("docs/site.json must be a regular file, not a link");
  });

  it("requires exact file-name case", () => {
    const repo = standard();
    rmSync(join(repo.publicRoot, "get-started", "beta.md"));
    put(join(repo.publicRoot, "get-started", "Beta.md"), doc("Beta"));
    expect(rejected(repo)).toContain("get-started/beta.md does not exist (names are case-sensitive)");
  });

  it("rejects invalid encodings, control characters, bidirectional overrides and oversized pages", () => {
    expect(rejected(standard({ "get-started/beta.md": Buffer.from([0xff, 0xfe, 0x23, 0x20]) }))).toContain("is not valid UTF-8");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", "Bell\u0007 character") }))).toContain("control or bidirectional-override");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", `Trojan ${String.fromCodePoint(0x202e)}source`) }))).toContain("control or bidirectional-override");
    expect(rejected(standard({ "get-started/beta.md": doc("Beta", "x".repeat(300 * 1024)) }))).toContain("is larger than");
  });

  it("loads exactly the selected public pages and images of the real documentation", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../docs/site.json", import.meta.url), "utf8")) as { groups: Array<{ pages: string[] }> };
    const selected = manifest.groups.flatMap((group) => group.pages);
    const { content } = loadDocsContent();
    expect(selected.length).toBeGreaterThanOrEqual(17);
    expect(content.pages.map((page) => page.source)).toEqual(selected);
    expect(content.pages.map((page) => page.route)).toEqual(selected.map((path) => `/docs/${path.replace(/\.md$/, "")}`));
    expect(content.entry).toBe(content.pages[0].route);
    expect(new Set(content.pages.map((page) => page.route)).size).toBe(content.pages.length);
    expect(content.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(content.navigation.flatMap((group) => group.pages.map((page) => page.route))).toEqual(content.pages.map((page) => page.route));
    expect(JSON.stringify(content)).not.toMatch(/docs\/(?:internal|plans|mockups)\//);
    for (const page of content.pages) {
      expect(page.title.length).toBeGreaterThan(0);
      expect(page.description.length).toBeGreaterThan(0);
      expect(page.headings[0]).toMatchObject({ depth: 1, text: page.title });
    }
  });
});

describe("prepared output", () => {
  it("writes the content module and mirrors only referenced images, pruning stale ones", () => {
    const repo = standard(alphaWith("![Shot](../images/topic/shot.jpg)"));
    const result = loadDocsContent({ landingRoot: repo.landingRoot });
    const { contentFile, imagesRoot } = writePreparedDocs({ landingRoot: repo.landingRoot, ...result });
    expect(readFileSync(contentFile, "utf8")).toBe(serializeDocsContent(result.content));
    expect(readFileSync(join(imagesRoot, "topic", "shot.jpg")).equals(JPG)).toBe(true);
    expect(existsSync(join(imagesRoot, "topic", "unused.jpg"))).toBe(false);

    put(join(imagesRoot, "topic", "stale.jpg"), JPG);
    put(join(imagesRoot, "old", "gone.jpg"), JPG);
    const before = statSync(contentFile).mtimeMs;
    writePreparedDocs({ landingRoot: repo.landingRoot, ...result });
    expect(existsSync(join(imagesRoot, "topic", "stale.jpg"))).toBe(false);
    expect(existsSync(join(imagesRoot, "old"))).toBe(false);
    expect(statSync(contentFile).mtimeMs).toBe(before);
  });

  it("refuses to write through a linked output directory", () => {
    const repo = standard(alphaWith("![Shot](../images/topic/shot.jpg)"));
    const result = loadDocsContent({ landingRoot: repo.landingRoot });
    const elsewhere = join(repo.root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(repo.landingRoot, "public"));
    symlinkSync(elsewhere, join(repo.landingRoot, "public", "docs"), "junction");
    expect(() => writePreparedDocs({ landingRoot: repo.landingRoot, ...result })).toThrow(/must be a real directory/);
    expect(existsSync(join(elsewhere, "images"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The landing boundary audit: a copy of the real script runs against a throwaway package.

describe("artifact boundary audit of the content inputs", () => {
  const auditScript = fileURLToPath(new URL("../../scripts/assert-artifact-boundary.mjs", import.meta.url));
  const validRevision = "a".repeat(64);

  // A package with generated content gets the search index the prepare step would build from it,
  // unless the case supplies its own.
  function landing(files: Record<string, string | Buffer> = {}): string {
    const root = temporaryDirectory("pomegr-audit-");
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(auditScript, join(root, "scripts", "assert-artifact-boundary.mjs"));
    const withIndex = { ...files };
    const generatedContent = files["generated/docs-content.json"];
    if (generatedContent !== undefined && withIndex["generated/docs-search.json"] === undefined) withIndex["generated/docs-search.json"] = searchFor(String(generatedContent));
    for (const [path, data] of Object.entries(withIndex)) put(join(root, path), data);
    return root;
  }

  const searchFor = (contentJson: string) => serializeSearchIndex(buildSearchIndex(JSON.parse(contentJson)));

  function audit(root: string, artifact = false) {
    const args = [join(root, "scripts", "assert-artifact-boundary.mjs"), ...(artifact ? [] : ["--source-only"])];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  }

  const generated = (overrides: Record<string, unknown> = {}, page: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 1,
      revision: validRevision,
      entry: "/docs/help/alpha",
      navigation: [{ id: "help", title: "Help", pages: [{ route: "/docs/help/alpha", title: "Alpha" }] }],
      pages: [
        {
          route: "/docs/help/alpha",
          source: "help/alpha.md",
          group: "help",
          title: "Alpha",
          description: "About Alpha.",
          headings: [
            { depth: 1, id: "alpha", text: "Alpha" },
            { depth: 2, id: "first-steps", text: "First steps" },
          ],
          blocks: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }],
          ...page,
        },
      ],
      images: [],
      ...overrides,
    });
  const imageEntry = (data: Buffer, route = "/docs/images/topic/a.png") => ({ route, bytes: data.length, sha256: sha256(data) });

  it("accepts a package with no docs content and a loader that names only its two inputs", () => {
    expect(audit(landing()).ok).toBe(true);
    const loader = 'export const INPUTS = { manifest: "../docs/site.json", publicRoot: "../docs/public" };\nnew URL("..", import.meta.url);\n';
    expect(audit(landing({ "scripts/docs-content.mjs": loader })).ok).toBe(true);
  });

  const rejectedSources: Array<[string, Record<string, string>, string]> = [
    ["a path into internal documentation", { "app/page.ts": 'export const source = "../../docs/internal/x.md";\n' }, "non-public documentation"],
    ["a parent directory segment", { "app/page.ts": 'import { join } from "node:path";\nexport const p = join("a", "..", "docs");\n' }, "names a path outside landing/"],
    ["the manifest outside the loader", { "scripts/other.mjs": 'export const m = "../docs/site.json";\n' }, "only scripts/docs-content.mjs may read"],
    ["an extra loader input", { "scripts/docs-content.mjs": 'export const x = "../docs/other";\n' }, "names a path outside landing/"],
    ["an internal loader input", { "scripts/docs-content.mjs": 'export const x = "../docs/internal";\n' }, "names a path outside landing/"],
    ["filesystem access in the Worker", { "worker/index.ts": 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n' }, "imports the filesystem"],
    ["filesystem access in a server module", { "server/read.ts": 'import { readFile } from "fs/promises";\nexport const r = readFile;\n' }, "imports the filesystem"],
    ["a multi-line import outside landing", { "app/page.ts": 'import {\n  a,\n  b,\n} from "../../outside";\nexport const c = a + b;\n' }, "imports outside landing/"],
  ];

  it.each(rejectedSources)("rejects %s", (_name, files, message) => {
    const result = audit(landing(files));
    expect(result.ok).toBe(false);
    expect(result.output).toContain(message);
  });

  it("verifies the generated content and its mirrored images byte for byte", () => {
    const png = PNG;
    const base = { "generated/docs-content.json": generated({ images: [imageEntry(png)] }), "public/docs/images/topic/a.png": png };
    expect(audit(landing(base)).ok).toBe(true);

    const cases: Array<[string, Record<string, string | Buffer>, string]> = [
      ["a changed image", { ...base, "public/docs/images/topic/a.png": Buffer.concat([png, Buffer.from([1])]) }, "does not match the generated docs content"],
      ["an undeclared image", { ...base, "public/docs/images/topic/extra.png": png }, "is not an image referenced"],
      ["a stray asset", { ...base, "public/docs/notes.txt": "x" }, "is not an image referenced"],
      ["a missing image", { "generated/docs-content.json": generated({ images: [imageEntry(png)] }) }, "public/docs/images/topic/a.png is missing"],
      ["an invalid page route", { "generated/docs-content.json": generated({}, { route: "/docs/internal/x" }) }, "invalid page route"],
      ["an invalid image route", { "generated/docs-content.json": generated({ images: [imageEntry(png, "/docs/images/../x.png")] }) }, "invalid image"],
      ["a bad schema", { "generated/docs-content.json": generated({ schema: 2 }) }, "unexpected shape"],
      ["local API text", { "generated/docs-content.json": generated({}, { blocks: [{ type: "codeblock", lang: "text", text: "GET /api/state" }] }) }, "contains local state API"],
      ["non-public documentation text", { "generated/docs-content.json": generated({}, { description: "see docs/internal/architecture/x.md" }) }, "contains non-public documentation path"],
      ["images without generated content", { "public/docs/images/topic/a.png": png }, "missing generated/docs-content.json"],
    ];
    for (const [, files, message] of cases) {
      const result = audit(landing(files));
      expect(result.ok, message).toBe(false);
      expect(result.output).toContain(message);
    }
  });

  it("exempts only the allowlisted example path in docs content", () => {
    const mention = (text: string) => generated({}, { blocks: [{ type: "paragraph", children: [{ type: "image", src: "/docs/images/topic/a.png", alt: text }] }] });
    expect(audit(landing({ "generated/docs-content.json": mention("The history of app/Dashboard.tsx, 11 sessions.") })).ok).toBe(true);
    const result = audit(landing({ "generated/docs-content.json": mention("Open app/Dashboard.test.tsx or shared/local-auth.") }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("contains local security modules");
  });

  describe("search index", () => {
    const content = generated({}, { blocks: [{ type: "paragraph", children: [{ type: "text", text: "Hello world" }] }] });
    const index = () => JSON.parse(searchFor(content));
    const withIndex = (change: (value: ReturnType<typeof index>) => void) => {
      const value = index();
      change(value);
      return landing({ "generated/docs-content.json": content, "generated/docs-search.json": JSON.stringify(value) });
    };

    it("accepts an index built from the generated content", () => {
      expect(audit(landing({ "generated/docs-content.json": content })).ok).toBe(true);
      expect(index().pages[0]).toMatchObject({ route: "/docs/help/alpha", group: "Help", title: "Alpha", headings: [{ id: "first-steps", text: "First steps" }], text: "Hello world" });
    });

    const cases: Array<[string, (value: ReturnType<typeof index>) => void, string]> = [
      ["another content revision", (value) => { value.revision = "b".repeat(64); }, "was not built from the generated docs content revision"],
      ["an extra page", (value) => { value.pages.push({ ...value.pages[0], route: "/docs/help/extra" }); }, "does not list exactly the published pages"],
      ["a missing page", (value) => { value.pages.length = 0; }, "does not list exactly the published pages"],
      ["a different route", (value) => { value.pages[0].route = "/docs/help/other"; }, "lists /docs/help/other where the published page is /docs/help/alpha"],
      ["a changed title", (value) => { value.pages[0].title = "Changed"; }, "does not match the title and description"],
      ["a changed description", (value) => { value.pages[0].description = "Another."; }, "does not match the title and description"],
      ["an unpublished heading", (value) => { value.pages[0].headings.push({ id: "secret", text: "Secret" }); }, "lists a heading that /docs/help/alpha does not publish"],
      ["an unbounded body", (value) => { value.pages[0].text = "word ".repeat(1000); }, "has an unbounded or unsafe body"],
      ["a control character", (value) => { value.pages[0].text = "bell\u0007"; }, "has an unbounded or unsafe body"],
      ["an extra page field", (value) => { (value.pages[0] as Record<string, unknown>).extra = "x"; }, "has an unexpected entry at position 0"],
      ["an extra index field", (value) => { (value as Record<string, unknown>).generatedAt = "now"; }, "has an unexpected shape"],
      ["an internal documentation path", (value) => { value.pages[0].text = "see docs/internal/architecture/x.md"; }, "contains non-public documentation path"],
      ["a local API path", (value) => { value.pages[0].text = "GET /api/state"; }, "contains local state API"],
    ];
    it.each(cases)("rejects %s", (_name, change, message) => {
      const result = audit(withIndex(change));
      expect(result.ok, message).toBe(false);
      expect(result.output).toContain(message);
    });

    it("rejects a missing, malformed, or oversized index", () => {
      const missing = landing({ "generated/docs-content.json": content });
      rmSync(join(missing, "generated", "docs-search.json"));
      expect(audit(missing).output).toContain("missing generated/docs-search.json");

      const malformed = audit(landing({ "generated/docs-content.json": content, "generated/docs-search.json": "{not json" }));
      expect(malformed.ok).toBe(false);
      expect(malformed.output).toContain("is not valid JSON");

      const oversized = audit(landing({ "generated/docs-content.json": content, "generated/docs-search.json": JSON.stringify({ ...index(), padding: "x".repeat(130 * 1024) }) }));
      expect(oversized.ok).toBe(false);
      expect(oversized.output).toContain("is larger than");
    });

    it("exempts only the allowlisted example path in the index", () => {
      expect(audit(withIndex((value) => { value.pages[0].text = "the history of app/Dashboard.tsx"; })).ok).toBe(true);
      expect(audit(withIndex((value) => { value.pages[0].text = "the file shared/local-auth.mjs"; })).ok).toBe(false);
    });
  });

  describe("artifact mode", () => {
    const wrangler = { name: "x", compatibility_date: "2026-01-01", workers_dev: false, preview_urls: false };
    const dist = (extra: Record<string, string | Buffer> = {}, omit: string[] = []): Record<string, string | Buffer> => {
      const files: Record<string, string | Buffer> = {
        "wrangler.jsonc": JSON.stringify(wrangler),
        "dist/server/wrangler.json": JSON.stringify({ ...wrangler, main: "index.js", no_bundle: true, assets: { directory: "../client" } }),
        "dist/server/index.js": "export default {};\n",
        "dist/client/robots.txt": "User-agent: *\n",
        "dist/client/_next/static/chunks/docs-search-x.js": `var e=${searchFor(generated({ images: [imageEntry(PNG)] }))};export{e as default};\n`,
        "generated/docs-content.json": generated({ images: [imageEntry(PNG)] }),
        "public/docs/images/topic/a.png": PNG,
        "dist/client/docs/images/topic/a.png": PNG,
        ...extra,
      };
      for (const path of omit) delete files[path];
      return files;
    };

    it("accepts the declared images and rejects undeclared, changed or missing ones", () => {
      expect(audit(landing(dist()), true).ok).toBe(true);
      const cases: Array<[Record<string, string | Buffer>, string[], string]> = [
        [{ "dist/client/docs/images/topic/extra.png": PNG }, [], "dist/client/docs/images/topic/extra.png is not an image referenced"],
        [{ "dist/client/docs/images/topic/a.png": Buffer.concat([PNG, Buffer.from([1])]) }, [], "dist/client/docs/images/topic/a.png does not match"],
        [{}, ["dist/client/docs/images/topic/a.png"], "dist/client/docs/images/topic/a.png is missing"],
      ];
      for (const [extra, omit, message] of cases) {
        const result = audit(landing(dist(extra, omit)), true);
        expect(result.ok, message).toBe(false);
        expect(result.output).toContain(message);
      }
    });

    it("requires the built client to carry the complete search index within its bound", () => {
      const chunk = "dist/client/_next/static/chunks/docs-search-x.js";
      const missing = audit(landing(dist({}, [chunk])), true);
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain("dist/client has no chunk carrying the docs search index");

      const incomplete = audit(landing(dist({ [chunk]: `var e={"revision":"${validRevision}"};\n` })), true);
      expect(incomplete.ok).toBe(false);
      expect(incomplete.output).toContain("carries the content revision but not every published page");

      const oversized = audit(landing(dist({ [chunk]: `var e={"revision":"${validRevision}","route":"/docs/help/alpha","pad":"${"x".repeat(130 * 1024)}"};\n` })), true);
      expect(oversized.ok).toBe(false);
      expect(oversized.output).toContain("is larger than the search index bound");
    });

    it("accepts only public pages in a static sitemap.xml and only the sitemap line in a static robots.txt", () => {
      const sitemap = (...paths: string[]) => `<urlset>${paths.map((path) => `<url><loc>https://pomegr.com${path}</loc></url>`).join("")}</urlset>\n`;
      expect(audit(landing(dist({ "dist/client/sitemap.xml": sitemap("/", "/about", "/download", "/docs/help/alpha"), "dist/client/robots.txt": "User-agent: *\nAllow: /\n\nSitemap: https://pomegr.com/sitemap.xml\n" })), true).ok).toBe(true);

      const cases: Array<[Record<string, string>, string]> = [
        [{ "dist/client/sitemap.xml": sitemap("/docs/help/unpublished") }, "lists a page the site does not publish"],
        [{ "dist/client/sitemap.xml": sitemap("/docs") }, "lists a page the site does not publish"],
        [{ "dist/client/sitemap.xml": "<urlset><url><loc>https://example.com/about</loc></url></urlset>" }, "lists a page the site does not publish"],
        [{ "dist/client/robots.txt": "User-agent: *\nDisallow: /internal-path\n" }, "names a path"],
        [{ "dist/client/robots.txt": "User-agent: *\nSitemap: https://example.com/sitemap.xml\n" }, "points at an unexpected sitemap"],
      ];
      for (const [extra, message] of cases) {
        const result = audit(landing(dist(extra)), true);
        expect(result.ok, message).toBe(false);
        expect(result.output).toContain(message);
      }
    });

    it("requires generated content to exist for an artifact", () => {
      const root = landing(dist());
      rmSync(join(root, "generated"), { recursive: true });
      rmSync(join(root, "public"), { recursive: true });
      const result = audit(root, true);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("missing generated/docs-content.json");
    });

    it("exempts the allowlisted mention only in files carrying the content revision", () => {
      const bundled = `export const docs = {"revision":"${validRevision}","alt":"history of app/Dashboard.tsx"};\n`;
      expect(audit(landing(dist({ "dist/server/docs.js": bundled })), true).ok).toBe(true);

      const unrelated = audit(landing(dist({ "dist/server/other.js": 'export const leak = "app/Dashboard.tsx";\n' })), true);
      expect(unrelated.ok).toBe(false);
      expect(unrelated.output).toMatch(/server[\\/]other\.js contains Dashboard component source/);

      const carrying = audit(landing(dist({ "dist/server/docs.js": `${bundled}export const leak = "monitor/server.mjs";\n` })), true);
      expect(carrying.ok).toBe(false);
      expect(carrying.output).toContain("contains monitor source");
    });
  });
});
