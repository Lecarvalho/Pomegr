import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPipelineLogWriter } from "../monitor/pipeline-log-writer.mjs";

const owned = /^pipeline-\d{8}T\d{9}Z-[a-f0-9]{12}-\d{6}\.jsonl$/;

async function withDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pomegr-pipeline-log-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ownedFiles(directory) {
  return (await readdir(directory)).filter((name) => owned.test(name)).sort();
}

test("writes complete JSONL records, rotates at the configured bound, and reports bounded stats", async () => {
  await withDirectory(async (directory) => {
    const writer = createPipelineLogWriter({ directory, maxFileBytes: 50, maxFiles: 5, flushIntervalMs: 60_000 });
    assert.equal(writer.write({ sequence: 1, message: "first" }), true);
    assert.equal(writer.write({ sequence: 2, message: "second record" }), true);
    await writer.flush();

    const files = await ownedFiles(directory);
    assert.equal(files.length, 2);
    const rows = [];
    for (const file of files) {
      const content = await readFile(join(directory, file), "utf8");
      assert.ok(content.endsWith("\n"));
      rows.push(...content.trimEnd().split("\n").map((line) => JSON.parse(line)));
    }
    assert.deepEqual(rows, [{ sequence: 1, message: "first" }, { sequence: 2, message: "second record" }]);
    assert.equal(writer.stats().written, 2);
    assert.equal(writer.stats().rotations, 1);
    await writer.close();
  });
});

test("rotation enforces the file-count retention bound while preserving the active segment", async () => {
  await withDirectory(async (directory) => {
    const writer = createPipelineLogWriter({ directory, maxFileBytes: 45, maxFiles: 2, flushIntervalMs: 60_000 });
    for (let sequence = 1; sequence <= 5; sequence += 1) assert.equal(writer.write({ sequence, text: "record" }), true);
    await writer.flush();
    assert.equal((await ownedFiles(directory)).length, 2);
    assert.ok((await writer.stats()).rotations >= 3);
    await writer.close();
  });
});

test("batches queued records into one persistent-handle write and closes the handle", async () => {
  await withDirectory(async (directory) => {
    let writes = 0;
    let closes = 0;
    const realFs = await import("node:fs/promises");
    const wrappedFs = {
      ...realFs,
      open: async (...args) => {
        const handle = await realFs.open(...args);
        return {
          write: async (...writeArgs) => { writes += 1; return handle.write(...writeArgs); },
          close: async () => { closes += 1; return handle.close(); },
        };
      },
    };
    const writer = createPipelineLogWriter({ directory, fs: wrappedFs, flushIntervalMs: 60_000 });
    assert.equal(writer.write({ sequence: 1 }), true);
    assert.equal(writer.write({ sequence: 2 }), true);
    await writer.flush();
    assert.equal(writes, 1);
    await writer.close();
    assert.equal(closes, 1);
  });
});

test("rejects oversized records and explicit queue backpressure synchronously", async () => {
  await withDirectory(async (directory) => {
    const writer = createPipelineLogWriter({ directory, maxQueuedBytes: 100, flushIntervalMs: 60_000 });
    assert.equal(writer.write({ value: "x".repeat(70_000) }), false);
    assert.equal(writer.write({ value: "a".repeat(70) }), true);
    assert.equal(writer.write({ value: "b".repeat(70) }), false);
    const beforeFlush = writer.stats();
    assert.equal(beforeFlush.rejectedOversized, 1);
    assert.equal(beforeFlush.rejectedCapacity, 1);
    assert.equal(beforeFlush.dropped, 1);
    await writer.flush();
    assert.equal(writer.stats().written, 1);
    await writer.close();
  });
});

test("startup retention prunes only owned files and preserves unrelated files", async () => {
  await withDirectory(async (directory) => {
    const oldOwned = [
      "pipeline-20260101T000000000Z-aaaaaaaaaaaa-000001.jsonl",
      "pipeline-20260101T000001000Z-bbbbbbbbbbbb-000001.jsonl",
      "pipeline-20260101T000002000Z-cccccccccccc-000001.jsonl",
      "pipeline-20260101T000003000Z-dddddddddddd-000001.jsonl",
    ];
    for (const [index, name] of oldOwned.entries()) {
      await writeFile(join(directory, name), JSON.stringify({ old: index }) + "\n");
    }
    await writeFile(join(directory, "keep-me.jsonl"), "private\n");

    const writer = createPipelineLogWriter({ directory, maxFiles: 3, flushIntervalMs: 60_000 });
    await writer.flush();
    const files = await ownedFiles(directory);
    assert.equal(files.length, 3);
    assert.equal(await stat(join(directory, "keep-me.jsonl")).then(() => true), true);
    await writer.close();
  });
});

test("rejects a redirected directory and leaves symlinked owned files untouched", async (t) => {
  await withDirectory(async (directory) => {
    const targetDirectory = join(directory, "target");
    const redirectedDirectory = join(directory, "redirected");
    const outside = join(directory, "outside.jsonl");
    await import("node:fs/promises").then((fs) => fs.mkdir(targetDirectory));
    await writeFile(outside, "outside\n");
    try {
      await symlink(targetDirectory, redirectedDirectory, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { t.skip("symlinks unavailable"); return; }
      throw error;
    }
    const redirected = createPipelineLogWriter({ directory: redirectedDirectory, flushIntervalMs: 60_000 });
    assert.equal(redirected.write({ redirected: true }), true);
    await redirected.flush();
    assert.equal(redirected.stats().failureKind, "startup");
    assert.deepEqual(await readdir(targetDirectory), []);

    const ownedLink = join(targetDirectory, "pipeline-20260101T000000000Z-aaaaaaaaaaaa-000001.jsonl");
    try {
      await symlink(outside, ownedLink, "file");
    } catch (error) {
      await redirected.close();
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { t.skip("file symlinks unavailable"); return; }
      throw error;
    }
    const writer = createPipelineLogWriter({ directory: targetDirectory, maxFiles: 1, flushIntervalMs: 60_000 });
    await writer.flush();
    assert.equal((await stat(outside)).isFile(), true);
    assert.equal((await (await import("node:fs/promises")).lstat(ownedLink)).isSymbolicLink(), true);
    await writer.close();
  });
});

test("append failures stop acceptance, isolate the error, and retain prior complete records", async () => {
  await withDirectory(async (directory) => {
    let writeCalls = 0;
    let closeCalls = 0;
    const failingFs = {
      promises: {
        mkdir: (...args) => import("node:fs/promises").then((fs) => fs.mkdir(...args)),
        readdir: (...args) => import("node:fs/promises").then((fs) => fs.readdir(...args)),
        lstat: (...args) => import("node:fs/promises").then((fs) => fs.lstat(...args)),
        realpath: (...args) => import("node:fs/promises").then((fs) => fs.realpath(...args)),
        unlink: (...args) => import("node:fs/promises").then((fs) => fs.unlink(...args)),
        open: (...args) => import("node:fs/promises").then((fs) => fs.open(...args)).then((handle) => ({
          write: (...writeArgs) => {
            writeCalls += 1;
            if (writeCalls === 2) return Promise.reject(new Error("synthetic disk failure"));
            return handle.write(...writeArgs);
          },
          close: () => { closeCalls += 1; return handle.close(); },
        })),
      },
    };
    const writer = createPipelineLogWriter({ directory, fs: failingFs, maxFileBytes: 20, flushIntervalMs: 60_000 });
    assert.equal(writer.write({ sequence: 1 }), true);
    assert.equal(writer.write({ sequence: 2 }), true);
    await writer.flush();
    assert.equal(writer.stats().writeFailures, 1);
    assert.equal(writer.stats().stopped, 1);
    assert.equal(closeCalls, 2, "failed writer closes its handle before app shutdown");
    assert.equal(writer.write({ sequence: 3 }), false);
    const files = await ownedFiles(directory);
    assert.equal(files.length, 2);
    const persisted = (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8"))))
      .filter((content) => content.trim().length > 0)
      .map((content) => JSON.parse(content.trim()));
    assert.deepEqual(persisted, [{ sequence: 1 }]);
    await writer.close();
    assert.equal(closeCalls, 2);
  });
});

test("retention failures stop startup instead of growing beyond the disk budget", async () => {
  await withDirectory(async (directory) => {
    const realFs = await import("node:fs/promises");
    await writeFile(join(directory, "pipeline-20260101T000000000Z-aaaaaaaaaaaa-000001.jsonl"), "{}\n");
    const writer = createPipelineLogWriter({ directory, maxFiles: 1, fs: {
      ...realFs,
      unlink: async () => { throw Object.assign(new Error("private failure"), { code: "EACCES" }); },
    } });
    writer.write({ sequence: 1 });
    await writer.flush();
    assert.equal(writer.stats().failureKind, "startup");
    assert.equal(writer.stats().filesCreated, 0);
    assert.equal((await ownedFiles(directory)).length, 1);
    await writer.close();
  });
});

test("a restarted writer retains recent owned segments and appends from its first event", async () => {
  await withDirectory(async (directory) => {
    const first = createPipelineLogWriter({ directory, maxFileBytes: 100, maxFiles: 2, flushIntervalMs: 60_000 });
    assert.equal(first.write({ run: 1, event: "one" }), true);
    await first.flush();
    await first.close();

    const second = createPipelineLogWriter({ directory, maxFileBytes: 100, maxFiles: 2, flushIntervalMs: 60_000 });
    assert.equal(second.write({ run: 2, event: "first" }), true);
    await second.flush();
    const files = await ownedFiles(directory);
    assert.ok(files.length <= 2);
    const content = (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))).join("");
    assert.match(content, /"run":2/);
    assert.equal(second.stats().written, 1);
    await second.close();
  });
});
