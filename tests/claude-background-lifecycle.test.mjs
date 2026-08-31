import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeBackgroundLifecycleReader } from "../monitor/providers/claude-background-lifecycle.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { sessionActivityStatus } from "../monitor/providers/claude-session-status.mjs";

const START = Date.parse("2026-08-31T00:00:00Z");
const PRIVATE = "BACKGROUND_PRIVATE_MUST_NOT_LEAK";
const timestamp = (offset = 1000) => new Date(START + offset).toISOString();
const owner = (extra = {}) => ({ sessionId: "local", ownerStartedAt: START,
  resourceOwner: { pid: 123, processStartIdentity: "one" }, ...extra });
function launch(id = "task1", tool = "Workflow", offset = 1000) {
  return [
    { type: "assistant", timestamp: timestamp(offset), message: { content: [{ type: "tool_use", name: tool, id: "call-" + id, input: { description: PRIVATE, command: PRIVATE } }] } },
    { type: "user", timestamp: timestamp(offset + 1), message: { content: [{ type: "tool_result", tool_use_id: "call-" + id, content: PRIVATE }] },
      toolUseResult: tool === "Workflow" ? { status: "async_launched", taskType: "local_workflow", taskId: id, runId: "wf_one", workflowName: PRIVATE } : { backgroundTaskId: id } },
  ];
}
function terminal(id = "task1", status = "completed", offset = 2000) {
  return { type: "queue-operation", operation: "enqueue", timestamp: timestamp(offset),
    content: "<task-notification><task-id>" + id + "</task-id><status>" + status + "</status><summary>" + PRIVATE + "</summary></task-notification>" };
}
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
async function fixture(t, records = []) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pomegr-background-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = path.join(homeDir, ".claude", "projects", "project");
  await mkdir(project, { recursive: true });
  const file = path.join(project, "local.jsonl");
  await writeFile(file, jsonl(records));
  return { homeDir, file, reader: createClaudeBackgroundLifecycleReader() };
}

for (const tool of ["Workflow", "Bash"]) {
  test("keeps successfully launched " + tool + " running through silence until an exact terminal record", async (t) => {
    const f = await fixture(t, launch("task1", tool));
    assert.equal(await f.reader.observe(f.file, owner()), true);
    await utimes(f.file, new Date(0), new Date(0));
    assert.equal(await f.reader.observe(f.file, owner()), true, "mtime cannot terminate lifecycle");
    await appendFile(f.file, jsonl([terminal("another")]));
    assert.equal(await f.reader.observe(f.file, owner()), true);
    await appendFile(f.file, jsonl([terminal("task1")]));
    assert.equal(await f.reader.observe(f.file, owner()), false);
  });
}

test("supports failure, stop, and trusted delivered task notifications", async (t) => {
  for (const status of ["failed", "stopped", "killed"]) {
    const f = await fixture(t, [...launch(), terminal("task1", status)]);
    assert.equal(await f.reader.observe(f.file, owner()), false);
  }
  const message = terminal();
  const f = await fixture(t, [...launch(), { type: "user", timestamp: message.timestamp,
    origin: { kind: "task-notification" }, promptSource: "system", message: { content: message.content } }]);
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("rejects launch intent, user lookalikes, errors, mismatched results, and unknown terminal statuses", async (t) => {
  const records = launch();
  const f = await fixture(t, [records[0]]);
  assert.equal(await f.reader.observe(f.file, owner()), false, "tool call is not launch confirmation");
  await appendFile(f.file, jsonl([{ ...records[1], message: { content: [{ type: "tool_result", tool_use_id: "wrong", content: PRIVATE }] } }]));
  assert.equal(await f.reader.observe(f.file, owner()), false);
  await appendFile(f.file, jsonl([records[1]]));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const stop = terminal();
  await appendFile(f.file, jsonl([{ type: "user", timestamp: stop.timestamp, message: { content: stop.content } }, terminal("task1", "mystery")]));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const failed = launch("failed"); failed[1].message.content[0].is_error = true;
  const failFixture = await fixture(t, failed);
  assert.equal(await failFixture.reader.observe(failFixture.file, owner()), false);
});

test("requires current owner start evidence and discards launches from a previous process", async (t) => {
  const f = await fixture(t, launch());
  assert.equal(await f.reader.observe(f.file, { sessionId: "local" }), null);
  assert.equal(await f.reader.observe(f.file, owner({ ownerStartedAt: undefined })), null);
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const replacement = owner({ ownerStartedAt: START + 5000, resourceOwner: { pid: 123, processStartIdentity: "two" } });
  assert.equal(await f.reader.observe(f.file, replacement), false);
  f.reader.prune(new Map());
  assert.equal(await f.reader.observe(f.file, owner()), true, "complete replay after cache removal");
});

test("retains open work beyond the acquisition tail and handles later completion incrementally", async (t) => {
  const f = await fixture(t, launch());
  const unrelated = { type: "assistant", timestamp: timestamp(1500), message: { content: [{ type: "text", text: PRIVATE.repeat(300) }] } };
  await appendFile(f.file, jsonl(Array.from({ length: 400 }, () => unrelated)));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await appendFile(f.file, jsonl([terminal()]));
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("retains last valid observation during incomplete replacement and malformed input", async (t) => {
  const f = await fixture(t, launch());
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const complete = jsonl([...launch(), terminal()]);
  await writeFile(f.file, complete.slice(0, -3));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await appendFile(f.file, complete.slice(-3));
  assert.equal(await f.reader.observe(f.file, owner()), false);
  await writeFile(f.file, jsonl(launch()) + "broken-json\n");
  assert.equal(await f.reader.observe(f.file, owner()), false, "invalid replacement cannot erase last known-good state");
});

test("composes session work independently of primary idle and preserves needs-input priority", () => {
  assert.equal(sessionActivityStatus(true, { status: "idle" }, true), "working");
  assert.equal(sessionActivityStatus(true, { status: "idle" }, false), "idle");
  assert.equal(sessionActivityStatus(true, { status: "waiting", needsInput: true }, true), "needs_input");
  assert.equal(sessionActivityStatus(false, { status: "idle" }, true), "unknown");
});

test("provider catalog is working while native primary is idle, then returns idle on workflow completion", async (t) => {
  const f = await fixture(t, launch());
  const registryRoot = path.join(f.homeDir, ".claude", "sessions"); await mkdir(registryRoot);
  const registryFile = path.join(registryRoot, "123.json");
  await writeFile(registryFile, JSON.stringify({ sessionId: "local", entrypoint: "sdk-cli", bridgeSessionId: "session_PRIVATEBRIDGE",
    pid: 123, procStart: "one", startedAt: START }));
  await writeFile(path.join(f.homeDir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: PRIVATE } }));
  const provider = createClaudeProvider({ homeDir: f.homeDir, env: {}, registryProcessIdentities: () => new Map([[123, "one"]]),
    fetch: async () => Response.json({ response_shape: { id: "session_PRIVATEBRIDGE", worker_status: "idle" } }) });
  const rows = await provider.listSessions();
  assert.equal(rows[0].activityStatus, "working");
  assert.doesNotMatch(JSON.stringify(rows), /BACKGROUND_PRIVATE|PRIVATEBRIDGE|ownerStartedAt|remoteSessionId/);
  const evidence = await provider.readSession("local");
  assert.equal(evidence.agents.find((agent) => agent.id === "primary").status, "idle");
  await appendFile(f.file, jsonl([terminal()]));
  assert.equal((await provider.listSessions())[0].activityStatus, "idle");
  await appendFile(f.file, jsonl(launch("new", "Workflow", 3000)));
  assert.equal((await provider.listSessions())[0].activityStatus, "working");
  await rm(registryFile);
  await utimes(f.file, new Date(0), new Date(0));
  const history = await provider.listSessions();
  assert.equal(history[0].isLive, false);
  assert.equal(history[0].activityStatus, "unknown");
});

test("a temporarily missing source does not wedge subsequent acquisition", async (t) => {
  const f = await fixture(t, launch());
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await rm(f.file);
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await writeFile(f.file, jsonl([...launch(), terminal()]));
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("an exact completed workflow manifest closes work before its delayed notification", async (t) => {
  const f = await fixture(t, launch());
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const root = path.join(path.dirname(f.file), "local", "workflows");
  await mkdir(root, { recursive: true });
  const manifest = path.join(root, "wf_one.json");
  await writeFile(manifest, JSON.stringify({ runId: "wf_other", status: "completed" }));
  assert.equal(await f.reader.observe(f.file, owner()), true, "a mismatched run cannot close work");
  await writeFile(manifest, '{"runId":"wf_one",');
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", result: PRIVATE }));
  assert.equal(await f.reader.observe(f.file, owner()), false, "no primary transcript append required");
  await rm(manifest);
  await appendFile(f.file, jsonl([{ type: "user", timestamp: timestamp(3000), message: { content: PRIVATE } }]));
  assert.equal(await f.reader.observe(f.file, owner()), false, "later appends cannot reopen a completed run");
});
