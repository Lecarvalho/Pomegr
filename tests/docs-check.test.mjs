import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CheckDocsSetupError, checkDocs } from "../scripts/check-docs.mjs";

// `npm run check:docs` against throwaway repositories: a good one passes, and each broken
// rule fails with its own rule name. The public-page rules belong to the landing loader, so
// those cases need `npm ci --prefix landing`.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repositoryRoot, "scripts", "check-docs.mjs");
const landingReady = existsSync(join(repositoryRoot, "landing", "node_modules", "marked", "package.json"));
const needsLanding = { skip: landingReady ? false : "landing dependencies are not installed (npm ci --prefix landing)" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const FENCE = "```";
const scratch = [];
after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

const page = (title, body) => `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(`About ${title}.`)}\n---\n\n# ${title}\n\n${body}\n`;

// Replacement pages keep the headings the rest of the fixture links to.
const introPage = (body) => page("Introduction", `${body}\n\n## First heading\n`);
const cachePage = (body) => page("Cache", `## Reuse\n\n${body}`);
const guide = (body) => `# Guide\n\n${body}\n\n## Deploy notes\n`;

const manifest = {
  version: 1,
  groups: [
    { id: "get-started", title: "Get started", pages: ["get-started/intro.md"] },
    { id: "using-pomegr", title: "Using Pomegr", pages: [] },
    { id: "concepts", title: "Concepts", pages: ["concepts/cache.md"] },
    { id: "help", title: "Help", pages: [] },
  ],
};

/** The files of a good repository. A test replaces a path with new content, or with `null` to omit it. */
function goodFiles() {
  return {
    "README.md": "# Fixture\n\nSee the [documentation index](docs/README.md).\n",
    "docs/README.md": "# Documentation\n\n- [Introduction](public/get-started/intro.md)\n- [Guide](internal/guide.md#deploy-notes)\n",
    "docs/site.json": JSON.stringify(manifest),
    "docs/public/get-started/intro.md": introPage(
      "Start here, then read [cache reuse](../concepts/cache.md#reuse).\n\n![A screenshot of the intro view.](../images/intro/shot.png)",
    ),
    "docs/public/concepts/cache.md": cachePage("Back to the [introduction](../get-started/intro.md#first-heading)."),
    "docs/public/images/intro/shot.png": PNG,
    "docs/internal/guide.md": guide(
      [
        "Internal pages may link public pages: [introduction](../public/get-started/intro.md#first-heading).",
        "",
        "Links inside code are examples, not links: `[x](missing.md)`.",
        "",
        `${FENCE}markdown`,
        "[also an example](missing-too.md)",
        FENCE,
      ].join("\n"),
    ),
    "docs/internal/plans/ia-redesign/prototype/readme.md": "# Exported prototype\n\n[Skipped](missing.md)\n",
  };
}

function makeRepository(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pomegr-check-docs-"));
  scratch.push(root);
  for (const [path, data] of Object.entries({ ...goodFiles(), ...overrides })) {
    if (data === null) continue;
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
  }
  return root;
}

const run = (overrides) => checkDocs({ root: makeRepository(overrides) });
const rules = (result) => result.failures.map((item) => item.rule);
const find = (result, rule) => result.failures.find((item) => item.rule === rule);

describe("check:docs good repository", needsLanding, () => {
  it("passes, lets an internal page link a public page, ignores links inside code, and counts what it scanned", async () => {
    const result = await run();
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(result.summary.failures, 0);
    assert.equal(result.summary.publicPages, 2);
    assert.equal(result.summary.publicImages, 1);
    assert.equal(result.summary.publicFiles, 3);
    assert.equal(result.summary.boundaryPages, 2);
    // README.md, docs/README.md, docs/internal/guide.md and the two public pages; the prototype directory is skipped.
    assert.equal(result.summary.markdownFiles, 5);
    assert.ok(result.summary.anchors >= 4);
    assert.ok(result.summary.searchIndexBytes < result.summary.searchIndexMaxBytes);
  });
});

describe("check:docs maintained Markdown", needsLanding, () => {
  it("fails a broken relative link with its file and line", async () => {
    const result = await run({ "docs/internal/guide.md": guide("See [the plan](plans/gone.md).") });
    assert.equal(result.ok, false);
    const item = find(result, "missing-file");
    assert.equal(item.file, "docs/internal/guide.md");
    assert.equal(item.line, 3);
    assert.match(item.message, /plans\/gone\.md/);
  });

  it("requires exact case, as GitHub does", async () => {
    const result = await run({ "docs/README.md": "# Documentation\n\n[Guide](internal/Guide.md)\n" });
    assert.ok(rules(result).includes("missing-file"));
  });

  it("fails an anchor that no heading produces, and accepts the GitHub slug", async () => {
    const bad = await run({ "docs/README.md": "# Documentation\n\n[Guide](internal/guide.md#no-such-heading)\n" });
    assert.equal(find(bad, "missing-anchor").file, "docs/README.md");
    const good = await run({ "docs/README.md": "# Documentation\n\n[Guide](internal/guide.md#deploy-notes) and [self](#documentation)\n" });
    assert.equal(good.ok, true);
  });

  it("fails an image without alt text, including raw HTML images", async () => {
    const markdown = await run({ "docs/internal/guide.md": guide("![](../public/images/intro/shot.png)") });
    assert.equal(find(markdown, "empty-alt").line, 3);
    const html = await run({ "docs/internal/guide.md": guide('<img src="../public/images/intro/shot.png">') });
    assert.ok(rules(html).includes("empty-alt"));
  });

  it("fails a missing image file", async () => {
    const result = await run({ "docs/internal/guide.md": guide("![Missing screenshot](../public/images/intro/gone.png)") });
    assert.ok(rules(result).includes("missing-image"));
  });
});

describe("check:docs public documentation", needsLanding, () => {
  it("fails a public page without alt text", async () => {
    const result = await run({ "docs/public/get-started/intro.md": introPage("![](../images/intro/shot.png)") });
    assert.equal(result.ok, false);
    assert.match(find(result, "public-content").message, /alt/i);
  });

  it("fails raw HTML in a public page with its line", async () => {
    const result = await run({ "docs/public/concepts/cache.md": cachePage("<div>not supported</div>") });
    const item = find(result, "public-content");
    assert.equal(item.file, "docs/public/concepts/cache.md");
    assert.match(item.message, /HTML/i);
    assert.ok(item.line > 1);
  });

  it("fails a public page that links internal documentation", async () => {
    const result = await run({ "docs/public/concepts/cache.md": cachePage("See the [guide](../../internal/guide.md).") });
    assert.equal(result.ok, false);
    const item = find(result, "public-boundary");
    assert.equal(item.file, "docs/public/concepts/cache.md");
    assert.match(item.message, /internal documentation/);
    assert.ok(rules(result).includes("public-content"), "the landing loader rejects the same link");
  });

  it("fails a public page that links internal documentation through GitHub", async () => {
    const link = "[guide](https://github.com/example/pomegr/blob/main/docs/internal/guide.md)";
    const result = await run({ "docs/public/concepts/cache.md": cachePage(`See the ${link}.`) });
    assert.match(find(result, "public-boundary").message, /internal documentation/);
  });

  it("allows external links and links between public pages", async () => {
    const link = "[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing)";
    const result = await run({ "docs/public/concepts/cache.md": cachePage(`See ${link} and the [introduction](../get-started/intro.md).`) });
    assert.deepEqual(result.failures, []);
  });

  it("fails a public page the manifest does not select, and checks its links too", async () => {
    const result = await run({ "docs/public/concepts/draft.md": page("Draft", "Not ready. See [guide](../../internal/guide.md).") });
    assert.equal(find(result, "unselected-page").file, "docs/public/concepts/draft.md");
    assert.equal(find(result, "public-boundary").file, "docs/public/concepts/draft.md");
  });

  it("fails a public page that links an unselected public page", async () => {
    const result = await run({
      "docs/public/concepts/draft.md": page("Draft", "Not ready."),
      "docs/public/concepts/cache.md": cachePage("See the [draft](draft.md)."),
    });
    assert.match(find(result, "public-content").message, /does not select/);
  });

  it("fails a public image no selected page references", async () => {
    const result = await run({ "docs/public/images/intro/stale.png": PNG });
    assert.equal(find(result, "unreferenced-asset").file, "docs/public/images/intro/stale.png");
  });

  it("fails a manifest entry that has no page", async () => {
    const broken = { ...manifest, groups: [{ ...manifest.groups[0], pages: ["get-started/intro.md", "get-started/gone.md"] }, ...manifest.groups.slice(1)] };
    const result = await run({ "docs/site.json": JSON.stringify(broken) });
    assert.equal(result.ok, false);
    assert.match(find(result, "public-content").message, /gone\.md/);
  });

  it("fails a search index above its size bound", async () => {
    const headings = Array.from({ length: 4000 }, (_, index) => `## Heading number ${index}\n`).join("\n");
    const result = await run({ "docs/public/concepts/cache.md": cachePage(headings) });
    assert.match(find(result, "search-index").message, /bound/);
  });
});

describe("check:docs setup and command line", () => {
  it("reports missing landing dependencies as a setup error with the fix", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pomegr-check-docs-loader-"));
    scratch.push(directory);
    const loader = join(directory, "loader.mjs");
    writeFileSync(loader, 'import "pomegr-check-docs-missing-dependency";\nexport {};\n');
    await assert.rejects(
      checkDocs({ root: directory, importModules: () => import(pathToFileURL(loader).href) }),
      (error) => error instanceof CheckDocsSetupError && /npm ci --prefix landing/.test(error.message) && /pomegr-check-docs-missing-dependency/.test(error.message),
    );
  });

  const cli = (root, ...args) => spawnSync(process.execPath, [scriptPath, "--root", root, ...args], { encoding: "utf8" });
  const brokenGuide = { "docs/internal/guide.md": guide("[gone](gone.md)") };

  it("exits 0 and prints a summary for a good repository", needsLanding, () => {
    const result = cli(makeRepository());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /result\s+passed/);
  });

  it("exits 1 and names file, line, and rule for a broken repository", needsLanding, () => {
    const result = cli(makeRepository(brokenGuide));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/internal\/guide\.md:3: missing-file:/);
    assert.match(result.stdout, /1 failure/);
  });

  it("prints machine-readable output with --json", needsLanding, () => {
    const broken = cli(makeRepository(brokenGuide), "--json");
    assert.equal(broken.status, 1);
    const report = JSON.parse(broken.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0].rule, "missing-file");
    assert.equal(report.summary.failures, 1);
    assert.equal(JSON.parse(cli(makeRepository(), "--json").stdout).ok, true);
  });

  it("exits 2 for an unknown argument", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--nope"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage/);
  });
});
