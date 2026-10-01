import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkReleaseSource } from "../scripts/check-release-source.mjs";
import { assertFileHasNoPrivacySentinel, assertReleasePublishPrivacy } from "../desktop/runtime/artifact-privacy.mjs";

const tarExecutable = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "/usr/bin/tar";

async function sourceFixture(t, sentinelPath = "tests/fixture.txt") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Synthetic Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.compression", "0");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await mkdir(path.dirname(path.join(root, sentinelPath)), { recursive: true });
  await writeFile(path.join(root, sentinelPath), "PROMPT_MUST_NOT_LEAK");
  git("add", ".");
  git("commit", "--quiet", "-m", "synthetic source");
  git("tag", "v1.2.3");
  const archive = (filename) => git("archive", "--format=zip", "--prefix=pomegr-1.2.3/", "--output", filename, "HEAD");
  return { root, archive };
}

test("source checks permit stored test sentinels for both a release tag and an untagged CI ref", async (t) => {
  const { root, archive } = await sourceFixture(t);
  const zip = path.join(root, "fixture.zip");
  archive(zip);
  // Prove this fixture exercises the original failure, independent of compression.
  await assert.rejects(assertFileHasNoPrivacySentinel(zip), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
  assert.equal((await checkReleaseSource({ repositoryRoot: root, tag: "v1.2.3" })).version, "1.2.3");
  execFileSync("git", ["tag", "-d", "v1.2.3"], { cwd: root, stdio: "pipe" });
  assert.equal((await checkReleaseSource({ repositoryRoot: root, ref: "HEAD" })).ref, "HEAD");
});

test("source checks reject production sentinels and mismatched release tags", async (t) => {
  const { root } = await sourceFixture(t, "desktop/runtime/fixture.mjs");
  for (const selection of [{ tag: "v1.2.3" }, { ref: "HEAD" }]) {
    await assert.rejects(checkReleaseSource({ repositoryRoot: root, ...selection }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
  }
  execFileSync("git", ["tag", "v1.2.4"], { cwd: root, stdio: "pipe" });
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, tag: "v1.2.4" }), /DESKTOP_RELEASE_TAG_VERSION_MISMATCH/);
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, tag: "v1.2.3", ref: "HEAD" }), /RELEASE_SOURCE_REFERENCE_INVALID/);
});

test("source checks reject sentinel examples quoted in documentation", async (t) => {
  const { root } = await sourceFixture(t, "docs/internal/plans/fixture.md");
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, ref: "HEAD" }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
});

test("final publication applies source fixture allowance only after real ZIP extraction", async (t) => {
  // Adapt the 7za invocation to system tar so this regression needs no builder cache.
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (_executable, args, options) =>
    originalSpawn(tarExecutable, ["-xf", args[3], "-C", args[2].slice(2)], options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  for (const sentinelPath of ["tests/fixture.txt", "app/fixture.js"]) {
    const { root, archive } = await sourceFixture(t, sentinelPath);
    const publish = path.join(root, "publish");
    await mkdir(publish);
    const name = "Pomegr-1.2.3-source.zip";
    archive(path.join(publish, name));
    const scan = () => assertReleasePublishPrivacy(publish, [name], { extractorPath: tarExecutable });
    if (sentinelPath.startsWith("tests/")) {
      await scan();
      await assert.rejects(assertReleasePublishPrivacy(publish, [name], { extractorPath: false }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
      await writeFile(path.join(publish, "NOTICE"), "PROMPT_MUST_NOT_LEAK");
      await assert.rejects(assertReleasePublishPrivacy(publish, [name, "NOTICE"], { extractorPath: tarExecutable }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
    } else {
      await assert.rejects(scan(), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
    }
  }
});

test("Windows verification checks its checkout source without requiring release tags", async () => {
  const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm run check:release-source -- --ref HEAD/);
});
