import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeHistoryRecords } from "../monitor/providers/claude-history-reader.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createClaudeSessionWorkStartReader } from "../monitor/providers/claude-session-work-start.mjs";

async function writeRecords(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

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

test("session work-start reader scans cold sources beyond the display tail and keeps append history", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-work-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const startedAt = "2026-08-12T14:00:00.000Z";
  await writeRecords(file, [
    { type: "user", timestamp: startedAt, message: { content: "PRIVATE" } },
    ...Array.from({ length: 12 }, (_, index) => ({ type: "system", subtype: "local_command", timestamp: `2026-08-12T14:00:${String(index + 1).padStart(2, "0")}.000Z`, content: "PRIVATE".repeat(25_000) })),
  ]);
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  assert.equal(await reader.read(file), startedAt);
  await appendFile(file, `${JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-08-12T14:01:00.000Z", content: "PRIVATE" })}\n`);
  assert.equal(await reader.read(file), startedAt);
});

test("session work-start reader preserves a complete generation through an incomplete replacement", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-work-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  await writeRecords(file, [{ type: "user", timestamp: "2026-08-12T14:00:00.000Z", message: { content: "PRIVATE" } }]);
  assert.equal(await reader.read(file), "2026-08-12T14:00:00.000Z");
  await writeFile(file, '{"type":"user"', "utf8");
  assert.equal(await reader.read(file), "2026-08-12T14:00:00.000Z");
  await writeRecords(file, [{ type: "user", timestamp: "2026-08-12T15:00:00.000Z", message: { content: "PRIVATE" } }]);
  assert.equal(await reader.read(file), "2026-08-12T15:00:00.000Z");
});

test("session work-start reader waits for a linked command companion and rejects invalid timestamps", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-work-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  const command = { type: "user", uuid: "command-private", promptId: "prompt-private", timestamp: "2026-08-12T14:00:10.000Z", message: { content: "<command-name>/skill</command-name>" } };
  await writeRecords(file, [
    { type: "user", timestamp: "invalid", message: { content: "PRIVATE" } },
    command,
  ]);
  assert.equal(await reader.read(file), null);
  await appendFile(file, `${JSON.stringify({ type: "user", isMeta: true, turnCompanion: true, parentUuid: command.uuid, promptId: command.promptId, timestamp: "2026-08-12T14:00:11.000Z", message: { content: [{ type: "text", text: "PRIVATE" }] } })}\n`);
  assert.equal(await reader.read(file), command.timestamp);
});

test("session work-start reader rebuilds growing rewrites and after cache eviction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-work-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const otherFile = path.join(root, "other.jsonl");
  const reader = createClaudeSessionWorkStartReader({ maximumEntries: 1 });
  const input = (timestamp, content) => ({ type: "user", timestamp, message: { content } });
  await writeRecords(file, [input("2026-08-12T14:00:00.000Z", "first")]);
  assert.equal(await reader.read(file), "2026-08-12T14:00:00.000Z");
  await writeRecords(file, [input("2026-08-12T15:00:00.000Z", "replacement with more bytes")]);
  assert.equal(await reader.read(file), "2026-08-12T15:00:00.000Z");
  await writeRecords(otherFile, [input("2026-08-12T16:00:00.000Z", "other")]);
  await reader.read(otherFile);
  assert.equal(await reader.read(file), "2026-08-12T15:00:00.000Z");
});

test("Claude provider starts wall time only for a linked model command", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-wall-time-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-wall-time";
  const file = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const command = { type: "user", uuid: "command-private", promptId: "prompt-private", timestamp: "2026-08-12T14:00:10.000Z", message: { content: "<command-message>PRIVATE</command-message><command-name>/skill</command-name>" } };
  await writeRecords(file, [
    { type: "user", timestamp: "2026-08-12T14:00:01.000Z", message: { content: "<command-name>/clear</command-name>" } },
    command,
    { type: "user", isMeta: true, turnCompanion: true, parentUuid: command.uuid, promptId: command.promptId, timestamp: "2026-08-12T14:00:11.000Z", message: { content: [{ type: "text", text: "PRIVATE" }] } },
    { type: "assistant", timestamp: "2026-08-12T14:00:20.000Z", message: { model: "claude-test", content: [{ type: "text", text: "PRIVATE" }] } },
  ]);
  const provider = createClaudeProvider({ homeDir: root, projectsRoot, registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: file });
  const evidence = await provider.readSession(localId);
  assert.equal(evidence.session.startedAt, command.timestamp);
  assert.equal(evidence.agents.find((agent) => agent.id === "primary").durationMs, 10_000);
});

test("Claude setup-only sessions have no started wall time", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-not-started-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-not-started";
  const file = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(file, [{ type: "user", timestamp: "2026-08-12T14:00:00.000Z", message: { content: "<command-name>/clear</command-name>" } }]);
  const provider = createClaudeProvider({ homeDir: root, projectsRoot, registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: file });
  assert.equal((await provider.readSession(localId)).session.startedAt, null);
});
