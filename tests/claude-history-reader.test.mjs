import assert from "node:assert/strict";
import { mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeHistoryRecords } from "../monitor/providers/claude-history-reader.mjs";

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for cooperative history read");
}

test("complete Claude history reads yield between bounded chunks and preserve UTF-8 records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-history-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const records = [
    { type: "user", content: `${"a".repeat(65_520)}🙂` },
    { type: "assistant", content: "safe normalized fixture" },
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  let releaseFirstYield;
  const firstYield = new Promise((resolve) => { releaseFirstYield = resolve; });
  let yields = 0;
  let settled = false;
  let foregroundRuns = 0;
  const reading = readClaudeHistoryRecords(file, () => {
    yields += 1;
    return yields === 1 ? firstYield : Promise.resolve();
  }).then((value) => { settled = true; return value; });

  setImmediate(() => { foregroundRuns += 1; });
  await waitFor(() => yields === 1);
  assert.equal(settled, false, "a maintenance replay returns control before consuming the remaining source");
  await waitFor(() => foregroundRuns === 1);
  assert.equal(foregroundRuns, 1, "foreground work can run while the bounded replay is yielded");
  releaseFirstYield();
  const result = await reading;
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, records);
  assert.ok(yields >= 2);
});

test("incomplete JSONL tails are rejected without publishing partial records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-history-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "partial.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "user", content: "complete fixture" })}\n{"type":"assistant"`, "utf8");

  const result = await readClaudeHistoryRecords(file, async () => {});
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
});

test("replacement during a cooperative read invalidates the generation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-history-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "replaced.jsonl");
  const original = `${JSON.stringify({ type: "user", content: "original" })}\n${JSON.stringify({ type: "assistant", content: "x".repeat(65_520) })}\n`;
  const replacement = `${JSON.stringify({ type: "user", content: "replaced" })}\n${JSON.stringify({ type: "assistant", content: "y".repeat(65_520) })}\n`;
  await writeFile(file, original, "utf8");
  const originalStat = await stat(file);
  let releaseYield;
  const gate = new Promise((resolve) => { releaseYield = resolve; });
  let yields = 0;
  const reading = readClaudeHistoryRecords(file, () => {
    yields += 1;
    return yields === 1 ? gate : Promise.resolve();
  });
  await waitFor(() => yields === 1);
  const replacementFile = path.join(root, "replacement.jsonl");
  await writeFile(replacementFile, replacement, "utf8");
  await utimes(replacementFile, originalStat.atime, originalStat.mtime);
  await rm(file);
  await rename(replacementFile, file);
  releaseYield();

  const result = await reading;
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
});
