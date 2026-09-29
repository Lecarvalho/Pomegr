import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRepositoryPathValidator, DEFAULT_ROOT_IDENTITY_RECHECK_MS, isRepositoryRelativePath, repositoryRelativePath } from "../../../server/normalize/repository-path.mjs";

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
      "../../../notes.txt", "src/../notes.txt", "src//notes.txt", "src/./notes.txt", "notes\u0000.txt",
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

test("cached repository path validator matches the uncached function on every existing case", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    const privateRoot = path.join(repositoryRoot, "private-provider");
    await mkdir(privateRoot);
    const cases = [
      ["src/components/Button.tsx", repositoryRoot, undefined],
      ["docs\\architecture\\cache.md", repositoryRoot, undefined],
      [path.join(repositoryRoot, "src", "private.mjs"), repositoryRoot, undefined],
      ["/etc/passwd", repositoryRoot, undefined],
      ["C:notes.txt", repositoryRoot, undefined],
      ["../../../notes.txt", repositoryRoot, undefined],
      ["src/../notes.txt", repositoryRoot, undefined],
      ["notes\u0000.txt", repositoryRoot, undefined],
      ["CON", repositoryRoot, undefined],
      ["COM1", repositoryRoot, undefined],
      [".claude/settings.json", repositoryRoot, undefined],
      ["private-provider/token.json", repositoryRoot, { forbiddenRoots: [privateRoot] }],
      ["src/public.json", repositoryRoot, { forbiddenRoots: [privateRoot] }],
      ["src/public.json", repositoryRoot, { forbiddenRoots: ["relative"] }],
      ["src/file.txt", path.join(repositoryRoot, "missing"), undefined],
    ];
    const validate = createRepositoryPathValidator();
    for (const [value, root, options] of cases) {
      assert.equal(validate(value, root, options), repositoryRelativePath(value, root, options), value);
      // A second call must reuse the cache and still agree with the uncached function.
      assert.equal(validate(value, root, options), repositoryRelativePath(value, root, options), `${value} (cached)`);
    }
  });
});

test("cached repository path validator keeps a rejection rejected for the TTL even after the target becomes valid", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    let clock = 1_000;
    const validate = createRepositoryPathValidator({ ttlMs: 5_000, now: () => clock });
    const escape = path.join(repositoryRoot, "escape");
    try {
      await symlink(outsideRoot, escape, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
      return;
    }
    assert.equal(validate("escape/file.txt", repositoryRoot), null);

    // Replace the escaping link with a plain, contained directory.
    await rm(escape, { recursive: true, force: true });
    await mkdir(escape);
    clock += 1_000;
    // Still within the TTL: the cached rejection must be served even though a
    // fresh, uncached check would now accept the same path.
    assert.equal(validate("escape/file.txt", repositoryRoot), null);
    assert.notEqual(repositoryRelativePath("escape/file.txt", repositoryRoot), null);
  });
});

test("cached repository path validator invalidates when the recognized root itself changes identity", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    const fartherOutside = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-path-farther-"));
    try {
      // Under the ORIGINAL root, "link" is a plain, contained directory, so a
      // not-yet-existing nested target validates and gets cached as accepted.
      await mkdir(path.join(repositoryRoot, "link"));
      const clock = { value: 1_000 };
      const validate = createRepositoryPathValidator({ ttlMs: 60_000, now: () => clock.value });
      assert.equal(validate("link/target.txt", repositoryRoot), "link/target.txt");

      // Under the REPLACEMENT root (same string, different identity), "link"
      // is itself a symlink escaping to a third location outside the root.
      try {
        await symlink(fartherOutside, path.join(outsideRoot, "link"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
        return;
      }
      await rm(repositoryRoot, { recursive: true, force: true });
      try {
        await symlink(outsideRoot, repositoryRoot, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
        return;
      }

      clock.value += DEFAULT_ROOT_IDENTITY_RECHECK_MS; // Past the root re-check, still well within the entry TTL.
      // A stale hit would keep serving "link/target.txt"; the identity change
      // must force a fresh check that rejects the now-escaping "link" segment.
      assert.equal(validate("link/target.txt", repositoryRoot), null);
    } finally {
      await rm(fartherOutside, { recursive: true, force: true });
    }
  });
});

test("cached repository path validator re-validates after TTL expiry and rejects a path that became an escaping symlink", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    const clock = { value: 1_000 };
    const validate = createRepositoryPathValidator({ ttlMs: 5_000, now: () => clock.value });
    const target = path.join(repositoryRoot, "escape");
    await mkdir(target);
    assert.equal(validate("escape/private.txt", repositoryRoot), "escape/private.txt");

    await writeFile(path.join(outsideRoot, "private.txt"), "outside content");
    await rmdir(target);
    try {
      await symlink(outsideRoot, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
      return;
    }

    // Still within the TTL: the stale acceptance is served even though the
    // path now escapes the root.
    assert.equal(validate("escape/private.txt", repositoryRoot), "escape/private.txt");
    clock.value += 5_001;
    assert.equal(validate("escape/private.txt", repositoryRoot), null);
  });
});

test("cached repository path validator bounds its entry count and evicts the oldest entries first", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    const validate = createRepositoryPathValidator({ ttlMs: 60_000, maxEntries: 4 });
    const count = 10;
    for (let index = 0; index < count; index += 1) {
      const directory = path.join(repositoryRoot, `real-${index}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "target.txt"), "content");
    }
    for (let index = 0; index < count; index += 1) {
      assert.equal(validate(`real-${index}/target.txt`, repositoryRoot), `real-${index}/target.txt`, `initial ${index}`);
    }

    // Turn every target directory into an escape; a re-check would now reject it.
    let canLink = true;
    for (let index = 0; index < count && canLink; index += 1) {
      const directory = path.join(repositoryRoot, `real-${index}`);
      await rm(directory, { recursive: true, force: true });
      try {
        await symlink(outsideRoot, directory, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        canLink = false;
        context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
      }
    }
    if (!canLink) return;

    // Only the last maxEntries (4) distinct calls stayed cached; check those
    // first, since revalidating an evicted key below inserts a fresh entry
    // and would otherwise evict a still-retained one before it is checked.
    for (let index = count - 4; index < count; index += 1) {
      assert.equal(validate(`real-${index}/target.txt`, repositoryRoot), `real-${index}/target.txt`, `retained ${index}`);
    }
    // Everything earlier must be re-checked against disk and rejected as an escape.
    for (let index = 0; index < count - 4; index += 1) {
      assert.equal(validate(`real-${index}/target.txt`, repositoryRoot), null, `evicted ${index}`);
    }
  });
});

test("cached repository path validator checks the recognized root at most once per re-check window", async () => {
  await withRoots(async ({ repositoryRoot }) => {
    const clock = { value: 1_000 };
    const validate = createRepositoryPathValidator({ ttlMs: 60_000, now: () => clock.value });
    let realpathCalls = 0;
    const realpath = fs.realpathSync.native;
    fs.realpathSync.native = (...args) => { realpathCalls += 1; return realpath(...args); };
    try {
      validate("one.txt", repositoryRoot);
      const afterFirst = realpathCalls;
      for (let index = 0; index < 20; index += 1) validate(`one.txt`, repositoryRoot);
      assert.equal(realpathCalls, afterFirst, "cached hits within the window never re-resolve the root");
      clock.value += DEFAULT_ROOT_IDENTITY_RECHECK_MS;
      validate("one.txt", repositoryRoot);
      assert.equal(realpathCalls, afterFirst + 1, "one root re-check after the window");
    } finally {
      fs.realpathSync.native = realpath;
    }
  });
});

test("cached repository path validator never files a retargeted root's answer under the original root", async (context) => {
  await withRoots(async ({ repositoryRoot, outsideRoot }) => {
    const base = path.dirname(repositoryRoot);
    const rootA = path.join(base, "root-a");
    const rootB = path.join(base, "root-b");
    const cwd = path.join(base, "cwd");
    await Promise.all([mkdir(rootA), mkdir(path.join(rootB, "dir"), { recursive: true })]);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(outsideRoot, path.join(rootA, "dir"), linkType); // escapes under A
      await symlink(rootA, cwd, linkType);
    } catch (error) {
      context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
      return;
    }
    const clock = { value: 1_000 };
    const validate = createRepositoryPathValidator({ ttlMs: 60_000, now: () => clock.value });
    assert.equal(validate("other.txt", cwd), "other.txt"); // memoizes A's identity
    await rmdir(cwd);
    await symlink(rootB, cwd, linkType);
    clock.value += 1; // within the root memo: the key still names A
    assert.equal(validate("dir/f.txt", cwd), "dir/f.txt", "correct for B, the root at validation time");
    await rmdir(cwd);
    await symlink(rootA, cwd, linkType);
    clock.value += DEFAULT_ROOT_IDENTITY_RECHECK_MS;
    assert.equal(repositoryRelativePath("dir/f.txt", cwd), null);
    assert.equal(validate("dir/f.txt", cwd), null, "B's acceptance must not be served for A");
  });
});
