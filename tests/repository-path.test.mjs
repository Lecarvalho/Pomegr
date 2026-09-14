import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isRepositoryRelativePath, repositoryRelativePath } from "../monitor/repository-path.mjs";

async function withRoots(run) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-path-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await Promise.all([mkdir(repositoryRoot), mkdir(outsideRoot)]);
  try {
    await run({ repositoryRoot, outsideRoot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("repository path normalizes nested slash spellings under a recognized root", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    assert.equal(repositoryRelativePath("src/components/Button.tsx", repositoryRoot), "src/components/Button.tsx");
    assert.equal(repositoryRelativePath("docs\\architecture\\cache.md", repositoryRoot), "docs/architecture/cache.md");
    assert.equal(isRepositoryRelativePath("assets/icon.svg", repositoryRoot), true);
  });
});

test("repository path rejects non-relative, traversal, and control-character inputs", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    const rejected = [
      path.join(repositoryRoot, "src", "private.mjs"), "/etc/passwd", "C:notes.txt", "C:/notes.txt",
      "\\\\server\\share\\notes.txt", "\\\\?\\C:\\notes.txt", "\\\\.\\pipe\\private", "\\rooted\\notes.txt",
      "../notes.txt", "src/../notes.txt", "src//notes.txt", "src/./notes.txt", "notes\u0000.txt",
    ];
    for (const candidate of rejected) assert.equal(repositoryRelativePath(candidate, repositoryRoot), null, candidate);
  });
});

test("repository path rejects ADS, DOS-device, and Windows-normalized unsafe names", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    const rejected = [
      "report.txt:stream", "src:alternate/file.txt", "CON", "con.txt", "PRN  .txt", "AUX", "NUL ",
      "COM1", "LPT9.csv", "COM¹.log", "CLOCK$", "CONIN$", "CONOUT$", "file.", "file ",
    ];
    for (const candidate of rejected) assert.equal(repositoryRelativePath(candidate, repositoryRoot), null, candidate);
  });
});

test("repository path excludes provider and caller-designated private roots", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    const privateRoot = path.join(repositoryRoot, "private-provider");
    await mkdir(privateRoot);
    assert.equal(repositoryRelativePath(".claude/settings.json", repositoryRoot), null);
    assert.equal(repositoryRelativePath("src/.codex/config.json", repositoryRoot), null);
    assert.equal(repositoryRelativePath("private-provider/token.json", repositoryRoot, { forbiddenRoots: [privateRoot] }), null);
    assert.equal(repositoryRelativePath("src/public.json", repositoryRoot, { forbiddenRoots: [privateRoot] }), "src/public.json");
    assert.equal(repositoryRelativePath("src/public.json", repositoryRoot, { forbiddenRoots: ["relative"] }), null);
  });
});

test("repository path fails closed for an unknown root and symlink or junction escapes", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    assert.equal(repositoryRelativePath("src/file.txt", path.join(repositoryRoot, "missing")), null);
    await writeFile(path.join(outsideRoot, "private.txt"), "test");
    const escape = path.join(repositoryRoot, "escape");
    try {
      await symlink(outsideRoot, escape, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
      return;
    }
    assert.equal(repositoryRelativePath("escape/private.txt", repositoryRoot), null);
  });
});
