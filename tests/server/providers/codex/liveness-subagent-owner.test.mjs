import assert from "node:assert/strict";
import test from "node:test";
import { createCodexLivenessCoordinator } from "../../../../server/providers/codex/liveness.mjs";

const START = Date.parse("2026-10-26T16:03:01.000Z");
const ROOT = "01a178f3-6bfa-7b61-9f4a-62b7cab4c626";
const SUBAGENT = "01a178f4-7ad9-7192-9c5e-34a45de6cedd";

const thread = (localId, parentThreadId = null) => ({
  localId, sessionId: ROOT, parentThreadId, sourceKind: parentThreadId ? "subAgentThreadSpawn" : "cli",
  updatedAt: new Date(START).toISOString(), runtimeStatus: null, rolloutFile: null,
});

// T-181: desktop main links a task-started Codex session by the process it launched. A subagent
// thread runs in that same process, so the process must resolve to the root session, never the subagent.
test("a Codex process that runs a subagent owns only its root session", () => {
  const owner = { pid: 4242, processStartIdentity: "134000000000000000" };
  const observed = createCodexLivenessCoordinator({ now: () => START, cacheMs: 0, currentWriterOwner: () => owner })
    .observe([thread(ROOT), thread(SUBAGENT, ROOT)]);
  assert.deepEqual([...observed.sessions.keys()], [ROOT]);
  assert.deepEqual(observed.sessions.get(ROOT).resourceOwner, owner);
  assert.equal(observed.threads.find((item) => item.localId === SUBAGENT).presenceConfirmed, true);
});
