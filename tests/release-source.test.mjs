import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkReleaseSource } from "../scripts/check-release-source.mjs";

const privacyMarker = "SYNTHETIC_PRIVACY_MUST_NOT_LEAK";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
}

async function fixture(context, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-release-source-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  for (const [relativePath, contents] of Object.entries({ "src/safe.mjs": "export {};\n", ...files })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  git(root, ["tag", "v1.2.3"]);
  return root;
}

test("release source check permits privacy sentinels in tests", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fixture(context, { "tests/fixture.txt": privacyMarker.repeat(10_000) });
  assert.deepEqual(await checkReleaseSource({ repositoryRoot: root, tag: "v1.2.3" }), { tag: "v1.2.3", version: "1.2.3" });
});

test("release source check rejects privacy sentinels outside tests", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fixture(context, { "docs/plan.md": privacyMarker.repeat(10_000) });
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, tag: "v1.2.3" }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
});

test("release source check accepts a safe tagged tree", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fixture(context);
  assert.equal((await checkReleaseSource({ repositoryRoot: root, tag: "v1.2.3" })).version, "1.2.3");
});

test("release source check fails closed for absent and mismatched tags", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fixture(context);
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, tag: "v9.9.9" }), /RELEASE_SOURCE_TAG_NOT_FOUND/);
  git(root, ["tag", "v1.2.4"]);
  await assert.rejects(checkReleaseSource({ repositoryRoot: root, tag: "v1.2.4" }), /TAG_VERSION_MISMATCH/);
});
