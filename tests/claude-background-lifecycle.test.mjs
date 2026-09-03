import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeBackgroundLifecycleReader } from "../monitor/providers/claude-background-lifecycle.mjs";
import { applyClaudeAgentTerminals, createClaudeAgentLifecycleReader } from "../monitor/providers/claude-agent-lifecycle.mjs";
import { monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";
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
      toolUseResult: tool === "Workflow" ? { status: "async_launched", taskType: "local_workflow", taskId: id, runId: "wf_one", workflowName: PRIVATE }
        : tool === "Agent" ? { status: "async_launched", isAsync: true, agentId: id, prompt: PRIVATE, outputFile: PRIVATE }
          : { backgroundTaskId: id } },
  ];
}
function terminal(id = "task1", status = "completed", offset = 2000, callId = null) {
  const call = callId ? "<tool-use-id>" + callId + "</tool-use-id>" : "";
  return { type: "queue-operation", operation: "enqueue", timestamp: timestamp(offset),
    content: "<task-notification><task-id>" + id + "</task-id>" + call + "<status>" + status + "</status><summary>" + PRIVATE + "</summary></task-notification>" };
}
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
async function readTerminals(read, file) {
  const observation = await read(file);
  return observation instanceof Map ? observation : observation?.terminals || new Map();
}
async function fixture(t, records = []) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pomegr-background-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = path.join(homeDir, ".claude", "projects", "project");
  await mkdir(project, { recursive: true });
  const file = path.join(project, "local.jsonl");
  await writeFile(file, jsonl(records));
  return { homeDir, file, reader: createClaudeBackgroundLifecycleReader() };
}

function childTranscript(offset = 1100) {
  return [
    { type: "user", timestamp: timestamp(offset), message: { role: "user", content: PRIVATE } },
    { type: "assistant", timestamp: timestamp(offset + 800), message: {
      role: "assistant", stop_reason: null, content: [{ type: "text", text: PRIVATE }],
    } },
  ];
}

async function nestedFixture(t, { root = [], parent = [], child = childTranscript(), now = START + 5000 } = {}) {
  const f = await fixture(t, root);
  const agentRoot = path.join(path.dirname(f.file), "local", "subagents");
  await mkdir(agentRoot, { recursive: true });
  const parentFile = path.join(agentRoot, "agent-parent.jsonl");
  const childFile = path.join(agentRoot, "agent-child.jsonl");
  await writeFile(parentFile, jsonl(parent));
  await writeFile(childFile, jsonl(child));
  const provider = createClaudeProvider({ homeDir: f.homeDir, env: {}, explicitSession: f.file,
    now: () => now, usageRequest: async () => { throw new Error("not requested"); } });
  return { ...f, parentFile, childFile, provider };
}

for (const tool of ["Workflow", "Bash", "Agent"]) {
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
  assert.equal(sessionActivityStatus(false, { status: "idle" }, true), "idle");
});

test("provider catalog is working while native primary is idle, then returns open on workflow completion", async (t) => {
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
  assert.equal((await provider.listSessions())[0].activityStatus, "open");
  await appendFile(f.file, jsonl(launch("new", "Workflow", 3000)));
  assert.equal((await provider.listSessions())[0].activityStatus, "working");
  await rm(registryFile);
  await utimes(f.file, new Date(0), new Date(0));
  const history = await provider.listSessions();
  assert.equal(history[0].isLive, false);
  assert.equal(history[0].activityStatus, "idle");
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
  await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", timestamp: timestamp(2000), result: PRIVATE }));
  assert.equal(await f.reader.observe(f.file, owner()), false, "no primary transcript append required");
  await rm(manifest);
  await appendFile(f.file, jsonl([{ type: "user", timestamp: timestamp(3000), message: { content: PRIVATE } }]));
  assert.equal(await f.reader.observe(f.file, owner()), false, "later appends cannot reopen a completed run");
});

test("a resumed workflow stays open despite the previous attempt's completed manifest", async (t) => {
  const f = await fixture(t, launch());
  const root = path.join(path.dirname(f.file), "local", "workflows");
  await mkdir(root, { recursive: true });
  const manifest = path.join(root, "wf_one.json");
  await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", timestamp: timestamp(2000) }));
  assert.equal(await f.reader.observe(f.file, owner()), false);
  await appendFile(f.file, jsonl([...launch("resumed", "Workflow", 3000), terminal("task1", "completed", 4000)]));
  assert.equal(await f.reader.observe(f.file, owner()), true, "cached completion and delayed old notification cannot close a resume");
  assert.equal(await createClaudeBackgroundLifecycleReader().observe(f.file, owner()), true, "cold replay must reach the same result");
  await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", timestamp: timestamp(5000) }));
  assert.equal(await f.reader.observe(f.file, owner()), false, "the resumed attempt's completion closes work without a transcript append");
});

test("workflow manifest completion requires an ordered timestamp and completion memory is launch-scoped", async (t) => {
  const f = await fixture(t, launch());
  const root = path.join(path.dirname(f.file), "local", "workflows");
  await mkdir(root, { recursive: true });
  const manifest = path.join(root, "wf_one.json");
  for (const time of [undefined, null, "invalid", timestamp(500)]) {
    await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", timestamp: time }));
    assert.equal(await f.reader.observe(f.file, owner()), true);
  }
  await writeFile(manifest, JSON.stringify({ runId: "wf_one", status: "completed", timestamp: START + 2000 }));
  assert.equal(await f.reader.observe(f.file, owner()), false, "epoch-millisecond timestamps are supported");
  await appendFile(f.file, jsonl(launch("task1", "Workflow", 3000)));
  assert.equal(await f.reader.observe(f.file, owner()), true, "even reuse of the task ID cannot inherit earlier completion memory");
  await appendFile(f.file, jsonl([terminal("task1", "completed", 5000)]));
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("catalog and workflow detail reject cached completion when the same run resumes", async (t) => {
  const f = await fixture(t, launch());
  const registryRoot = path.join(f.homeDir, ".claude", "sessions");
  await mkdir(registryRoot);
  const registryFile = path.join(registryRoot, "123.json");
  await writeFile(registryFile, JSON.stringify({ sessionId: "local", status: "idle", pid: 123, procStart: "one", startedAt: START }));
  const sessionRoot = path.join(path.dirname(f.file), "local");
  const workerFile = path.join(sessionRoot, "subagents", "workflows", "wf_one", "agent-worker.jsonl");
  const manifestFile = path.join(sessionRoot, "workflows", "wf_one.json");
  await mkdir(path.dirname(workerFile), { recursive: true });
  await mkdir(path.dirname(manifestFile), { recursive: true });
  const workerRecord = (offset) => ({ type: "assistant", timestamp: timestamp(offset), message: {
    id: "worker-message", model: "claude-test", content: [], usage: { input_tokens: 10, output_tokens: 5 } } });
  await writeFile(workerFile, jsonl([workerRecord(1000)]));
  const manifest = { runId: "wf_one", status: "completed", startTime: START, timestamp: timestamp(2000),
    phases: [{ title: "Implement" }], workflowProgress: [{ type: "workflow_agent", agentId: "worker", state: "done", phaseIndex: 1 }] };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const provider = createClaudeProvider({ homeDir: f.homeDir, env: {}, now: () => START + 7000,
    registryProcessIdentities: () => new Map([[123, "one"]]), usageRequest: async () => { throw new Error("not requested"); } });
  assert.equal((await provider.listSessions())[0].activityStatus, "open");
  assert.equal((await provider.readSession("local")).workflows[0].status, "completed");
  await appendFile(f.file, jsonl(launch("resumed", "Workflow", 3000)));
  await writeFile(workerFile, jsonl([workerRecord(4000)]));
  const rows = await provider.listSessions();
  const resumed = await provider.readSession("local");
  assert.equal(rows[0].activityStatus, "working");
  assert.equal(resumed.workflows[0].status, "running");
  assert.equal(resumed.workflows[0].metadataStatus, "pending");
  assert.equal(resumed.workflows[0].startedAt, timestamp(3001));
  assert.deepEqual(resumed.workflows[0].phases, [], "earlier completion metadata is not applied to the resumed attempt");
  assert.notEqual(resumed.agents.find((agent) => agent.workflowId === "wf_one").status, "finished");
  assert.doesNotMatch(JSON.stringify(rows), /BACKGROUND_PRIVATE|launchedAt|ownerStartedAt|remoteSessionId|toolUseResult/);
  await rm(registryFile);
  for (const file of [f.file, workerFile]) await utimes(file, new Date(0), new Date(0));
  const historical = await provider.readSession("local");
  assert.equal(historical.historical, true);
  assert.equal(historical.workflows[0].status, "unknown", "history cannot inherit the earlier attempt's completed status");
  await writeFile(manifestFile, JSON.stringify({ ...manifest, timestamp: timestamp(5000) }));
  assert.equal((await provider.readSession("local")).workflows[0].status, "completed");
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("native Agent background work requires an exact successful structured async result", async (t) => {
  const records = launch("agent-one", "Agent");
  records[0].message.content[0].input.run_in_background = true;
  const f = await fixture(t, [records[0]]);
  assert.equal(await f.reader.observe(f.file, owner()), false, "requested background work is not a launch");
  const wrongResult = structuredClone(records[1]);
  wrongResult.message.content[0].tool_use_id = "wrong";
  await appendFile(f.file, jsonl([wrongResult]));
  assert.equal(await f.reader.observe(f.file, owner()), false, "result must match the Agent call");
  await appendFile(f.file, jsonl([records[1]]));
  assert.equal(await f.reader.observe(f.file, owner()), true);

  for (const result of [null, {}, { agentId: "agent-one" },
    { status: "completed", isAsync: true, agentId: "agent-one" },
    { status: "async_launched", agentId: "agent-one" },
    { status: "async_launched", isAsync: false, agentId: "agent-one" },
    { status: "async_launched", isAsync: "true", agentId: "agent-one" },
    { status: "async_launched", isAsync: true, taskId: "agent-one" },
    { status: "async_launched", isAsync: true, agentId: "../private" },
    { status: "async_launched", isAsync: true, agentId: "a".repeat(129) },
  ]) {
    const invalid = await fixture(t, [records[0], { ...records[1], toolUseResult: result }]);
    assert.equal(await invalid.reader.observe(invalid.file, owner()), false);
  }
  const failed = structuredClone(records);
  failed[1].message.content[0].is_error = true;
  const invalid = await fixture(t, failed);
  assert.equal(await invalid.reader.observe(invalid.file, owner()), false);
  const wrongTool = structuredClone(records);
  wrongTool[0].message.content[0].name = "Bash";
  const unrelated = await fixture(t, wrongTool);
  assert.equal(await unrelated.reader.observe(unrelated.file, owner()), false, "Agent schema cannot establish shell work");
});

test("native background Agent completion must be trusted and match each open agent", async (t) => {
  const f = await fixture(t, [...launch("agent-one", "Agent"), ...launch("agent-two", "Agent")]);
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const stop = terminal("agent-one");
  await appendFile(f.file, jsonl([
    { type: "user", timestamp: stop.timestamp, message: { content: stop.content } },
    terminal("agent-one", "unknown"), terminal("another-agent"),
  ]));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await appendFile(f.file, jsonl([terminal("agent-one", "stopped")]));
  assert.equal(await f.reader.observe(f.file, owner()), true, "one stopped agent cannot close its sibling");
  const delivered = terminal("agent-two", "failed");
  await appendFile(f.file, jsonl([{ type: "user", timestamp: delivered.timestamp,
    origin: { kind: "task-notification" }, promptSource: "system", message: { content: delivered.content } }]));
  assert.equal(await f.reader.observe(f.file, owner()), false);
});

test("native background Agent evidence survives partial replacement but not owner replacement", async (t) => {
  const records = launch("agent-one", "Agent");
  const f = await fixture(t, records);
  assert.equal(await f.reader.observe(f.file, { sessionId: "local" }), null);
  assert.equal(await f.reader.observe(f.file, owner()), true);
  const complete = jsonl([...records, terminal("agent-one")]);
  await writeFile(f.file, complete.slice(0, -3));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await appendFile(f.file, complete.slice(-3));
  assert.equal(await f.reader.observe(f.file, owner()), false);
  await writeFile(f.file, jsonl(records));
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await writeFile(f.file, "malformed\n");
  assert.equal(await f.reader.observe(f.file, owner()), true);
  await writeFile(f.file, jsonl(records));
  const replacement = owner({ ownerStartedAt: START + 5000, resourceOwner: { pid: 123, processStartIdentity: "two" } });
  assert.equal(await f.reader.observe(f.file, replacement), false, "a new process cannot inherit the old agent");
});

test("native idle catalog stays working for a background Agent and its nested child until the exact notification", async (t) => {
  const f = await fixture(t, launch("agent-parent", "Agent"));
  const registryRoot = path.join(f.homeDir, ".claude", "sessions");
  await mkdir(registryRoot);
  const registryFile = path.join(registryRoot, "123.json");
  await writeFile(registryFile, JSON.stringify({ sessionId: "local", entrypoint: "sdk-cli", bridgeSessionId: "session_PRIVATEBRIDGE",
    pid: 123, procStart: "one", startedAt: START }));
  await writeFile(path.join(f.homeDir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: PRIVATE } }));
  const provider = createClaudeProvider({ homeDir: f.homeDir, env: {}, registryProcessIdentities: () => new Map([[123, "one"]]),
    fetch: async () => Response.json({ response_shape: { id: "session_PRIVATEBRIDGE", worker_status: "idle" } }) });
  assert.equal((await provider.listSessions())[0].activityStatus, "working", "confirmed launch works before the child file exists");
  const agentRoot = path.join(path.dirname(f.file), "local", "subagents");
  await mkdir(agentRoot, { recursive: true });
  const parentFile = path.join(agentRoot, "agent-agent-parent.jsonl");
  const childFile = path.join(agentRoot, "agent-agent-child.jsonl");
  await writeFile(parentFile, jsonl(launch("agent-child", "Agent", 1500)));
  await writeFile(childFile, jsonl([{ type: "assistant", timestamp: timestamp(1600),
    message: { content: [{ type: "text", text: PRIVATE }] } }]));
  for (const file of [f.file, parentFile, childFile]) await utimes(file, new Date(0), new Date(0));
  const rows = await provider.listSessions();
  assert.equal(rows[0].activityStatus, "working", "silent nested work cannot expire by file age");
  assert.doesNotMatch(JSON.stringify(rows), /BACKGROUND_PRIVATE|PRIVATEBRIDGE|ownerStartedAt|remoteSessionId|agent-parent|agent-child|outputFile|toolUseResult/);
  const evidence = await provider.readSession("local");
  assert.equal(evidence.agents.find((agent) => agent.id === "primary").status, "idle");
  await appendFile(f.file, jsonl([terminal("agent-child")]));
  assert.equal((await provider.listSessions())[0].activityStatus, "working", "grandchild completion cannot close the parent launch");
  await appendFile(f.file, jsonl([terminal("agent-parent")]));
  assert.equal((await provider.listSessions())[0].activityStatus, "open");
  await appendFile(f.file, jsonl(launch("agent-new", "Agent", 3000)));
  assert.equal((await provider.listSessions())[0].activityStatus, "working");
  await rm(registryFile);
  for (const file of [f.file, parentFile, childFile]) await utimes(file, new Date(0), new Date(0));
  const history = await provider.listSessions();
  assert.equal(history[0].isLive, false);
  assert.equal(history[0].activityStatus, "idle", "history cannot inherit current background work");
});


test("native child completion without stop_reason sets finished, freezes timing, and survives parent tail growth", async (t) => {
  const records = launch("child", "Agent");
  records[0].message.content[0].input.description = "Consult on queue";
  const f = await fixture(t, [...records, terminal("child")]);
  const childDir = path.join(path.dirname(f.file), "local", "subagents");
  await mkdir(childDir, { recursive: true });
  const childFile = path.join(childDir, "agent-child.jsonl");
  await writeFile(childFile, jsonl([
    { type: "user", timestamp: timestamp(1100), message: { content: PRIVATE } },
    { type: "assistant", timestamp: timestamp(1900), message: { role: "assistant", stop_reason: null,
      content: [{ type: "text", text: PRIVATE }] } },
  ]));
  const provider = createClaudeProvider({ homeDir: f.homeDir, env: {}, explicitSession: f.file });
  const readChild = async () => {
    const evidence = await provider.readSession("local");
    const state = monitorStateFromProviderEvidence("claude", evidence);
    assert.doesNotMatch(JSON.stringify(state), /BACKGROUND_PRIVATE|task-notification|toolUseResult|callId|completeOffset/);
    return evidence.agents.find((agent) => agent.id === "agent-child");
  };
  let child = await readChild();
  assert.equal(child.status, "finished");
  assert.equal(child.lastSeen, timestamp(2000));
  assert.equal(child.updatedAt, timestamp(2000));
  assert.equal(child.durationMs, 900);
  const filler = { type: "system", timestamp: timestamp(3000), content: PRIVATE.repeat(250) };
  await appendFile(f.file, jsonl(Array.from({ length: 300 }, () => filler)));
  child = await readChild();
  assert.equal(child.status, "finished", "completion must survive moving outside the 2 MiB tail");
  assert.equal(child.durationMs, 900);
  const cold = createClaudeProvider({ homeDir: f.homeDir, env: {}, explicitSession: f.file });
  assert.equal((await cold.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "finished");
  await appendFile(childFile, jsonl([{ type: "user", timestamp: timestamp(4000), message: { content: PRIVATE } }]));
  assert.equal((await readChild()).status, "active", "a resumed child must clear the prior completion");
});

test("agent detail accepts trusted delivery and rejects unmatched, foreground, failed-launch, and user-authored completion", async (t) => {
  const f = await fixture(t, launch("child", "Agent"));
  const read = createClaudeAgentLifecycleReader();
  assert.equal((await readTerminals(read, f.file)).size, 0);
  const done = terminal("child");
  await appendFile(f.file, jsonl([
    { type: "user", timestamp: done.timestamp, message: { content: done.content } },
    terminal("other"), terminal("child", "unknown"), terminal("child", "completed", 500),
    { ...done, content: done.content.replace("</task-id>", "</task-id><tool-use-id>other-call</tool-use-id>") },
  ]));
  assert.equal((await readTerminals(read, f.file)).size, 0);
  await appendFile(f.file, jsonl([{ type: "user", timestamp: done.timestamp, origin: { kind: "task-notification" },
    promptSource: "system", message: { content: done.content } }]));
  assert.deepEqual((await readTerminals(read, f.file)).get("child"), { status: "finished", timestamp: timestamp(2000) });
  const foreground = launch("foreground", "Agent"); foreground[1].toolUseResult.status = "completed";
  const failed = launch("failed", "Agent"); failed[1].message.content[0].is_error = true;
  await appendFile(f.file, jsonl([...foreground, terminal("foreground"), ...failed, terminal("failed"),
    ...launch("shell", "Bash"), terminal("shell")]));
  assert.deepEqual([...(await readTerminals(read, f.file)).keys()], ["child"]);
});

test("agent detail preserves earliest completion, handles stop and relaunch, and keeps last good replacement", async (t) => {
  const f = await fixture(t, [...launch("child", "Agent"), terminal("child")]);
  const read = createClaudeAgentLifecycleReader();
  assert.equal((await readTerminals(read, f.file)).get("child").timestamp, timestamp(2000));
  await appendFile(f.file, jsonl([terminal("child", "completed", 2500)]));
  assert.equal((await readTerminals(read, f.file)).get("child").timestamp, timestamp(2000), "delivery must not renew completion time");
  const resumed = launch("child", "Agent", 3000);
  resumed[0].message.content[0].id = "resume-child";
  resumed[1].message.content[0].tool_use_id = "resume-child";
  await appendFile(f.file, jsonl(resumed));
  assert.equal((await readTerminals(read, f.file)).size, 0, "successful new launch clears terminal state");
  const old = terminal("child", "completed", 3500);
  old.content = old.content.replace("</task-id>", "</task-id><tool-use-id>call-child</tool-use-id>");
  await appendFile(f.file, jsonl([old, terminal("child", "completed", 3600)]));
  assert.equal((await readTerminals(read, f.file)).size, 0, "old or ambiguous launch completion cannot finish a resumed launch");
  const stopped = terminal("child", "stopped", 4000);
  stopped.content = stopped.content.replace("</task-id>", "</task-id><tool-use-id>resume-child</tool-use-id>");
  await appendFile(f.file, jsonl([stopped]));
  assert.deepEqual((await readTerminals(read, f.file)).get("child"), { status: "stopped", timestamp: timestamp(4000) });
  const replacement = jsonl(launch("child", "Agent", 5000));
  await writeFile(f.file, replacement.slice(0, -3));
  assert.equal((await readTerminals(read, f.file)).get("child").status, "stopped");
  await appendFile(f.file, replacement.slice(-3));
  assert.equal((await readTerminals(read, f.file)).size, 0);
  await appendFile(f.file, jsonl([terminal("child", "completed", 6000)]));
  assert.equal((await readTerminals(read, f.file)).get("child").status, "finished");
  await writeFile(f.file, jsonl(launch("child", "Agent", 7000)) + "broken-json\n");
  assert.equal((await readTerminals(read, f.file)).get("child").status, "finished", "invalid replacement retains completion");
  await writeFile(f.file, jsonl([...launch("child", "Agent", 8000),
    ...Array.from({ length: 20 }, () => ({ type: "system", timestamp: timestamp(9000), content: PRIVATE }))]));
  assert.equal((await readTerminals(read, f.file)).size, 0, "a larger complete rewrite also replaces prior evidence");
});


test("same-size prefix replacement invalidates completion even when the suffix is unchanged", async (t) => {
  const records = [...launch("child", "Agent"), terminal("child"),
    { type: "system", timestamp: timestamp(3000), content: PRIVATE.repeat(50) }];
  const f = await fixture(t, records);
  const read = createClaudeAgentLifecycleReader();
  assert.equal((await readTerminals(read, f.file)).get("child").status, "finished");
  const original = jsonl(records);
  const replacement = original.replace("<status>completed</status>", "<status>cancelled</status>");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  assert.equal(replacement.slice(-256), original.slice(-256));
  await writeFile(f.file, replacement);
  await utimes(f.file, new Date(START), new Date(START));
  assert.equal((await readTerminals(read, f.file)).get("child").status, "stopped");
});

test("cross-file Agent completion matches the parent launch, freezes timing, and survives tail growth", async (t) => {
  const rootLaunch = launch("parent", "Agent", 1000);
  const parentLaunch = launch("child", "Agent", 1500);
  const filler = { type: "system", timestamp: timestamp(1800), content: PRIVATE.repeat(300) };
  const completion = terminal("child", "completed", 2500, "call-child");
  const f = await nestedFixture(t, {
    root: [...rootLaunch, ...Array.from({ length: 300 }, () => filler), completion],
    parent: [...parentLaunch, ...Array.from({ length: 300 }, () => filler)],
  });
  const evidence = await f.provider.readSession("local");
  const primary = evidence.agents.find((agent) => agent.id === "primary");
  const parent = evidence.agents.find((agent) => agent.id === "agent-parent");
  const child = evidence.agents.find((agent) => agent.id === "agent-child");
  assert.equal(primary.status, "active", "primary lifecycle remains independent");
  assert.equal(parent.status, "active", "the intermediate parent remains open");
  assert.equal(child.status, "finished");
  assert.equal(child.lastSeen, timestamp(2500));
  assert.equal(child.updatedAt, timestamp(2500));
  assert.equal(child.durationMs, 1400);
  const state = monitorStateFromProviderEvidence("claude", evidence);
  assert.doesNotMatch(JSON.stringify(state), /BACKGROUND_PRIVATE_MUST_NOT_LEAK|<task-notification>|call-child|toolUseResult|conversationAt|crossFile|notifications|launches/);

  await appendFile(f.file, jsonl([terminal("child", "completed", 3500, "call-child")]));
  const frozen = (await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child");
  assert.equal(frozen.status, "finished");
  assert.equal(frozen.lastSeen, timestamp(2500), "duplicate receipts cannot renew completion");
  assert.equal(frozen.durationMs, 1400, "completion duration remains frozen");

  const parentSource = jsonl([...parentLaunch, ...Array.from({ length: 300 }, () => filler)]);
  await writeFile(f.parentFile, parentSource.slice(0, -3));
  const retained = (await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child");
  assert.equal(retained.status, "finished", "an incomplete parent replacement retains the last valid launch");
  await appendFile(f.parentFile, parentSource.slice(-3));
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "finished");

  await appendFile(f.childFile, jsonl([{ type: "user", timestamp: timestamp(4000), message: { role: "user", content: PRIVATE } }]));
  await appendFile(f.file, jsonl([terminal("child", "completed", 4500, "call-child")]));
  await appendFile(f.childFile, jsonl(Array.from({ length: 300 }, () => filler)));
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "active",
    "a duplicate receipt cannot finish a resumed child after child tail growth");
  const cold = createClaudeProvider({ homeDir: f.homeDir, env: {}, explicitSession: f.file,
    now: () => START + 5000, usageRequest: async () => { throw new Error("not requested"); } });
  assert.equal((await cold.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "active",
    "cold replay cannot reuse completion after a resumed child conversation");
});

test("cross-file Agent completion requires an exact post-launch call ID and trusted source", async (t) => {
  const baseParent = launch("child", "Agent", 1500);
  const scenarios = [
    ["wrong call ID", [terminal("child", "completed", 2500, "wrong-call")], "active"],
    ["missing call ID", [terminal("child", "completed", 2500)], "active"],
    ["prelaunch receipt", [terminal("child", "completed", 1200, "call-child")], "active"],
    ["mismatched agent", [terminal("other", "completed", 2500, "call-child")], "active"],
    ["user-authored lookalike", [{ type: "user", timestamp: timestamp(2500), message: { content: terminal("child", "completed", 2500, "call-child").content } }], "active"],
    ["equal timestamp child conversation", [terminal("child", "completed", 1900, "call-child")], "active"],
    ["same-file prelaunch receipt", [], "active", [terminal("child", "completed", 2500, "call-child"), ...baseParent]],
    ["failed launch", [terminal("child", "completed", 2500, "call-child")], "active", (() => {
      const records = structuredClone(baseParent); records[1].message.content[0].is_error = true; return records;
    })()],
    ["foreground launch", [terminal("child", "completed", 2500, "call-child")], "active", (() => {
      const records = structuredClone(baseParent); records[1].toolUseResult.isAsync = false; return records;
    })()],
    ["prelaunch then valid receipt", [terminal("child", "completed", 1200, "call-child"), terminal("child", "completed", 2500, "call-child")], "finished"],
  ];
  for (const [label, root, expected, parent = baseParent] of scenarios) {
    const f = await nestedFixture(t, { root, parent });
    const child = (await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child");
    assert.equal(child?.status, expected, label);
    if (expected === "finished") assert.equal(child.lastSeen, timestamp(2500), label + " timestamp");
  }
});

test("cross-file lifecycle bounds the aggregate evidence for one session", async (t) => {
  const f = await nestedFixture(t, { root: [], parent: [] });
  const recordsByFile = new Map([[f.file, []]]);
  const agentRoot = path.dirname(f.parentFile);
  for (let index = 0; index < 100; index += 1) {
    const file = path.join(agentRoot, "agent-overflow-" + index + ".jsonl");
    const records = Array.from({ length: 256 }, (_, launchIndex) => launch(`overflow-${index}-${launchIndex}`, "Agent", 1500));
    recordsByFile.set(file, records.flat());
    await writeFile(file, jsonl(records.flat()));
  }
  const reader = createClaudeAgentLifecycleReader();
  await assert.rejects(
    () => applyClaudeAgentTerminals([], recordsByFile, new Map(), reader),
    /session bound/,
  );
});

test("cross-file Agent completion ignores a receipt from another session", async (t) => {
  const f = await nestedFixture(t, { root: [], parent: launch("child", "Agent", 1500) });
  const foreign = path.join(path.dirname(f.file), "other-session.jsonl");
  await writeFile(foreign, jsonl([terminal("child", "completed", 2500, "call-child")]));
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "active");
});

test("cross-file lifecycle rejects ambiguous parents and preserves the current run across delayed receipts", async (t) => {
  const parentLaunch = launch("child", "Agent", 1500);
  const f = await nestedFixture(t, {
    root: [terminal("child", "completed", 2500, "call-child")],
    parent: [...parentLaunch, terminal("child", "completed", 2200, "call-child")],
  });
  const secondParent = path.join(path.dirname(f.parentFile), "agent-parent-two.jsonl");
  await writeFile(secondParent, jsonl(launch("child", "Agent", 1600)));
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "active",
    "same agent ID launched by a second parent is ambiguous even without its own receipt");

  await rm(secondParent);
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "finished");
  const relaunch = launch("child", "Agent", 3000);
  relaunch[0].message.content[0].id = "call-child-new";
  relaunch[1].message.content[0].tool_use_id = "call-child-new";
  await appendFile(f.parentFile, jsonl(relaunch));
  await appendFile(f.childFile, jsonl([{ type: "user", timestamp: timestamp(3100), message: { role: "user", content: PRIVATE } }]));
  await appendFile(f.file, jsonl([terminal("child", "completed", 3500, "call-child")]));
  assert.equal((await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child").status, "active",
    "an old receipt cannot finish a relaunch");
  await appendFile(f.file, jsonl([terminal("child", "completed", 3600, "call-child-new")]));
  const completed = (await f.provider.readSession("local")).agents.find((agent) => agent.id === "agent-child");
  assert.equal(completed.status, "finished");
  assert.equal(completed.lastSeen, timestamp(3600));
});

test("cross-file Agent terminals are independent of source map and notification order", async (t) => {
  const root = [...launch("parent", "Agent", 1000), terminal("child", "completed", 2500, "call-child")];
  const parent = launch("child", "Agent", 1500);
  const f = await nestedFixture(t, { root, parent });
  const agents = [{ id: "agent-child", status: "active", startedAt: timestamp(1100), lastSeen: timestamp(1900), updatedAt: timestamp(1900), durationMs: 800 }];
  const recordsByFile = new Map([
    [f.childFile, childTranscript()],
    [f.parentFile, parent],
    [f.file, root],
  ]);
  await applyClaudeAgentTerminals(agents, recordsByFile, new Map([["agent-child", f.childFile]]), createClaudeAgentLifecycleReader());
  assert.deepEqual(agents[0], {
    id: "agent-child", status: "finished", startedAt: timestamp(1100), lastSeen: timestamp(2500),
    updatedAt: timestamp(2500), durationMs: 1400,
  });
});
