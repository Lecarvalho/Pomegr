import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionActivityFallback, reconcileSessionActivityFallback } from "../monitor/session-current-activity.mjs";

const entry = { isLive: true, activityStatus: "working" };
const startedAt = "2026-09-02T12:00:00.000Z";
const finishedAt = "2026-09-02T12:00:05.000Z";
const task = { id: "task", kind: "shell", workKind: "test", status: "running", startedAt, finishedAt: null, exitCode: null };
const agent = { id: "primary", status: "active", executionTasks: [task] };
const call = { id: "call", actor: { id: "primary" }, workKind: "write", timestamp: finishedAt, status: null };

test("running execution takes priority over the latest tool and uses fixed vocabulary", () => {
  assert.deepEqual(projectSessionActivityFallback(entry, [agent], [call]), {
    label: "Running tests", state: "current", observedAt: startedAt, source: "execution_task", actor: "primary",
  });
  assert.equal(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [{ ...task, workKind: "unsupported" }] }]).label, "Running shell task");
});

test("last tool activity is never promoted to current by recency or tool status", () => {
  assert.deepEqual(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [] }], [{ ...call, status: "running" }]), {
    label: "file edit", state: "last_observed", observedAt: finishedAt, source: "tool", actor: "primary",
  });
  assert.equal(projectSessionActivityFallback(entry, [], [{ ...call, actor: { id: "missing" } }]).actor, "unknown");
});

test("only normalized running tasks with eligible lifecycle get a current summary", async (t) => {
  for (const changes of [
    { status: "idle" }, { status: "finished" }, { status: "stopped" }, { status: "unknown" }, { status: "warm" },
    { liveness: { evidence: "observed", freshness: "stale" } },
    { liveness: { evidence: "inferred", freshness: "current" } },
    { liveness: { evidence: "unavailable", freshness: "current" } },
    { liveness: { source: "structured_lifecycle" } },
  ]) await t.test(JSON.stringify(changes), () => {
    assert.equal(projectSessionActivityFallback(entry, [{ ...agent, ...changes }]).state, "last_observed");
  });
  for (const changes of [{ isLive: false }, ...["idle", "open", "stopped", "unknown"].map((activityStatus) => ({ activityStatus }))]) {
    const result = projectSessionActivityFallback({ ...entry, ...changes }, [agent]);
    assert.equal(result.state, "last_observed");
    assert.equal(result.label, "test run");
  }
  for (const changes of [{ finishedAt }, { exitCode: 1 }]) {
    assert.equal(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [{ ...task, ...changes }] }]).state, "last_observed");
  }
  assert.equal(projectSessionActivityFallback(entry, [{ ...agent, liveness: { evidence: "observed", freshness: "current" } }]).state, "current");
});

test("running subagents and multiple tasks keep their own attribution", () => {
  const child = { ...agent, id: "child" };
  assert.equal(projectSessionActivityFallback(entry, [child]).actor, "subagent");
  const multiple = projectSessionActivityFallback(entry, [agent, child]);
  assert.equal(multiple.label, "2 tasks running");
  assert.equal(multiple.actor, "multiple");
  const oneAgent = projectSessionActivityFallback(entry, [{ ...child, executionTasks: [task, { ...task, id: "other" }] }]);
  assert.equal(oneAgent.label, "2 tasks running");
  assert.equal(oneAgent.actor, "subagent");
  assert.equal(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [task, task] }]).label, "Running tests");
});

test("completion stops the current summary and failed/stopped tasks keep observed outcomes", () => {
  for (const status of ["completed", "failed", "stopped"]) {
    const result = projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [{ ...task, status, finishedAt }] }]);
    assert.deepEqual(result, {
      label: status === "completed" ? "test run" : `test run ${status}`,
      state: "last_observed", observedAt: finishedAt, source: "execution_task", actor: "primary",
    });
  }
  assert.equal(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [{ ...task, status: "completed", finishedAt }] }], [
    { ...call, timestamp: "2026-09-02T12:00:06.000Z" },
  ]).label, "file edit");
});

test("malformed or missing evidence stays unavailable without inventing tool classifications", () => {
  assert.equal(projectSessionActivityFallback(entry), null);
  for (const workKind of [null, undefined, "unknown", "constructor", "__proto__"]) {
    assert.equal(projectSessionActivityFallback(entry, [], [{ ...call, workKind }]), null);
  }
  for (const timestamp of [null, undefined, "not-a-date", "x".repeat(100)]) {
    assert.equal(projectSessionActivityFallback(entry, [], [{ ...call, timestamp }]), null);
    assert.equal(projectSessionActivityFallback(entry, [{ ...agent, executionTasks: [{ ...task, startedAt: timestamp }] }]), null);
  }
});

test("summary never includes tool/task text, actor identity, arguments, or extra fields", () => {
  const privateFields = { label: "PRIVATE_LABEL", tool: "PRIVATE_TOOL", detail: "PRIVATE_DETAIL", command: "PRIVATE_COMMAND", arguments: "PRIVATE_ARGUMENTS", result: "PRIVATE_RESULT", path: "PRIVATE_PATH", credential: "PRIVATE_CREDENTIAL" };
  const privateAgent = { ...agent, id: "PRIVATE_AGENT", label: "PRIVATE_ACTOR", executionTasks: [{ ...task, ...privateFields, id: "PRIVATE_TASK" }] };
  const before = structuredClone(privateAgent);
  const current = projectSessionActivityFallback(entry, [privateAgent]);
  const last = projectSessionActivityFallback({ ...entry, isLive: false }, [privateAgent], [{ ...call, ...privateFields, id: "PRIVATE_CALL", actor: { id: "PRIVATE_AGENT", label: "PRIVATE_ACTOR" } }]);
  assert.deepEqual(Object.keys(current).sort(), ["actor", "label", "observedAt", "source", "state"]);
  assert.doesNotMatch(JSON.stringify({ current, last }), /PRIVATE_/);
  assert.deepEqual(privateAgent, before);
});

test("cached fallback switches immediately to last observed when catalog stops working", () => {
  const current = projectSessionActivityFallback(entry, [agent]);
  const last = projectSessionActivityFallback({ ...entry, isLive: false }, [agent], [call]);
  assert.deepEqual(reconcileSessionActivityFallback(entry, current, last), current);
  assert.deepEqual(reconcileSessionActivityFallback({ ...entry, activityStatus: "idle" }, current, last), last);
  assert.deepEqual(reconcileSessionActivityFallback({ ...entry, isLive: false }, current, last), last);
  assert.equal(reconcileSessionActivityFallback({ ...entry, activityStatus: "unknown" }, current), null);
});
