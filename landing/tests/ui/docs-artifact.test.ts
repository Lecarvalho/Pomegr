import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NON_PUBLIC_CANARY_TEXT,
  PUBLIC_CANARY,
  canaryRepo,
  cleanupScratch,
  filesUnder,
  runNode,
  runNpm,
  stageLanding,
} from "./docs-fixtures";
import type { Ran, Repo } from "./docs-fixtures";

// The built artifact (WEB-05). The real landing package is copied beside a fixture documentation
// tree and built with the release commands (`npm run build:audit`), so the prebuild step, the
// source audit, the bundler and the artifact audit all run for real. The fixture holds internal
// pages, a plan, a mockup, an unselected public page and unreferenced images, each carrying a
// canary word; the built `dist/` must contain none of them, and a mistaken manifest must stop the
// build before anything is emitted. The real documentation is never read.

const BUILD_TIMEOUT = 300_000;
afterAll(cleanupScratch);

/** Canaries (and the non-public paths that name them) found in any file under the given roots. */
function leaks(roots: Record<string, string>, extra: Array<{ path: string; data: Buffer }> = []): string[] {
  const found: string[] = [];
  const files = [...Object.entries(roots).flatMap(([label, root]) => filesUnder(root).map((file) => ({ ...file, path: `${label}/${file.path}` }))), ...extra];
  for (const file of files) {
    for (const canary of NON_PUBLIC_CANARY_TEXT) if (file.data.includes(canary)) found.push(`${file.path}: ${canary}`);
    if (/docs[\\/](?:internal|plans|mockups)[\\/]|canary-plan|canary\.md/i.test(file.data.toString("latin1"))) found.push(`${file.path}: non-public path`);
  }
  return found;
}

describe("the artifact built from a fixture repository", () => {
  let repo: Repo;
  let build: Ran;
  const at = (...parts: string[]) => join(repo.landingRoot, ...parts);
  const roots = () => ({ dist: at("dist"), generated: at("generated"), public: at("public", "docs") });

  beforeAll(() => {
    repo = canaryRepo();
    stageLanding(repo);
    build = runNpm(repo.landingRoot, "build:audit");
  }, BUILD_TIMEOUT);

  it("builds and passes the boundary audit, with the prepare step run first by the build", () => {
    expect(build.ok, build.output).toBe(true);
    expect(build.output).toMatch(/docs content prepared: 3 pages, 1 images/);
    expect(build.output).toContain("landing/ source import and content-input boundary verified");
    expect(build.output).toMatch(/landing\/dist boundary verified: \d+ files/);
    expect(existsSync(at("dist", "client"))).toBe(true);
  }, BUILD_TIMEOUT);

  it("ships the selected page text, so the canary scan is meaningful", () => {
    const carrying = filesUnder(at("dist")).filter((file) => file.data.includes(PUBLIC_CANARY));
    expect(carrying.length, "the selected page's own text is in the bundle").toBeGreaterThan(0);
    expect(filesUnder(at("dist")).length).toBeGreaterThan(20);
  });

  it("contains no text or path from any non-public content, in the bundles, assets, index or generated data", () => {
    expect(leaks(roots())).toEqual([]);
  });

  it("carries only the image a selected page references", () => {
    expect(filesUnder(at("dist", "client", "docs", "images")).map((file) => file.path)).toEqual(["topic/shot.jpg"]);
    expect(filesUnder(at("public", "docs")).map((file) => file.path)).toEqual(["images/topic/shot.jpg"]);
  });

  it("detects a leak when one is planted, so the scan above has teeth", () => {
    const planted = [{ path: "dist/client/notes.txt", data: Buffer.from("see the plan: PLANCANARYQZX") }, { path: "dist/client/path.txt", data: Buffer.from("docs/internal/plans/x.md") }];
    expect(leaks({}, planted)).toEqual(["dist/client/notes.txt: PLANCANARYQZX", "dist/client/path.txt: non-public path"]);
  });

  it("fails the artifact audit when a non-public path or a stray asset is added to the built output", () => {
    const audit = () => runNode(repo.landingRoot, ["scripts/assert-artifact-boundary.mjs"]);
    expect(audit().ok).toBe(true);

    writeFileSync(at("dist", "client", "notes.txt"), "see docs/internal/plans/canary-plan.md\n");
    const leak = audit();
    expect(leak.ok).toBe(false);
    expect(leak.output).toContain("contains non-public documentation path");

    writeFileSync(at("dist", "client", "notes.txt"), "clean\n");
    writeFileSync(at("dist", "client", "docs", "images", "topic", "stray.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]));
    const stray = audit();
    expect(stray.ok).toBe(false);
    expect(stray.output).toContain("is not an image referenced by the generated docs content");
  });
});

describe("the build of a repository with a mistaken manifest entry", () => {
  it.each([
    ["a plan", "../internal/plans/canary-plan.md"],
    ["the parent directory", "../"],
  ])("stops at the prepare step for %s, before the bundler or any output", (_name, entry) => {
    const repo = canaryRepo({ version: 1, groups: [{ id: "get-started", title: "Get started", pages: [entry] }] });
    stageLanding(repo);
    const result = runNpm(repo.landingRoot, "build:audit");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Documentation content is invalid");
    expect(result.output).not.toMatch(/Build complete|boundary verified/);
    for (const canary of NON_PUBLIC_CANARY_TEXT) expect(result.output, canary).not.toContain(canary);
    for (const path of ["dist", "generated", join("public", "docs")]) expect(existsSync(join(repo.landingRoot, path)), path).toBe(false);
  }, BUILD_TIMEOUT);
});
