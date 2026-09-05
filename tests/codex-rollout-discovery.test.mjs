import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexRolloutDiscovery } from "../monitor/providers/codex-rollout-discovery.mjs";

const BASE = Date.parse("2026-09-04T12:00:00.000Z");

async function rollout(root, name, id, timestamp = BASE) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    type: "session_meta",
    timestamp: new Date(timestamp).toISOString(),
    payload: { id, session_id: id, timestamp: new Date(timestamp).toISOString(), cwd: "C:\\synthetic\\repo", source: "cli" },
  })}\n`, "utf8");
  await utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-rollout-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("advances beyond the first filename batch and admits an older resumed filename with a newer modification time", async (context) => {
  const root = await temporaryRoot(context);
  for (let index = 0; index < 4; index += 1) {
    await rollout(root, `rollout-z-${index}.jsonl`, `old-${index}`, BASE + index * 1_000);
  }
  await rollout(root, "rollout-a-resumed.jsonl", "resumed", BASE + 60_000);
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root, archived: false }],
    maximumFiles: 2,
    scanBatchFiles: 2,
    advanceIntervalMs: 0,
    rescanIntervalMs: 60_000,
  });

  await discovery.read();
  await discovery.read();
  const recovered = await discovery.read();

  assert.equal(recovered.some((row) => row.localId === "resumed"), true);
  assert.equal(discovery.stats().cachedHeaders <= 2, true);
  discovery.close();
});

test("coalesces a direct watcher hint and handles it before the background cursor", async (context) => {
  const root = await temporaryRoot(context);
  await rollout(root, "rollout-z-background.jsonl", "background", BASE);
  const direct = await rollout(root, "rollout-a-direct.jsonl", "direct", BASE + 1_000);
  let headerReads = 0;
  const headerOrder = [];
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root, archived: false }],
    maximumFiles: 4,
    scanBatchFiles: 1,
    advanceIntervalMs: 60_000,
    readHeader(file, options) {
      headerReads += 1;
      headerOrder.push(file);
      return {
        localId: path.basename(file).includes("direct") ? "direct" : "background",
        updatedAt: new Date(BASE).toISOString(),
        archived: options.archived,
        rolloutFile: file,
      };
    },
  });
  discovery.notice(direct);
  discovery.notice(direct);
  discovery.notice(direct);
  assert.equal(discovery.stats().queuedHints, 1);

  const rows = await discovery.read({ fresh: true });
  assert.equal(rows.some((row) => row.localId === "direct"), true);
  assert.equal(headerOrder[0], direct);
  assert.equal(discovery.stats().scannedEntries <= 1, true, "an exact hint skips the separate fresh recent-tree pass");
  assert.equal(discovery.stats().acceptedHints, 1);
  assert.equal(headerReads >= 1, true);
  discovery.close();
});

test("reuses an unchanged generation without rereading its header", async (context) => {
  const root = await temporaryRoot(context);
  await rollout(root, "rollout-stable.jsonl", "stable", BASE);
  let headerReads = 0;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 60_000,
    readHeader(file) {
      headerReads += 1;
      return { localId: "stable", updatedAt: new Date(BASE).toISOString(), rolloutFile: file };
    },
  });

  await discovery.read();
  await discovery.read();

  assert.equal(headerReads, 1);
  assert.equal(discovery.stats().headerReads, 1);
  discovery.close();
});

test("bounds cached headers and cursor work while yielding through a scan batch", async (context) => {
  const root = await temporaryRoot(context);
  for (let index = 0; index < 12; index += 1) await rollout(root, `rollout-${String(index).padStart(2, "0")}.jsonl`, `id-${index}`, BASE + index);
  let yields = 0;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 3,
    scanBatchFiles: 3,
    yieldEvery: 1,
    advanceIntervalMs: 0,
    yieldControl: async () => { yields += 1; },
  });

  await discovery.read();
  await discovery.read();
  const stats = discovery.stats();

  assert.equal(stats.cachedHeaders <= 3, true);
  assert.equal(stats.scannedFiles <= 6, true);
  assert.equal(stats.cursorDirectories <= 6, true);
  assert.equal(stats.yielded, yields);
  assert.doesNotMatch(JSON.stringify(stats), /rollout-|\\synthetic|[A-Z]:\\/i);
  discovery.close();
});

test("retains a last-known-good header when a changed source has a transient header failure", async (context) => {
  const root = await temporaryRoot(context);
  const file = await rollout(root, "rollout-transient.jsonl", "stable", BASE);
  let fail = false;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 0,
    readHeader(candidate) {
      if (fail) throw new Error("temporary sharing violation");
      return { localId: "stable", updatedAt: new Date(BASE).toISOString(), rolloutFile: candidate };
    },
  });
  assert.equal((await discovery.read()).length, 1);
  fail = true;
  await writeFile(file, "\n", { flag: "a" });
  await utimes(file, new Date(BASE + 2_000), new Date(BASE + 2_000));

  const retained = await discovery.read();
  assert.deepEqual(retained.map((row) => row.localId), ["stable"]);
  assert.equal(discovery.stats().transientFailures, 1);
  discovery.close();
});

test("evicts a confirmed deleted cached source without retaining a stale row", async (context) => {
  const root = await temporaryRoot(context);
  const file = await rollout(root, "rollout-deleted.jsonl", "deleted", BASE);
  const discovery = createCodexRolloutDiscovery({ roots: [{ root }], maximumFiles: 4, advanceIntervalMs: 60_000 });
  assert.equal((await discovery.read()).length, 1);
  await rm(file);

  assert.deepEqual(await discovery.read(), []);
  assert.equal(discovery.stats().cachedHeaders, 0);
  discovery.close();
});

test("rejects traversal hints and symlink-escape realpaths before header inspection", async (context) => {
  const root = await temporaryRoot(context);
  const candidate = await rollout(root, "rollout-inside.jsonl", "inside", BASE);
  const outside = path.join(root, "..", "outside", "rollout-escape.jsonl");
  let headerReads = 0;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 60_000,
    operations: {
      ...fs,
      async realpath(value) {
        if (path.resolve(value) === path.resolve(candidate)) return outside;
        return fs.realpath(value);
      },
    },
    readHeader() { headerReads += 1; return null; },
  });
  discovery.notice(path.join(root, "..", "outside", "rollout-traversal.jsonl"));
  discovery.notice(candidate);
  await discovery.read();

  assert.equal(headerReads, 0);
  assert.equal(discovery.stats().rejectedHints >= 2, true);
  discovery.close();
});
