import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CHAT_INSTRUCTIONS,
  BOARD_SNAPSHOT_BUDGET,
  BOARD_SNAPSHOT_LIMIT,
  BOARD_TEXT_BUDGET,
  boardSnapshot,
  composePromptParts,
} from "../desktop/runtime/agent-chat-prompt.mjs";
import { LARGE_NOW, largeBoard, largePromptOptions } from "./helpers/agent-chat-large-board.mjs";

// What the same synthetic board cost before the prompt was made smaller, in characters: the fixed instructions, the board snapshot,
// and the whole owner-message prompt with a full history of 24,000 characters. The board has 120 tasks, 86 of them Done, each with a
// specification text of 1,400 to 3,800 characters; the owner's real prompts ran 79,000 to 131,000.
const BEFORE = Object.freeze({ instructions: 37_983, board: 66_173, total: 129_785 });
// The bounds are set from the measurement (instructions 36,867; board 19,992; total 82,488), with a little room.
const AFTER_BOUND = Object.freeze({ instructions: 37_000, board: 20_500, total: 84_000 });

const options = largePromptOptions();
const parts = composePromptParts(options);
const snapshot = boardSnapshot(options.board, options);
const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
const firstLine = (text) => text.split("\n")[0];

test("a board shaped like the owner's busiest one stays small, and the prompt is at least 35% smaller than before", () => {
  assert.equal(options.board.tasks.length, 120);
  assert.equal(options.board.tasks.filter((task) => task.columnId === "col-done").length, 86);
  assert.ok(parts, "the prompt fits");
  assert.equal(parts.sections.instructions, AGENT_CHAT_INSTRUCTIONS.length);
  assert.ok(parts.sections.instructions <= AFTER_BOUND.instructions, `instructions ${parts.sections.instructions}`);
  assert.ok(parts.sections.board <= AFTER_BOUND.board, `board ${parts.sections.board}`);
  assert.ok(parts.prompt.length <= AFTER_BOUND.total, `total ${parts.prompt.length}`);
  assert.ok(JSON.stringify(snapshot).length <= BOARD_SNAPSHOT_BUDGET);
  assert.equal(BOARD_SNAPSHOT_BUDGET, BOARD_SNAPSHOT_LIMIT);
  assert.ok(parts.prompt.length <= BEFORE.total * 0.65, `the whole prompt is ${(100 * (1 - parts.prompt.length / BEFORE.total)).toFixed(1)}% smaller`);
  assert.ok(parts.sections.board <= BEFORE.board * 0.35, "the board is at least 65% smaller");
  assert.ok(parts.sections.instructions < BEFORE.instructions);
});

test("tasks that are not finished keep what Aril needs to act on them", () => {
  const active = options.board.tasks.filter((task) => ["col-ready", "col-progress", "col-review"].includes(task.columnId));
  assert.equal(active.length, 15);
  for (const source of active) {
    const task = byId.get(source.id);
    assert.ok(task, `${source.id} has a full entry`);
    assert.equal(task.state, source.state);
    assert.equal(typeof task.column, "string");
    assert.equal(Number.isInteger(task.position), true);
    assert.deepEqual([task.provider, task.model, task.effort], [source.run.provider, source.run.model, source.run.effort]);
    assert.deepEqual(task.complete_when, source.completeWhen.checks);
    assert.equal(task.text.startsWith(firstLine(source.text)), true, `${source.id} keeps its title line`);
    assert.equal(task.text_cut === true, task.text.length < source.text.length, `${source.id} says whether its text was cut`);
  }
  for (const id of ["T-115", "T-116", "T-117", "T-118", "T-119"]) assert.ok(["passed", "failed"].includes(byId.get(id).review.state), `${id} keeps its review`);
  assert.deepEqual(byId.get("T-113").report, { block_reason: "The provider asked for a credential the task does not have." });
  assert.equal(byId.get("T-117").report.attention, "Check the narrow layout.");
  assert.equal(byId.get("T-112").state, "stalled");
  assert.match(snapshot.index.find((line) => line.startsWith("T-120 ")), /^T-120 Backlog#18 not_queued .*after T-111 /u, "a task that runs after another keeps the hold in its index line");
  assert.equal(byId.get("T-110").scheduled_at !== undefined, true);
});

test("a Done card keeps its run, results, and title line, and the counts of all of them stay whole", () => {
  const recent = [...byId.values()].filter((task) => task.column === "Done");
  assert.ok(recent.length >= 5, "the most recent Done cards keep a full entry");
  for (const task of recent) {
    const source = options.board.tasks.find((candidate) => candidate.id === task.id);
    assert.equal(task.text, firstLine(source.text), `${task.id} keeps only its title line`);
    assert.equal(Object.hasOwn(task, "complete_when"), false);
    assert.equal(Object.hasOwn(task, "own_condition"), false);
    assert.ok(task.session.ref.startsWith(`${task.provider}:`), "the session reference stays for get_session_report");
    assert.ok(Array.isArray(task.report.passed) && task.report.passed.length > 0);
  }
  assert.equal(snapshot.tasks_omitted.done + recent.length >= 18, true, "older Done cards left out are counted");
  assert.equal(snapshot.done.total, 86);
  assert.equal(snapshot.done.by_run.reduce((sum, row) => sum + row.tasks, 0), 86);
  assert.equal(snapshot.done.recent.length, 10);
  assert.deepEqual(snapshot.rework.by_cause, { missed_wiring: 1, spec_gap: 1, wrong_behavior: 1 });
});

test("every snapshot field the instructions tell Aril to read is in the snapshot", () => {
  const fields = [
    ["aril_settings", snapshot.aril_settings], ["memory", snapshot.memory], ["done.by_run", snapshot.done.by_run], ["rework", snapshot.rework],
    ["queue.usage", snapshot.queue.usage], ["queue.start_threshold_percent", snapshot.queue.start_threshold_percent], ["queue.status", snapshot.queue.status],
    ["queue.order", snapshot.queue.order], ["models", snapshot.models], ["index", snapshot.index], ["task_text.cut", snapshot.task_text.cut],
    ["tasks_omitted", snapshot.tasks_omitted], ["text_cut", [...byId.values()].find((task) => task.text_cut)?.text_cut], ["runs_after", [...byId.values()].find((task) => task.runs_after)?.runs_after],
    ["reworked_by", [...byId.values()].find((task) => task.reworked_by)?.reworked_by], ["reworks", [...byId.values()].find((task) => task.reworks)?.reworks],
    ["session", byId.get("T-111").session], ["complete_when", byId.get("T-111").complete_when], ["own_condition", byId.get("T-105").own_condition],
    ["block_reason", byId.get("T-113").report.block_reason], ["attention", byId.get("T-117").report.attention],
    ["observed_model", [...byId.values()].find((task) => task.session?.observed_model)?.session.observed_model],
  ];
  for (const [name, value] of fields) {
    assert.notEqual(value, undefined, `${name} is in the snapshot`);
    assert.equal(AGENT_CHAT_INSTRUCTIONS.includes(name.split(".").at(-1)), true, `${name} is in the instructions`);
  }
  // Aril settings, the grant, and the feature IDs a work rule names are still in it, in full.
  assert.deepEqual(snapshot.aril_settings.workRules, options.board.aril.settings.workRules);
  assert.equal(snapshot.grant.active, true);
  assert.deepEqual(snapshot.features.map(({ id }) => id), options.board.features.map(({ id }) => id));
  // The instructions describe the compact shape: a null or empty field is left out, and a report lists checks by result.
  assert.match(AGENT_CHAT_INSTRUCTIONS, /A null or empty field is left out/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /checks that passed, failed, or were unavailable/u);
});

test("the shared text budget holds on the large board, and every body it cut points to get_task", () => {
  assert.ok(snapshot.tasks.reduce((sum, task) => sum + task.text.length, 0) <= BOARD_TEXT_BUDGET + snapshot.tasks.reduce((sum, task) => sum + firstLine(task.text).length, 0));
  assert.deepEqual(snapshot.task_text, { cut: snapshot.tasks.filter((task) => task.text_cut).length, total: snapshot.tasks.length });
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Use get_task with a task ID to read its whole text and conditions on this board when a task you need has text_cut/u);
});

const small = (task) => boardSnapshot({
  columns: [{ id: "col-b", name: "Ready" }, { id: "col-d", name: "Done", role: "done" }], features: [{ id: "feat-1", name: "Auth", done: false }],
  tasks: [{ id: "T-1", text: "Write the plan", columnId: "col-b", position: 2, state: "needs_review", featureId: "feat-1", updatedAt: "2026-10-02T09:00:00.000Z", ...task }],
}, { now: LARGE_NOW, lastCompletedAt: -1 });

test("a full task leaves out every null or empty field, and a report lists its checks by result", () => {
  const bare = small({ featureId: "none", run: {}, completeWhen: { checks: [], own: "" }, session: null, source: null, updatedAt: "", group: null, report: { results: [], blockReason: "", attention: "" } });
  assert.deepEqual(bare.tasks, [{ id: "T-1", column: "Ready", position: 2, state: "needs_review", text: "Write the plan" }]);
  const results = [{ check: "pr_open", passed: true }, { check: "ci_passed", passed: false }, { check: "tree_clean", passed: false, unavailable: true }, { check: "bogus", passed: true }, null];
  assert.deepEqual(small({ report: { results, blockReason: "Waiting", attention: "Look" } }).tasks[0].report, {
    passed: ["pr_open"], failed: ["ci_passed"], unavailable: ["tree_clean"], block_reason: "Waiting", attention: "Look",
  });
  const full = small({ run: { provider: "claude", model: "claude-opus-4-1", effort: "high" }, completeWhen: { checks: ["pr_open", "bogus"], own: "Changelog" }, source: { number: 7 } }).tasks[0];
  assert.deepEqual(full, {
    id: "T-1", column: "Ready", position: 2, state: "needs_review", feature: "Auth", provider: "claude", model: "claude-opus-4-1", effort: "high",
    complete_when: ["pr_open"], own_condition: "Changelog", github_issue: 7, updated_at: "2026-10-02T09:00:00.000Z", text: "Write the plan",
  });
});

test("a session shows its observed model and effort only where they differ from the plan, and the record still counts them", () => {
  const run = { provider: "claude", model: "claude-opus-4-1", effort: "high" };
  const session = (extra) => ({ id: "claude:abc-1", state: "ended", ...extra });
  assert.deepEqual(small({ run, session: session({ observedModel: "claude-opus-4-1[1m]", observedEffort: "xhigh" }) }).tasks[0].session,
    { ref: "claude:abc-1", state: "ended", observed_model: "claude-opus-4-1[1m]", observed_effort: "xhigh" });
  assert.deepEqual(small({ run, session: session({ observedModel: "claude-opus-4-1", observedEffort: "high" }) }).tasks[0].session, { ref: "claude:abc-1", state: "ended" });
  assert.deepEqual(small({ run, session: session({ observedModel: "claude-sonnet-5-5" }) }).tasks[0].session, { ref: "claude:abc-1", state: "ended", observed_model: "claude-sonnet-5-5" });
  const done = small({ columnId: "col-d", state: "done", run, session: session({ observedModel: "claude-opus-4-1" }) });
  assert.deepEqual(done.done.by_run.map(({ provider, model, effort }) => ({ provider, model, effort })), [{ provider: "claude", model: "claude-opus-4-1", effort: "high" }]);
  assert.equal(Object.hasOwn(small({ session: { id: "", state: "" } }).tasks[0], "session"), false, "a session with nothing in it is left out");
});

test("the same board in any order gives the same snapshot, and nothing private reaches it", () => {
  const board = largeBoard();
  assert.deepEqual(boardSnapshot({ ...board, tasks: board.tasks.toReversed() }, options), snapshot);
  const serialized = JSON.stringify(snapshot);
  for (const value of ["PRIVATE_REVIEWER", "C:\\\\Users\\\\owner", "repo-0123456789abcdef01234567", "private description", "transcriptPath"]) assert.equal(serialized.includes(value), false, value);
  assert.equal(snapshot.now, LARGE_NOW.toISOString());
});
