import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDocsContent, writePreparedDocs } from "../../scripts/docs-content.mjs";
import { searchDocs, words } from "../../app/docs/search";
import type { DocsSearchIndex } from "../../scripts/docs-search.mjs";
import {
  NON_PUBLIC_CANARIES,
  NON_PUBLIC_CANARY_TEXT,
  PUBLIC_CANARY,
  baseManifest,
  canaryRepo,
  cleanupScratch,
  filesUnder,
  put,
  rejected,
  runNode,
  stageScripts,
} from "./docs-fixtures";
import type { Repo } from "./docs-fixtures";

// Non-public content cannot enter the pages, assets, search index or sitemap (WEB-05), even through
// a mistaken manifest entry. Every case runs against a fixture repository, never the real
// documentation: a valid publication beside internal pages, a plan, a mockup, an unselected public
// page and images, each carrying a canary word that must not appear in anything the site ships.
// The boundary and loader tests cover each rule; this file proves the outcome end to end. The
// companion docs-artifact.test.ts builds the fixture site for real.

afterEach(cleanupScratch);

const manifestWith = (...pages: string[]) => ({ version: 1, groups: [{ id: "get-started", title: "Get started", pages }] });

/** A fixture whose manifest names `entry(repo)`, computed after the repository exists so absolute paths are real. */
function repoSelecting(entry: (repo: Repo) => string): Repo {
  const repo = canaryRepo();
  put(join(repo.docs, "site.json"), JSON.stringify(manifestWith(entry(repo))));
  return repo;
}

const slashes = (path: string) => path.split("\\").join("/");
const planFile = (repo: Repo) => join(repo.docs, "internal", "plans", "canary-plan.md");

// Entries an author could plausibly write by mistake, or an attacker on purpose, to publish
// something that is not a public page. Each is named for what it tries to reach.
const mistakes: Array<[string, (repo: Repo) => string]> = [
  ["a plan as a sibling of docs/public", () => "../internal/plans/canary-plan.md"],
  ["a plan without the parent segment", () => "internal/plans/canary-plan.md"],
  ["a plan through its own group", () => "get-started/../../internal/plans/canary-plan.md"],
  ["a plan from the repository root", () => "docs/internal/plans/canary-plan.md"],
  ["a plan through the repository root", () => "../../docs/internal/plans/canary-plan.md"],
  ["an internal architecture page", () => "../internal/architecture/canary.md"],
  ["a mockup", () => "../mockups/canary.html"],
  ["the parent directory", () => "../"],
  ["the parent directory without a slash", () => ".."],
  ["two parent directories", () => "../.."],
  ["the current directory", () => "."],
  ["the plans directory", () => "../internal/plans/"],
  ["a glob over the plans", () => "../internal/plans/*.md"],
  ["a rooted path", () => "/docs/internal/plans/canary-plan.md"],
  ["the absolute path of the plan", (repo) => slashes(planFile(repo))],
  ["the absolute path of the plan without its drive", (repo) => slashes(planFile(repo)).replace(/^[A-Za-z]:/, "")],
  ["the absolute Windows path of the plan", (repo) => planFile(repo).replace(/\//g, "\\")],
  ["a file URL to the plan", (repo) => `file:///${slashes(planFile(repo)).replace(/^\//, "")}`],
  ["a UNC path", () => "\\\\server\\share\\docs\\internal\\plans\\canary-plan.md"],
  ["an encoded traversal", () => "%2e%2e/internal/plans/canary-plan.md"],
  ["a double-encoded traversal", () => "%252e%252e/internal/plans/canary-plan.md"],
  ["a backslash traversal", () => "..\\internal\\plans\\canary-plan.md"],
];

describe("a mistaken manifest entry", () => {
  it.each(mistakes)("is rejected, with nothing loaded and no canary in the message: %s", (_name, entry) => {
    const text = rejected(repoSelecting(entry));
    for (const canary of NON_PUBLIC_CANARY_TEXT) expect(text, canary).not.toContain(canary);
    expect(text).toContain("docs/site.json");
  });

  it("is rejected even beside valid pages, so one mistake stops the whole build", () => {
    const repo = canaryRepo(manifestWith("get-started/alpha.md", "../internal/plans/canary-plan.md", "get-started/beta.md"));
    const text = rejected(repo);
    expect(text).toContain("pages[1]");
    expect(text).not.toContain(NON_PUBLIC_CANARIES.plan);
  });

  it("names a missing public page instead of reading an internal page of the same name", () => {
    const repo = canaryRepo(manifestWith("get-started/canary-plan.md"));
    expect(rejected(repo)).toContain("docs/public/get-started/canary-plan.md does not exist");
  });
});

// The prepare step is what `predev`, `pretest`, `pretypecheck` and `prebuild` run, so a failure
// there stops the build before anything is generated. A copy of the real script runs here.
describe("the prepare step on a mistaken manifest", () => {
  const outputs = (repo: Repo) => [join(repo.landingRoot, "generated"), join(repo.landingRoot, "public")];

  function prepare(repo: Repo, ...flags: string[]) {
    stageScripts(repo);
    return runNode(repo.landingRoot, ["scripts/prepare-docs.mjs", ...flags]);
  }

  it.each([
    ["a plan", () => "../internal/plans/canary-plan.md"],
    ["the parent directory", () => "../"],
    ["the absolute path of a plan", planFile],
  ])("fails for %s, writes nothing, and reveals no canary", (_name, entry) => {
    for (const flags of [[], ["--check"]]) {
      const repo = repoSelecting(entry);
      const result = prepare(repo, ...flags);
      expect(result.ok, `${flags.join(" ")}\n${result.output}`).toBe(false);
      expect(result.output).toContain("Documentation content is invalid");
      for (const canary of NON_PUBLIC_CANARY_TEXT) expect(result.output, canary).not.toContain(canary);
      for (const path of outputs(repo)) expect(existsSync(path), path).toBe(false);
    }
  });

  it("fails when a public directory is a junction into the plans, and copies nothing from them", () => {
    const repo = canaryRepo(manifestWith("get-started/canary-plan.md"));
    // docs/public/get-started becomes a link to docs/internal/plans, which holds canary-plan.md.
    const group = join(repo.publicRoot, "get-started");
    rmSync(group, { recursive: true });
    try {
      symlinkSync(join(repo.docs, "internal", "plans"), group, "junction");
    } catch {
      return; // The platform does not allow links here; the loader tests skip the same way.
    }
    const result = prepare(repo);
    expect(result.ok, result.output).toBe(false);
    expect(result.output).toContain("passes through a symbolic link or junction");
    expect(result.output).not.toContain(NON_PUBLIC_CANARIES.plan);
    for (const path of outputs(repo)) expect(existsSync(path), path).toBe(false);
  });

  it("succeeds for the valid publication and writes exactly its pages and image", () => {
    const repo = canaryRepo();
    const result = prepare(repo);
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain("docs content prepared: 3 pages, 1 images");
    expect(filesUnder(join(repo.landingRoot, "public")).map((file) => file.path)).toEqual(["docs/images/topic/shot.jpg"]);
  });
});

// A correct manifest beside every kind of non-public content: the pages, assets, search index and
// sitemap carry only what the manifest selects.
describe("a valid publication beside non-public content", () => {
  function prepared() {
    const repo = canaryRepo();
    const result = loadDocsContent({ landingRoot: repo.landingRoot });
    const written = writePreparedDocs({ landingRoot: repo.landingRoot, ...result });
    return { repo, ...result, ...written };
  }
  const textOf = (files: Array<{ data: Buffer }>) => files.map((file) => file.data.toString("latin1")).join("\n");

  it("publishes exactly the selected pages, without any canary or non-public path", () => {
    const { content, contentFile } = prepared();
    expect(content.pages.map((page) => page.source)).toEqual(baseManifest.groups.flatMap((group) => group.pages));
    const json = readFileSync(contentFile, "utf8");
    expect(json).toContain(PUBLIC_CANARY);
    for (const canary of NON_PUBLIC_CANARY_TEXT) expect(json, canary).not.toContain(canary);
    expect(json).not.toMatch(/docs[\\/](?:internal|plans|mockups)|hidden\.md|canary-plan/i);
  });

  it("mirrors only the images a selected page references", () => {
    const { content, imagesRoot } = prepared();
    const images = filesUnder(imagesRoot);
    expect(images.map((image) => image.path)).toEqual(["topic/shot.jpg"]);
    expect(content.images.map((image) => image.route)).toEqual(["/docs/images/topic/shot.jpg"]);
    for (const canary of [NON_PUBLIC_CANARIES.unreferencedImage, NON_PUBLIC_CANARIES.internalImage]) expect(textOf(images), canary).not.toContain(canary);
  });

  it("indexes exactly the selected pages, and no canary word finds anything", () => {
    const { content, searchFile } = prepared();
    const serialized = readFileSync(searchFile, "utf8");
    const index = JSON.parse(serialized) as DocsSearchIndex;
    expect(index.revision).toBe(content.revision);
    expect(index.pages.map((page) => page.route)).toEqual(content.pages.map((page) => page.route));
    for (const canary of NON_PUBLIC_CANARY_TEXT) {
      expect(serialized, canary).not.toContain(canary);
      for (const word of words(canary)) expect(searchDocs(index, word).total, word).toBe(0);
    }
    for (const query of ["internal", "plans", "mockups", "hidden", "canary"]) expect(searchDocs(index, query).total, query).toBe(0);
    expect(searchDocs(index, PUBLIC_CANARY).results.map((result) => result.page.route)).toEqual(["/docs/get-started/alpha"]);
  });

  it("lists exactly the site pages and the selected pages in the sitemap", async () => {
    const { content } = prepared();
    vi.resetModules();
    vi.doMock("../../app/docs/content", () => ({ docsContent: content }));
    try {
      const { default: sitemap } = await import("../../app/sitemap");
      const urls = sitemap().map((entry) => entry.url);
      const routes = ["/", "/about", "/download", "/docs/get-started/alpha", "/docs/get-started/beta", "/docs/concepts/gamma"];
      expect(urls).toEqual(routes.map((route) => `https://pomegr.com${route}`));
      expect(urls.join("\n")).not.toMatch(/internal|plans|mockups|hidden|canary|\.md\b/i);
    } finally {
      vi.doUnmock("../../app/docs/content");
      vi.resetModules();
    }
  });

  it("writes nothing beyond the content, the index and the selected image, and no canary in any of them", () => {
    const { repo } = prepared();
    const files = [
      ...filesUnder(join(repo.landingRoot, "generated")).map((file) => ({ ...file, path: `generated/${file.path}` })),
      ...filesUnder(join(repo.landingRoot, "public")).map((file) => ({ ...file, path: `public/${file.path}` })),
    ];
    expect(files.map((file) => file.path)).toEqual(["generated/docs-content.json", "generated/docs-search.json", "public/docs/images/topic/shot.jpg"]);
    for (const canary of NON_PUBLIC_CANARY_TEXT) for (const file of files) expect(file.data.includes(canary), `${canary} in ${file.path}`).toBe(false);
  });
});
