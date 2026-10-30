// A synthetic board shaped like a busy owner's: about 120 tasks, most of them Done, each with a long specification text,
// recent Done work, groups and holds, rework links, Aril settings, and repository memory. It holds no real repository value.
// Tests use it to measure what the board snapshot and the whole prompt cost, and to keep them from growing again.

export const LARGE_NOW = new Date("2026-10-29T12:00:00.000Z");
// The newest Aril answer ended five hours before the turn, as when the owner asks again later the same day.
export const LARGE_LAST_COMPLETED_AT = LARGE_NOW.getTime() - 5 * 3_600_000;

export const LARGE_COLUMNS = [
  { id: "col-backlog", name: "Backlog", role: "backlog" }, { id: "col-ready", name: "Ready" },
  { id: "col-progress", name: "In progress", role: "in_progress" }, { id: "col-review", name: "Review", role: "review" },
  { id: "col-done", name: "Done", role: "done" },
];

const FEATURES = ["Agent chat", "Task board", "Desktop shell", "Observation cache", "Metrics", "Pairing"]
  .map((name, index) => ({ id: `feat-${index + 1}`, name, done: index === 5, description: "private description" }));
const TAGS = ["ui", "server", "docs", "tests", "desktop", "bug"];
const AREAS = ["the chat panel", "the task window", "the queue", "the monitor cache", "the preload allow-list", "the pairing sheet", "the usage gates", "the checkpoint store"];
const VERBS = ["Show", "Stop", "Keep", "Move", "Fix", "Split", "Record", "Hide"];
const SENTENCES = [
  "Read the owner page for this subject before you change anything, and keep its privacy invariants.",
  "The change touches the store, the route, the preload allow-list, and the client parser, so each one needs its own test.",
  "Do not change the normalized API contract; if a field must change, change the frontend and the documentation in the same pull request.",
  "Add a focused test that fails without the change, run it alone first, and then run the whole suite for the area.",
  "Keep the last known-good revision until a complete replacement validates and commits atomically.",
  "The acceptance condition is a pull request that passes CI, with the diff limited to the files named above and no unrelated cleanup.",
  "When a layout change is involved, check it at the narrow width and in the dark theme before you deliver.",
  "Explain in the pull request description what was measured and what was only reasoned about; never call a heuristic a measurement.",
];

// A small deterministic generator, so the fixture is the same on every run.
function generator(seed) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
}

function specification(number, length, random) {
  const title = `[ ${TAGS[number % TAGS.length]} ] ${VERBS[number % VERBS.length]} ${AREAS[(number * 3) % AREAS.length]} (step ${number})`;
  const parts = [title, "", "Goal", `Make ${AREAS[number % AREAS.length]} behave as the design page says, in one pull request that one session can finish and verify.`, "", "Files and constraints"];
  let size = parts.join("\n").length;
  while (size < length) {
    const sentence = SENTENCES[Math.floor(random() * SENTENCES.length)];
    parts.push(`- ${sentence} (T-${number}, ${AREAS[Math.floor(random() * AREAS.length)]})`);
    size += sentence.length + 24;
  }
  parts.push("", "Acceptance", "The checks pass, the pull request is open, and the working tree is clean.");
  return parts.join("\n");
}

const RUNS = [
  { provider: "claude", model: "claude-opus-5-5", effort: "medium", observed: "claude-opus-5-5[1m]" },
  { provider: "claude", model: "claude-sonnet-5-5", effort: "high", observed: "claude-sonnet-5-5" },
  { provider: "codex", model: "gpt-6-sol", effort: "high", observed: "gpt-6-sol" },
  { provider: "codex", model: "gpt-6-terra", effort: "medium", observed: "gpt-6-terra" },
];
const CHECKS = ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"];
const iso = (ms) => new Date(ms).toISOString();

function baseTask(number, random, overrides) {
  const run = RUNS[number % RUNS.length];
  const checks = CHECKS.slice(0, 3 + (number % 4));
  const text = specification(number, 1_400 + Math.floor(random() * 2_400), random);
  return {
    id: `T-${number}`, text, position: 0, featureId: FEATURES[number % FEATURES.length].id,
    run: { provider: run.provider, model: run.model, effort: run.effort, remoteControl: true },
    completeWhen: { checks, own: number % 5 === 0 ? "The design page and the contract test change together." : null },
    repositoryId: "repo-0123456789abcdef01234567", worktreePath: `C:\\Users\\owner\\repo\\.worktrees\\t-${number}`,
    ...overrides,
  };
}

function doneTask(number, random, updatedAt, group = null, after = []) {
  const run = RUNS[number % RUNS.length];
  const task = baseTask(number, random, { columnId: "col-done", state: "done", updatedAt: iso(updatedAt), group, after });
  task.session = { id: `${run.provider}:00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, state: "ended", observedModel: run.observed, observedEffort: run.effort, transcriptPath: `C:\\Users\\owner\\.claude\\${number}.jsonl` };
  task.report = {
    results: task.completeWhen.checks.map((check) => ({ check, passed: !(check === "ci_passed" && number % 11 === 0), ...(check === "user_validated" && number % 7 === 0 ? { unavailable: true } : {}) }))
      .map((result) => (result.unavailable ? { ...result, passed: false } : result)),
    blockReason: null, attention: number % 9 === 0 ? "The migration needs a look before the next release." : null,
  };
  task.source = number % 6 === 0 ? { number: 100 + number } : null;
  return task;
}

/** The board: 120 tasks (86 Done, 18 Backlog, 6 Ready, 4 In progress, 5 Review, 1 scheduled in Ready). */
export function largeBoard() {
  const random = generator(20_261_029);
  const tasks = [];
  const hour = 3_600_000;
  const group = (letter) => `grp-${letter.repeat(12)}`;
  for (let number = 1; number <= 86; number += 1) {
    // The last ten finished in the five hours before the turn; the others finished one to nineteen days earlier.
    const age = number >= 77 ? (87 - number) * 0.5 * hour : (24 + (77 - number) * 5.5) * hour;
    const grouped = [30, 31, 32, 85].includes(number) ? group("a") : [60, 61, 77, 78].includes(number) ? group("b") : [70, 71, 72, 73].includes(number) ? group("c") : null;
    const after = number === 79 ? ["T-75", "T-76"] : number === 80 ? ["T-50"] : [];
    const task = doneTask(number, random, LARGE_NOW.getTime() - age, grouped, after);
    task.position = 86 - number;
    tasks.push(task);
  }
  for (let number = 87; number <= 104; number += 1) {
    tasks.push(baseTask(number, random, { columnId: "col-backlog", state: "not_queued", position: number - 87, updatedAt: iso(LARGE_NOW.getTime() - (30 + number) * hour) }));
  }
  for (let number = 105; number <= 110; number += 1) {
    tasks.push(baseTask(number, random, { columnId: "col-ready", state: number === 110 ? "scheduled" : "queued", position: number - 105, updatedAt: iso(LARGE_NOW.getTime() - (40 + number) * hour),
      scheduledAt: number === 110 ? iso(LARGE_NOW.getTime() + 6 * hour) : undefined }));
  }
  const live = (number, state, extra = {}) => {
    const run = RUNS[number % RUNS.length];
    return baseTask(number, random, { columnId: "col-progress", state, position: number - 111, updatedAt: iso(LARGE_NOW.getTime() - (number - 110) * hour),
      session: { id: `${run.provider}:00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, state: state === "stalled" ? "ended" : "running", observedModel: run.observed, observedEffort: run.effort },
      report: state === "blocked" ? { results: [], blockReason: "The provider asked for a credential the task does not have.", attention: null } : undefined, ...extra });
  };
  tasks.push(live(111, "running"), live(112, "stalled"), live(113, "blocked"), live(114, "running"));
  for (let number = 115; number <= 119; number += 1) {
    const run = RUNS[number % RUNS.length];
    tasks.push(baseTask(number, random, { columnId: "col-review", state: "needs_review", position: number - 115, updatedAt: iso(LARGE_NOW.getTime() - (number - 114) * hour),
      session: { id: `${run.provider}:00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, state: "ended", observedModel: run.observed, observedEffort: run.effort },
      report: { results: [{ check: "pr_open", passed: true }, { check: "tree_clean", passed: true }], blockReason: null, attention: number === 117 ? "Check the narrow layout." : null },
      review: number % 2 === 0 ? { state: "failed", at: iso(LARGE_NOW.getTime() - hour), reasons: ["The checks failed on the pull request head."], sessionId: "PRIVATE_REVIEWER" } : { state: "passed", at: iso(LARGE_NOW.getTime() - hour), reasons: [], sessionId: "PRIVATE_REVIEWER" } }));
  }
  tasks.push(baseTask(120, random, { columnId: "col-backlog", state: "not_queued", position: 18, updatedAt: iso(LARGE_NOW.getTime() - 90 * hour), after: ["T-111"] }));
  // Earlier work was reworked by later fixes: a recent task by a task, an old one by a task, and a pull request by a pull request.
  const task = (id) => tasks.find((candidate) => candidate.id === id);
  task("T-83").reworkedBy = [{ ref: "T-86", cause: "missed_wiring" }];
  task("T-86").reworks = [{ ref: "T-83", cause: "missed_wiring" }];
  task("T-52").reworkedBy = [{ ref: "T-84", cause: "wrong_behavior" }];
  task("T-84").reworks = [{ ref: "T-52", cause: "wrong_behavior" }];
  task("T-107").after = ["T-105"];
  const rework = [
    { fix: "T-86", reworks: "T-83", cause: "missed_wiring", at: LARGE_NOW.getTime() - 3 * hour },
    { fix: "#402", reworks: "#401", cause: "spec_gap", at: LARGE_NOW.getTime() - 48 * hour },
    { fix: "T-84", reworks: "T-52", cause: "wrong_behavior", at: LARGE_NOW.getTime() - 24 * hour },
  ];
  return {
    repositoryId: "repo-0123456789abcdef01234567", repositoryRoot: "C:\\Users\\owner\\repo", readiness: "ready",
    columns: LARGE_COLUMNS, features: FEATURES, tasks, rework,
    queue: {
      status: "running", order: ["T-105", "T-106", "T-107", "T-108", "T-109", "T-110"], blockedBy: null,
      gates: { threshold: 80, usage: { claude: { fiveHourPercent: 31, sevenDayPercent: 52 }, codex: { fiveHourPercent: 12, sevenDayPercent: 20 } } },
    },
    runModels: { codex: [{ id: "gpt-6-sol" }, { id: "gpt-6-terra" }, { id: "gpt-6-luna" }] },
    aril: {
      settings: {
        actions: { start: true, review: true, sendBack: true, merge: true, writeTasks: true, markDone: true }, mergeMethod: "squash", mergeMode: "auto", deleteBranch: true,
        limits: { hours: 8, tasks: 20, tasksAtATime: 2, sendBacks: 2, usagePercent: 80 }, workRules: [{ kind: "tag", value: "aril" }, { kind: "feature", value: "feat-1" }],
        reviewer: { provider: "codex", model: null, differentFromBuilder: true }, followUps: true, pairedDevices: true, settledAt: iso(LARGE_NOW.getTime() - 200 * hour),
      },
      // Free text of the owner's lines, as Aril keeps it: a dozen lines.
      memory: {
        text: Array.from({ length: 12 }, (_, index) => `- ${["Run focused tests before the full suite.", "A new task action passes through the store, the route, the preload allow-list, and the client parser.", "Plan-only pull requests merge at once; no CI wait."][index % 3]} (${index + 1})`).join("\n"),
        previous: null, updatedAt: LARGE_NOW.getTime() - (300 - 11) * hour, updatedBy: "owner",
      },
      grant: { active: true, endsAt: LARGE_NOW.getTime() + 3 * hour, startsUsed: 3, limits: { hours: 8, tasks: 20, tasksAtATime: 2, sendBacks: 2, usagePercent: 80 }, actions: { start: true, review: true, sendBack: true, merge: true, writeTasks: false, markDone: true } },
    },
  };
}

export const LARGE_RUNS = [
  { source: "Claude Code", model: "claude-opus-5-5" }, { source: "Claude Code", model: "claude-sonnet-5-5" }, { source: "Claude Code", model: "claude-haiku-5-5" }, { source: "Codex", model: "gpt-6-sol" },
];

/** The rest of an owner-message prompt on such a board: a full history, a task log, and a short owner message. */
export function largePromptOptions() {
  const messages = Array.from({ length: 40 }, (_, index) => (index % 2 === 0
    ? { id: `m-${index + 1}`, role: "user", text: "Which of the Ready tasks should start first, and which model should each one use? ".repeat(2) }
    : { id: `m-${index + 1}`, role: "agent", status: "complete", text: "T-105 first: it unblocks T-106, and its record on this board is clean. Use the Sonnet model on high effort because the work is a located interface fix. ".repeat(7) }));
  const taskLog = { omitted: false, entries: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, task: `T-${77 + (index % 10)}`, kind: ["started", "review", "merged", "done"][index % 4], at: LARGE_NOW.getTime() - (40 - index) * 600_000, pullRequest: index % 4 === 2 ? 300 + index : null })) };
  return {
    board: largeBoard(), repositoryName: "pomegr", runs: LARGE_RUNS, lastCompletedAt: LARGE_LAST_COMPLETED_AT, taskLog, messages, message: "What should run next?", now: LARGE_NOW,
    repositoryGithub: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: true, defaultBranch: "main" },
    workflowChanges: [{ path: "AGENTS.md", changedAt: iso(LARGE_NOW.getTime() - 2 * 3_600_000), uncommitted: false }],
  };
}
