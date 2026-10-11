import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TASK_GATE_THRESHOLD as CONTRACT_DEFAULT_THRESHOLD,
  TASK_GATE_REASONS as CONTRACT_REASONS,
  TASK_GATE_THRESHOLDS as CONTRACT_THRESHOLDS,
} from "../../../shared/task-contract.ts";
import {
  DEFAULT_TASK_GATE_THRESHOLD, TASK_GATE_REASONS, TASK_GATE_THRESHOLDS,
  evaluateGates, gateReadings, normalizeGateThreshold, queueGates,
} from "../../../server/tasks/task-gates.mjs";

const PASSING = {
  usage: { claude: { fiveHourPercent: 62, sevenDayPercent: 31 }, codex: { fiveHourPercent: 18, sevenDayPercent: 9 } },
  providerStatus: { claude: "operational", codex: "operational" },
  treeClean: true,
};
const CLAUDE = { provider: "claude", blockedBy: null };
const CODEX = { provider: "codex", blockedBy: null };
const reasons = (task, facts, settings) => evaluateGates(task, facts, settings).reasons;

test("the mirrored constants match shared/task-contract.ts", () => {
  assert.deepEqual([...TASK_GATE_THRESHOLDS], [...CONTRACT_THRESHOLDS]);
  assert.equal(DEFAULT_TASK_GATE_THRESHOLD, CONTRACT_DEFAULT_THRESHOLD);
  assert.deepEqual([...TASK_GATE_REASONS], [...CONTRACT_REASONS]);
});

test("only the fixed thresholds are thresholds", () => {
  for (const value of [70, 85, 95]) assert.equal(normalizeGateThreshold(value), value);
  for (const value of [0, 84, 100, "85", 85.5, null, undefined, NaN]) assert.equal(normalizeGateThreshold(value), undefined);
});

test("a task starts when every gate passes", () => {
  assert.deepEqual(evaluateGates(CLAUDE, PASSING, { threshold: 85 }), { ok: true, reasons: [] });
  assert.deepEqual(evaluateGates(CODEX, PASSING, {}), { ok: true, reasons: [] });
});

test("the readings carry whole percentages and fixed statuses for both providers", () => {
  assert.deepEqual(gateReadings({ ...PASSING, usage: { claude: { fiveHourPercent: 61.6, sevenDayPercent: 30.4 }, codex: null } }, { threshold: 70 }), {
    threshold: 70,
    usage: { claude: { status: "ok", fiveHourPercent: 62, sevenDayPercent: 30 }, codex: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null } },
    providerStatus: { claude: "ok", codex: "ok" },
    workingTree: "clean",
  });
});

test("usage at or above the threshold of the five-hour window holds the task's provider only", () => {
  const facts = { ...PASSING, usage: { ...PASSING.usage, claude: { fiveHourPercent: 85, sevenDayPercent: 10 } } };
  assert.deepEqual(reasons(CLAUDE, facts, { threshold: 85 }), ["usage_over"]);
  assert.deepEqual(reasons(CLAUDE, facts, { threshold: 95 }), []);
  assert.deepEqual(reasons(CODEX, facts, { threshold: 85 }), []);
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, usage: { ...PASSING.usage, claude: { fiveHourPercent: 84.4, sevenDayPercent: 99 } } }, { threshold: 85 }), []);
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, usage: { ...PASSING.usage, claude: { fiveHourPercent: 84.5, sevenDayPercent: 0 } } }, { threshold: 85 }), ["usage_over"]);
});

test("the seven-day reading is shown and decides nothing", () => {
  const facts = { ...PASSING, usage: { ...PASSING.usage, claude: { fiveHourPercent: 10, sevenDayPercent: null } } };
  assert.deepEqual(reasons(CLAUDE, facts, {}), []);
  assert.deepEqual(gateReadings(facts, {}).usage.claude, { status: "ok", fiveHourPercent: 10, sevenDayPercent: null });
});

test("a threshold outside the fixed list is the default", () => {
  for (const settings of [null, undefined, {}, { threshold: 50 }, { threshold: "95" }, []]) {
    assert.equal(gateReadings(PASSING, settings).threshold, 85);
  }
});

test("missing, partial, or malformed usage is unknown and holds", () => {
  for (const claude of [null, undefined, {}, "62", 62, [], { fiveHourPercent: null, sevenDayPercent: 31 }, { fiveHourPercent: "62" },
    { fiveHourPercent: -1 }, { fiveHourPercent: 101 }, { fiveHourPercent: NaN }, { fiveHourPercent: Infinity }]) {
    const facts = { ...PASSING, usage: { ...PASSING.usage, claude } };
    assert.deepEqual(reasons(CLAUDE, facts, {}), ["usage_unknown"]);
    assert.equal(gateReadings(facts, {}).usage.claude.status, "unknown");
    assert.equal(gateReadings(facts, {}).usage.claude.fiveHourPercent, null);
  }
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, usage: null }, {}), ["usage_unknown"]);
});

test("an incident or an unknown status of the task's provider holds", () => {
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, providerStatus: { claude: "incident", codex: "operational" } }, {}), ["provider_incident"]);
  assert.deepEqual(reasons(CODEX, { ...PASSING, providerStatus: { claude: "incident", codex: "operational" } }, {}), []);
  for (const claude of [null, undefined, "unknown", "degraded", "ok", true, {}]) {
    assert.deepEqual(reasons(CLAUDE, { ...PASSING, providerStatus: { claude, codex: "operational" } }, {}), ["provider_status_unknown"]);
  }
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, providerStatus: "operational" }, {}), ["provider_status_unknown"]);
});

test("a dirty or unknown working tree holds", () => {
  assert.deepEqual(reasons(CLAUDE, { ...PASSING, treeClean: false }, {}), ["tree_dirty"]);
  for (const treeClean of [null, undefined, "clean", 1, 0, {}]) assert.deepEqual(reasons(CLAUDE, { ...PASSING, treeClean }, {}), ["tree_unknown"]);
});

test("an earlier step that is not done holds, whatever names it", () => {
  assert.deepEqual(reasons({ provider: "claude", blockedBy: "T-12" }, PASSING, {}), ["previous_step"]);
  assert.deepEqual(reasons({ provider: "claude", blockedBy: "anything" }, PASSING, {}), ["previous_step"]);
});

test("no facts and no task hold on everything, in the fixed order", () => {
  for (const facts of [null, undefined, {}, [], "facts"]) {
    assert.deepEqual(evaluateGates(CLAUDE, facts, {}), { ok: false, reasons: ["usage_unknown", "provider_status_unknown", "tree_unknown"] });
  }
  for (const task of [null, undefined, {}, { provider: "other" }, { provider: null, blockedBy: null }]) {
    assert.deepEqual(evaluateGates(task, PASSING, {}), { ok: false, reasons: ["usage_unknown", "provider_status_unknown"] });
  }
  const everything = { usage: { claude: { fiveHourPercent: 99, sevenDayPercent: 1 } }, providerStatus: { claude: "incident" }, treeClean: false };
  const held = reasons({ provider: "claude", blockedBy: "T-1" }, everything, {});
  assert.deepEqual(held, ["previous_step", "usage_over", "provider_incident", "tree_dirty"]);
  assert.ok(held.every((reason) => TASK_GATE_REASONS.includes(reason)));
});

test("the queue block names the next task, its provider, its blocker, and why it waits", () => {
  assert.deepEqual(queueGates({ taskId: "T-15", provider: "claude", blockedBy: "T-12" }, PASSING, { threshold: 85 }), {
    ...gateReadings(PASSING, { threshold: 85 }),
    next: { taskId: "T-15", provider: "claude", blockedBy: "T-12", reasons: ["previous_step"] },
  });
  assert.deepEqual(queueGates({ taskId: "T-15", provider: "codex", blockedBy: null }, PASSING, {}).next,
    { taskId: "T-15", provider: "codex", blockedBy: null, reasons: [] });
  // A blocker that is not a task ID is not served, and still holds.
  assert.deepEqual(queueGates({ taskId: "T-15", provider: "codex", blockedBy: "C:\\repo" }, PASSING, {}).next,
    { taskId: "T-15", provider: "codex", blockedBy: null, reasons: ["previous_step"] });
});

test("no queued task, or a malformed one, is no next task", () => {
  for (const next of [null, undefined, {}, { taskId: "15", provider: "claude" }, { taskId: "T-15", provider: "other" }]) {
    assert.deepEqual(queueGates(next, PASSING, {}), { ...gateReadings(PASSING, {}), next: null });
  }
});
