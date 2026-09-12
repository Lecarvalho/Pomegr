import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexLiveState } from "../monitor/providers/codex-live-state.mjs";

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Codex history yield");
}

test("strict complete Codex history parsing yields during a large rollout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-history-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const first = { type: "fixture", index: 0, payload: "" };
  // Put the four UTF-8 bytes for this character across the first 64 KiB boundary.
  first.payload = `${"x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(first)))}🙂`;
  const records = [first, ...Array.from({ length: 1_024 }, (_, index) => ({ type: "fixture", index: index + 1, payload: "x".repeat(100) }))];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  let releaseFirstYield;
  const firstYield = new Promise((resolve) => { releaseFirstYield = resolve; });
  let yields = 0;
  let settled = false;
  const liveState = createCodexLiveState({
    scanLimit: 4,
    maximumLiveTailBytes: 64 * 1024,
    maximumLiveTaskHistoryBytes: 128 * 1024,
    yieldControl() { yields += 1; return yields === 1 ? firstYield : Promise.resolve(); },
  });
  const reading = liveState.readRolloutRecords(file, true, 64 * 1024, true)
    .then((value) => { settled = true; return value; });

  await waitFor(() => yields === 1);
  assert.equal(settled, false);
  releaseFirstYield();
  const result = await reading;
  assert.deepEqual(result.records, records);
  assert.ok(result.generation);
  assert.ok(yields >= 2);
});
