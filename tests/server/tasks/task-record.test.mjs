import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TASK_COLUMNS as CONTRACT_DEFAULT_COLUMNS,
  TASK_BOUNDS as CONTRACT_BOUNDS,
  TASK_CHECKS as CONTRACT_CHECKS,
  TASK_EFFORTS as CONTRACT_EFFORTS,
  TASK_ID_PATTERN as CONTRACT_TASK_ID_PATTERN,
  TASK_PROVIDERS as CONTRACT_PROVIDERS,
  TASK_QUEUE_PAUSE_REASONS as CONTRACT_QUEUE_PAUSE_REASONS,
  TASK_QUEUE_STATUSES as CONTRACT_QUEUE_STATUSES,
  TASK_REPOSITORY_ID_PATTERN as CONTRACT_REPOSITORY_ID_PATTERN,
  TASK_STATES as CONTRACT_STATES,
  createEmptyTaskBoard,
} from "../../../shared/task-contract.ts";
import {
  DEFAULT_TASK_COLUMNS,
  TASK_BOUNDS,
  TASK_CHECKS,
  TASK_EFFORTS,
  TASK_PROVIDERS,
  TASK_QUEUE_PAUSE_REASONS,
  TASK_QUEUE_STATUSES,
  TASK_STATES,
  emptyBoard,
  isRepositoryId,
  isTaskId,
  normalizeBlockReason,
  normalizeChecks,
  normalizeColumnName,
  normalizeDoneWhen,
  normalizeFeatureName,
  normalizeModelIdentifier,
  normalizeOwnCondition,
  normalizeQueueReorderPayload,
  normalizeQueueTaskPayload,
  normalizeRun,
  normalizeStoredColumn,
  normalizeStoredFeature,
  normalizeStoredTask,
  normalizeTaskInput,
  normalizeTaskText,
  projectBoard,
  taskIdFromNumber,
} from "../../../server/tasks/task-record.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const COLUMN = `col-${"0".repeat(11)}1`;
const OTHER_COLUMN = `col-${"0".repeat(11)}2`;
const FEATURE = `feat-${"0".repeat(11)}1`;

function storedTask(overrides = {}) {
  return {
    repository_id: REPOSITORY, number: 1, text: "Write the release notes", column_id: COLUMN, position: 0,
    feature_id: null, step: null, run_provider: null, run_model: null, run_effort: null, checks: "[]",
    own_condition: null, state: "not_queued", scheduled_at: null, queue_position: null, session_id: null,
    dispatch_token: null, report_at: null, report_results: null, report_block_reason: null,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000, ...overrides,
  };
}

const repositoryRow = { queue_status: "idle", queue_blocked_by: null };
const columnRows = [{ id: COLUMN, name: "Backlog", position: 0 }, { id: OTHER_COLUMN, name: "Done", position: 1 }];

test("the monitor's mirrored constants match shared/task-contract.ts", () => {
  assert.deepEqual({ ...TASK_BOUNDS }, { ...CONTRACT_BOUNDS });
  assert.deepEqual([...TASK_CHECKS], [...CONTRACT_CHECKS]);
  assert.deepEqual([...TASK_STATES], [...CONTRACT_STATES]);
  assert.deepEqual([...TASK_PROVIDERS], [...CONTRACT_PROVIDERS]);
  assert.deepEqual([...TASK_EFFORTS], [...CONTRACT_EFFORTS]);
  assert.deepEqual([...TASK_QUEUE_STATUSES], [...CONTRACT_QUEUE_STATUSES]);
  assert.deepEqual([...TASK_QUEUE_PAUSE_REASONS], [...CONTRACT_QUEUE_PAUSE_REASONS]);
  assert.deepEqual([...DEFAULT_TASK_COLUMNS], [...CONTRACT_DEFAULT_COLUMNS]);
  assert.equal(isRepositoryId(REPOSITORY), CONTRACT_REPOSITORY_ID_PATTERN.test(REPOSITORY));
  for (const value of ["T-1", "T-0", "T-01", "T-999999999", "T-9999999999", "t-1", "T-"]) {
    assert.equal(isTaskId(value), CONTRACT_TASK_ID_PATTERN.test(value), value);
  }
  for (const readiness of ["ready", "loading", "unavailable", "desktop_only"]) {
    assert.deepEqual({ ...emptyBoard(REPOSITORY, readiness), runModels: { codex: [] } }, createEmptyTaskBoard(REPOSITORY, readiness));
  }
});

test("the contract's bounds are the product owner's bounds", () => {
  assert.deepEqual({ ...CONTRACT_BOUNDS }, {
    tasksPerRepository: 500, columnsPerRepository: 12, featuresPerRepository: 50, textLength: 4000,
    ownConditionLength: 500, columnNameLength: 40, featureNameLength: 80, blockReasonLength: 200, modelIdentifierLength: 120,
  });
  assert.deepEqual([...CONTRACT_DEFAULT_COLUMNS], ["Backlog", "Ready", "In progress", "Review", "Done"]);
});

test("repository IDs must be repo- followed by 24 lowercase hex characters", () => {
  assert.equal(isRepositoryId(REPOSITORY), true);
  for (const value of ["", "repo-", `repo-${"A".repeat(24)}`, `repo-${"a".repeat(23)}`, `repo-${"a".repeat(25)}`, `repo-${"g".repeat(24)}`,
    `${REPOSITORY}\n`, `../${REPOSITORY}`, null, undefined, 42, {}, [REPOSITORY]]) {
    assert.equal(isRepositoryId(value), false, String(value));
  }
});

test("task IDs are T- numbers from 1", () => {
  assert.equal(taskIdFromNumber(1), "T-1");
  assert.equal(taskIdFromNumber(42), "T-42");
  for (const value of [0, -1, 1.5, Number.NaN, "1", null, 1_000_000_000]) assert.equal(taskIdFromNumber(value), undefined, String(value));
});

test("task text is trimmed, multi-line, bounded, and free of control characters", () => {
  assert.equal(normalizeTaskText("  Fix the build\nthen push\tit  "), "Fix the build\nthen push\tit");
  assert.equal(normalizeTaskText("x".repeat(TASK_BOUNDS.textLength)), "x".repeat(TASK_BOUNDS.textLength));
  for (const value of ["", "   ", "x".repeat(TASK_BOUNDS.textLength + 1), "a\u0000b", "a\u001bb", "a\u2028b", "\ud800", null, undefined, 7, {}]) {
    assert.equal(normalizeTaskText(value), undefined, JSON.stringify(value));
  }
});

test("the own condition, block reason, and names enforce their own bounds", () => {
  assert.equal(normalizeOwnCondition(undefined), null);
  assert.equal(normalizeOwnCondition("   "), null);
  assert.equal(normalizeOwnCondition(" docs updated "), "docs updated");
  assert.equal(normalizeOwnCondition("x".repeat(TASK_BOUNDS.ownConditionLength)).length, TASK_BOUNDS.ownConditionLength);
  assert.equal(normalizeOwnCondition("x".repeat(TASK_BOUNDS.ownConditionLength + 1)), undefined);
  assert.equal(normalizeOwnCondition(5), undefined);

  assert.equal(normalizeBlockReason(null), null);
  assert.equal(normalizeBlockReason("needs a decision"), "needs a decision");
  assert.equal(normalizeBlockReason("x".repeat(TASK_BOUNDS.blockReasonLength + 1)), undefined);
  assert.equal(normalizeBlockReason("two\nlines"), undefined);

  assert.equal(normalizeColumnName(" Review "), "Review");
  assert.equal(normalizeColumnName("x".repeat(TASK_BOUNDS.columnNameLength)).length, TASK_BOUNDS.columnNameLength);
  for (const value of ["", "  ", "x".repeat(TASK_BOUNDS.columnNameLength + 1), "a\nb", "a\u0007b", null, 3]) {
    assert.equal(normalizeColumnName(value), undefined, JSON.stringify(value));
  }

  assert.equal(normalizeFeatureName("Billing rewrite"), "Billing rewrite");
  assert.equal(normalizeFeatureName("x".repeat(TASK_BOUNDS.featureNameLength)).length, TASK_BOUNDS.featureNameLength);
  for (const value of ["", "x".repeat(TASK_BOUNDS.featureNameLength + 1), "a\tb", undefined]) {
    assert.equal(normalizeFeatureName(value), undefined, JSON.stringify(value));
  }
});

test("a model identifier is bounded like the request model identifier", () => {
  assert.equal(normalizeModelIdentifier(null), null);
  assert.equal(normalizeModelIdentifier(undefined), null);
  assert.equal(normalizeModelIdentifier(""), null);
  assert.equal(normalizeModelIdentifier(" claude-sonnet-4-5 "), "claude-sonnet-4-5");
  assert.equal(normalizeModelIdentifier("gpt-5.2-codex"), "gpt-5.2-codex");
  assert.equal(normalizeModelIdentifier("a".repeat(TASK_BOUNDS.modelIdentifierLength)).length, TASK_BOUNDS.modelIdentifierLength);
  for (const value of ["a".repeat(TASK_BOUNDS.modelIdentifierLength + 1), "C:\\models\\x", "C:model", "/usr/models/x", "../x", "<b>x</b>",
    "use the fast one please", "model\nname", "-leading", 7, {}]) {
    assert.equal(normalizeModelIdentifier(value), undefined, JSON.stringify(value));
  }
});

test("the planned run holds a provider, a model, and an effort, all optional", () => {
  const empty = { provider: null, model: null, effort: null };
  assert.deepEqual(normalizeRun(undefined), empty);
  assert.deepEqual(normalizeRun(null), empty);
  assert.deepEqual(normalizeRun({}), empty);
  assert.deepEqual(normalizeRun({ provider: "codex", model: null, effort: "xhigh" }), { provider: "codex", model: null, effort: "xhigh" });
  assert.deepEqual(normalizeRun({ provider: "claude", model: "claude-opus-4-1", effort: "low" }), { provider: "claude", model: "claude-opus-4-1", effort: "low" });
  for (const value of [{ provider: "gemini" }, { effort: "max" }, { model: "C:\\x" }, { provider: "claude", extra: true }, "claude", [], 3]) {
    assert.equal(normalizeRun(value), undefined, JSON.stringify(value));
  }
});

test("a planned model needs its provider", () => {
  assert.equal(normalizeRun({ model: "opus" }), undefined);
  assert.equal(normalizeRun({ provider: null, model: "opus", effort: "low" }), undefined);
  assert.deepEqual(normalizeRun({ effort: "low" }), { provider: null, model: null, effort: "low" });
});

test("done-when checks are known, unique, and kept in contract order", () => {
  assert.deepEqual(normalizeChecks(undefined), []);
  assert.deepEqual(normalizeChecks(["ci_passed", "pr_open"]), ["pr_open", "ci_passed"]);
  assert.deepEqual(normalizeChecks([...TASK_CHECKS].reverse()), [...TASK_CHECKS]);
  for (const value of [["pr_open", "pr_open"], ["merged"], [1], "pr_open", [...TASK_CHECKS, "pr_open"]]) {
    assert.equal(normalizeChecks(value), undefined, JSON.stringify(value));
  }
  assert.deepEqual(normalizeDoneWhen(undefined), { checks: [], own: null });
  assert.deepEqual(normalizeDoneWhen({ checks: ["tree_clean"], own: " all tests green " }), { checks: ["tree_clean"], own: "all tests green" });
  assert.equal(normalizeDoneWhen({ checks: ["tree_clean"], own: "x".repeat(TASK_BOUNDS.ownConditionLength + 1) }), undefined);
  assert.equal(normalizeDoneWhen({ checks: [], own: null, command: "rm -rf" }), undefined);
});

test("a task input accepts only text, run, and done-when", () => {
  assert.deepEqual(normalizeTaskInput({ text: " Ship it " }), { text: "Ship it", run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null } });
  assert.equal(normalizeTaskInput({ text: "" }), undefined);
  assert.equal(normalizeTaskInput({ text: "ok", state: "done" }), undefined);
  assert.equal(normalizeTaskInput({ text: "ok", columnId: COLUMN }), undefined);
  assert.equal(normalizeTaskInput({ text: "ok", run: { provider: "nope" } }), undefined);
  assert.equal(normalizeTaskInput(null), undefined);
  assert.equal(normalizeTaskInput("text"), undefined);
});

test("stored columns and features are validated", () => {
  assert.deepEqual(normalizeStoredColumn({ id: COLUMN, name: "Backlog", position: 0 }), { id: COLUMN, name: "Backlog", position: 0 });
  assert.equal(normalizeStoredColumn({ id: "col-1", name: "Backlog", position: 0 }), undefined);
  assert.equal(normalizeStoredColumn({ id: COLUMN, name: "x".repeat(41), position: 0 }), undefined);
  assert.equal(normalizeStoredColumn({ id: COLUMN, name: "Backlog", position: -1 }), undefined);
  assert.deepEqual(normalizeStoredFeature({ id: FEATURE, name: "Billing" }), { id: FEATURE, name: "Billing" });
  assert.equal(normalizeStoredFeature({ id: COLUMN, name: "Billing" }), undefined);
  assert.equal(normalizeStoredFeature({ id: FEATURE, name: "x".repeat(81) }), undefined);
});

test("a stored task projects to exactly the contract keys", () => {
  const task = normalizeStoredTask(storedTask({
    feature_id: FEATURE, step: 2, run_provider: "claude", run_model: "claude-sonnet-4-5", run_effort: "high",
    checks: JSON.stringify(["pr_open", "tree_clean"]), own_condition: "docs updated", state: "needs_review",
    scheduled_at: 1_700_000_002_000, session_id: "6f1c-session",
    dispatch_token: "must-never-appear", queue_position: 3,
    report_at: 1_700_000_003_000, report_results: JSON.stringify([{ check: "pr_open", passed: true }, { check: "tree_clean", passed: false }]),
    report_block_reason: "waiting on review",
  }));
  assert.deepEqual(task, {
    id: "T-1", text: "Write the release notes", columnId: COLUMN, position: 0, featureId: FEATURE, step: 2,
    run: { provider: "claude", model: "claude-sonnet-4-5", effort: "high" },
    doneWhen: { checks: ["pr_open", "tree_clean"], own: "docs updated" },
    state: "needs_review",
    scheduledAt: "2023-11-14T22:13:22.000Z",
    session: { id: "6f1c-session", title: null, state: "unknown", observedModel: null },
    report: {
      at: "2023-11-14T22:13:23.000Z",
      results: [{ check: "pr_open", passed: true }, { check: "tree_clean", passed: false }],
      blockReason: "waiting on review",
    },
    createdAt: "2023-11-14T22:13:20.000Z", updatedAt: "2023-11-14T22:13:21.000Z",
  });
  assert.deepEqual(Object.keys(task).toSorted(), ["columnId", "createdAt", "doneWhen", "featureId", "id", "position", "report", "run",
    "scheduledAt", "session", "state", "step", "text", "updatedAt"]);
  assert.equal(JSON.stringify(task).includes("must-never-appear"), false);
});

test("a stored task outside the contract is rejected whole", () => {
  assert.notEqual(normalizeStoredTask(storedTask()), undefined);
  const invalid = [
    { number: 0 }, { text: "" }, { text: "x".repeat(TASK_BOUNDS.textLength + 1) }, { column_id: "col-nope" }, { position: -1 },
    { feature_id: FEATURE }, { step: 1 }, { feature_id: FEATURE, step: 0 }, { feature_id: "feat-nope", step: 1 },
    { run_provider: "gemini" }, { run_model: "C:\\x" }, { run_effort: "max" }, { checks: "not json" }, { checks: "{}" },
    { checks: JSON.stringify(["pr_open", "pr_open"]) }, { own_condition: "x".repeat(TASK_BOUNDS.ownConditionLength + 1) },
    { state: "running" }, { scheduled_at: -5 }, { session_id: "../etc/passwd" }, { created_at: "yesterday" }, { updated_at: 1e20 },
    { report_at: null, report_results: "[]" },
    { report_at: 1_700_000_000_000, report_results: "nope" },
    { report_at: 1_700_000_000_000, report_results: JSON.stringify([{ check: "pr_open", passed: "yes" }]) },
    { report_at: 1_700_000_000_000, report_results: JSON.stringify([{ check: "other", passed: true }]) },
    { report_at: 1_700_000_000_000, report_results: JSON.stringify([{ check: "pr_open", passed: true, output: "stdout" }]) },
    { report_at: 1_700_000_000_000, report_results: "[]", report_block_reason: "x".repeat(TASK_BOUNDS.blockReasonLength + 1) },
  ];
  for (const overrides of invalid) assert.equal(normalizeStoredTask(storedTask(overrides)), undefined, JSON.stringify(overrides));
});

test("the board orders columns and tasks and derives feature completion", () => {
  const board = projectBoard(REPOSITORY, {
    repository: { queue_status: "blocked", queue_blocked_by: "T-3" },
    columns: [{ id: OTHER_COLUMN, name: "Done", position: 1 }, { id: COLUMN, name: "Backlog", position: 0 }],
    features: [{ id: FEATURE, name: "Billing" }, { id: `feat-${"0".repeat(11)}2`, name: "Empty" }],
    tasks: [
      storedTask({ number: 3, column_id: OTHER_COLUMN, position: 0, state: "done", feature_id: FEATURE, step: 1 }),
      storedTask({ number: 2, column_id: COLUMN, position: 1 }),
      storedTask({ number: 1, column_id: COLUMN, position: 1, state: "done", feature_id: FEATURE, step: 2 }),
    ],
  });
  assert.equal(board.version, 1);
  assert.equal(board.readiness, "ready");
  assert.equal(board.repositoryId, REPOSITORY);
  assert.deepEqual(board.columns.map((column) => column.id), [COLUMN, OTHER_COLUMN]);
  assert.deepEqual(board.tasks.map((task) => task.id), ["T-1", "T-2", "T-3"]);
  assert.deepEqual(board.features, [
    { id: FEATURE, name: "Billing", done: true },
    { id: `feat-${"0".repeat(11)}2`, name: "Empty", done: false },
  ]);
  assert.deepEqual(board.queue, { status: "blocked", blockedBy: "T-3", pauseReason: null, order: [] });

  const pending = projectBoard(REPOSITORY, {
    repository: repositoryRow, columns: columnRows, features: [{ id: FEATURE, name: "Billing" }],
    tasks: [storedTask({ number: 1, state: "done", feature_id: FEATURE, step: 1 }), storedTask({ number: 2, state: "queued", feature_id: FEATURE, step: 2 })],
  });
  assert.equal(pending.features[0].done, false);
});

test("a board with inconsistent or out-of-bound rows is not projected", () => {
  const base = { repository: repositoryRow, columns: columnRows, features: [], tasks: [] };
  assert.equal(projectBoard(REPOSITORY, base).readiness, "ready");
  assert.equal(projectBoard("repo-nope", base), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, repository: undefined }), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, repository: { queue_status: "stuck", queue_blocked_by: null } }), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, repository: { queue_status: "blocked", queue_blocked_by: "task one" } }), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, tasks: [storedTask({ column_id: `col-${"f".repeat(12)}` })] }), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, tasks: [storedTask({ feature_id: FEATURE, step: 1 })] }), undefined);
  assert.equal(projectBoard(REPOSITORY, { ...base, tasks: [storedTask({ text: "" })] }), undefined);

  const columns = (count) => Array.from({ length: count }, (_, index) => ({ id: `col-${index.toString(16).padStart(12, "0")}`, name: `C${index}`, position: index }));
  assert.equal(projectBoard(REPOSITORY, { ...base, columns: columns(TASK_BOUNDS.columnsPerRepository) }).columns.length, 12);
  assert.equal(projectBoard(REPOSITORY, { ...base, columns: columns(TASK_BOUNDS.columnsPerRepository + 1) }), undefined);
  const features = (count) => Array.from({ length: count }, (_, index) => ({ id: `feat-${index.toString(16).padStart(12, "0")}`, name: `F${index}` }));
  assert.equal(projectBoard(REPOSITORY, { ...base, features: features(TASK_BOUNDS.featuresPerRepository) }).features.length, 50);
  assert.equal(projectBoard(REPOSITORY, { ...base, features: features(TASK_BOUNDS.featuresPerRepository + 1) }), undefined);
  const tasks = (count) => Array.from({ length: count }, (_, index) => storedTask({ number: index + 1, position: index }));
  assert.equal(projectBoard(REPOSITORY, { ...base, tasks: tasks(TASK_BOUNDS.tasksPerRepository) }).tasks.length, 500);
  assert.equal(projectBoard(REPOSITORY, { ...base, tasks: tasks(TASK_BOUNDS.tasksPerRepository + 1) }), undefined);
});

test("a pause reason is projected only for a paused queue and only from the fixed list", () => {
  const paused = (reason, status = "paused") => projectBoard(REPOSITORY, {
    repository: { queue_status: status, queue_blocked_by: "T-2", pause_reason: reason }, columns: columnRows, features: [], tasks: [],
  }).queue;
  for (const reason of TASK_QUEUE_PAUSE_REASONS) assert.deepEqual(paused(reason), { status: "paused", blockedBy: "T-2", pauseReason: reason, order: [] });
  for (const reason of ["unknown", "", null, undefined, 7, {}, "Start_Failed", "C:\secret\path"]) assert.equal(paused(reason).pauseReason, null, String(reason));
  for (const status of ["idle", "running", "blocked"]) assert.equal(paused("start_failed", status).pauseReason, null, status);
});

test("an empty board carries no content", () => {
  assert.deepEqual(emptyBoard(REPOSITORY, "unavailable"), {
    version: 1, readiness: "unavailable", repositoryId: REPOSITORY, columns: [], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
  });
});

test("the projected queue order lists queued task IDs only and keeps the private queue position off every task", () => {
  const board = projectBoard(REPOSITORY, {
    repository: repositoryRow, columns: columnRows, features: [{ id: FEATURE, name: "Billing" }],
    tasks: [
      storedTask({ number: 1, state: "queued", queue_position: 9, position: 0 }),
      storedTask({ number: 2, state: "queued", feature_id: FEATURE, step: 2, queue_position: 0, position: 1 }),
      storedTask({ number: 3, state: "queued", feature_id: FEATURE, step: 1, queue_position: 4, position: 2 }),
      storedTask({ number: 4, state: "done", queue_position: 1, position: 3 }),
      storedTask({ number: 5, state: "queued", queue_position: 2, position: 4 }),
      storedTask({ number: 6, state: "queued", queue_position: "junk", position: 5 }),
    ],
  });
  assert.deepEqual(board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: ["T-3", "T-2", "T-5", "T-1", "T-6"] });
  for (const task of board.tasks) assert.equal(Object.hasOwn(task, "queuePosition"), false);
  assert.equal(JSON.stringify(board).includes("queue_position"), false);
});

test("queue payloads carry exactly their keys", () => {
  assert.deepEqual(normalizeQueueTaskPayload({ id: "T-12" }), { number: 12 });
  for (const value of [undefined, null, "T-1", [], {}, { id: "T-0" }, { id: 1 }, { id: "T-1", step: 1 }, { id: "T-1", x: 1 }]) {
    assert.equal(normalizeQueueTaskPayload(value), undefined, JSON.stringify(value));
  }
  assert.deepEqual(normalizeQueueReorderPayload({ id: "T-3", step: 2 }), { number: 3, step: 2 });
  for (const value of [undefined, null, [], {}, { id: "T-3" }, { step: 2 }, { id: "T-3", step: 0 }, { id: "T-3", step: -1 }, { id: "T-3", step: 1.5 },
    { id: "T-3", step: "2" }, { id: "T-3", step: null }, { id: "T-3", step: 2 ** 53 }, { id: "T-0", step: 1 }, { id: "T-3", step: 1, extra: 1 }]) {
    assert.equal(normalizeQueueReorderPayload(value), undefined, JSON.stringify(value));
  }
});
