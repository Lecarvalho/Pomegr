// The preparation of one Aril turn: the reads and the small pieces of work a turn needs before its provider process starts. They
// begin together, a read that needs the repository root or the board beginning when that arrives, instead of one after another.
// Each step times itself in milliseconds, so the [timing](../../docs/internal/architecture/agent-chat.md#timing) of an answer says
// where the time before the process went. A step answers the same facts as before; only the order they start in changed.

import path from "node:path";

import { RUN_MODEL_AGENTS_QUERY } from "../../shared/task-run-models.mjs";
import { threadSince } from "./agent-chat-compaction.mjs";
import { prepareInstructionsFile } from "./agent-chat-provider-files.mjs";
import { chatTaskLog } from "./agent-chat-task-log.mjs";
import { lastAnswer } from "./agent-chat-thread.mjs";
import { readWorkflowChanges } from "./agent-chat-workflow.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const NO_WORKTREES = Object.freeze({ rows: Object.freeze([]), readAt: null });

/**
 * A clock for one turn's preparation, started now. `step(name, work, needs)` begins `work` at once, or when the readers in `needs` have
 * answered (their values are its arguments), and answers a reader of its outcome. A failure waits inside the reader, so a step that
 * nobody reads, because the message was refused first, cannot fail unseen. `time(name, work)` adds the time of work that runs in
 * sequence to one step. `measure()` answers the milliseconds of each step that ran, and `total` since the start.
 */
export function createPreparation(clock = () => performance.now(), begun = clock()) {
  const spent = new Map();
  const timed = async (name, work) => {
    const from = clock();
    try { return await work(); } finally { spent.set(name, (spent.get(name) ?? 0) + Math.max(0, clock() - from)); }
  };
  const step = (name, work, needs = []) => {
    const settled = (async () => {
      try {
        const inputs = needs.length > 0 ? await Promise.all(needs.map((need) => need())) : [];
        return { value: await timed(name, () => work(...inputs)) };
      } catch (error) { return { error }; }
    })();
    return () => settled.then((outcome) => ("error" in outcome ? Promise.reject(outcome.error) : outcome.value));
  };
  const measure = () => ({ ...Object.fromEntries([...spent].map(([name, ms]) => [name, Math.round(ms)])), total: Math.round(Math.max(0, clock() - begun)) });
  return Object.freeze({ step, time: timed, measure });
}

/**
 * The reads of a turn. `monitor(pathname, init)` and `postAction(route, repositoryId, payload)` are the chat's requests to the
 * monitor, `worktreeInventory` the cached facts of the task worktrees (`agent-chat-worktrees.mjs`: the preparation keeps nothing, and
 * a turn never waits on a folder walk), `context(repositoryId, thread)` the facts from the stored thread, and `environment()` the
 * environment of the run. Every read answers null or an empty value when it cannot be read, so a turn goes on without it.
 */
export function createTurnPreparation({ monitor, postAction, worktreeInventory, execFile, repositoryGithub = null, dataRoot, environment, store, summaries, clock }) {
  async function readBoard(repositoryId) {
    try {
      const board = await monitor(`/api/tasks?${new URLSearchParams({ repositoryId })}`, { method: "GET" });
      return isPlainObject(board) && board.readiness === "ready" && board.repositoryId === repositoryId ? board : null;
    } catch { return null; }
  }

  async function readTaskLog(repositoryId) {
    try { return chatTaskLog(await postAction("log-read", repositoryId, { limit: 100 })); } catch { return null; }
  }

  // The Pomegr task worktrees still on disk, as facts only (never a path), and when their Git facts were read. A turn goes on without
  // them when they cannot be read.
  async function readWorktrees(repositoryId, root, board) {
    try {
      const { rows, readAt } = await worktreeInventory.read({ repositoryRoot: root, repositoryId, tasks: board.tasks, columns: board.columns });
      return { rows: Array.isArray(rows) ? rows : [], readAt };
    } catch { return NO_WORKTREES; }
  }

  // The observed runs the task form's Claude model list reads, cut to the source and the model of each. A committed GET;
  // no answer leaves the Claude list to the board's own tasks.
  async function readRuns() {
    try {
      const agents = await monitor(`/api/agents?${new URLSearchParams({ ...RUN_MODEL_AGENTS_QUERY, days: String(RUN_MODEL_AGENTS_QUERY.days) })}`, { method: "GET" });
      return (Array.isArray(agents?.runs) ? agents.runs : []).filter(isPlainObject).map((run) => ({ source: run.source, model: run.model }));
    } catch { return []; }
  }

  async function repositoryRoot(repositoryId) {
    try {
      const answer = await postAction("worktree-root", repositoryId, {});
      const root = isPlainObject(answer) && answer.ok === true ? answer.root : null;
      return typeof root === "string" && path.isAbsolute(root) && !/[\u0000\r\n"]/u.test(root) ? root : null;
    } catch { return null; }
  }

  // The repository's own GitHub merge settings, so Aril proposes merge settings that fit them: null when they cannot be read.
  async function readGithub(repositoryId, root) {
    try { return root ? await repositoryGithub.read(repositoryId, root) : null; } catch { return null; }
  }

  // The time of the repository's last completed answer, and with `thread` the summary and the newest messages the prompt's history holds.
  async function readContext(repositoryId, thread) {
    const [metas, history] = await Promise.all([store.index(repositoryId), thread ? threadSince({ store, summaries, repositoryId, toWindow: true }) : null]);
    return { lastCompletedAt: lastAnswer(metas), ...(history ? { summary: history.summary?.text ?? null, messages: history.messages } : {}) };
  }

  /**
   * The preparation of one turn of a repository. `startMonitor` begins the monitor's reads together; `startRepository` begins the
   * rest. Both only start work: `values(...names)` waits for the named reads and answers them by name. A read the turn did not ask
   * for, or has no use for, answers undefined.
   */
  function begin(repositoryId, begun) {
    const prep = createPreparation(clock, begun);
    const { step } = prep;
    const reads = {};
    return Object.freeze({
      time: prep.time,
      step,
      measure: prep.measure,
      startMonitor({ taskLog = false } = {}) {
        reads.board = step("board", () => readBoard(repositoryId));
        reads.root = step("root", () => repositoryRoot(repositoryId));
        reads.runs = step("runs", readRuns);
        if (taskLog) reads.taskLog = step("taskLog", () => readTaskLog(repositoryId));
      },
      startRepository({ provider, github = false, worktrees: inventory = false, thread = false }) {
        if (github && repositoryGithub) reads.github = step("github", (root) => readGithub(repositoryId, root), [reads.root]);
        reads.workflow = step("workflow", (root, board) => (root && board ? readWorkflowChanges(root, board.aril, { execFile }) : undefined), [reads.root, reads.board]);
        if (inventory) reads.inventory = step("worktrees", (root, board) => (root && board ? readWorktrees(repositoryId, root, board) : NO_WORKTREES), [reads.root, reads.board]);
        if (provider === "claude") reads.instructions = step("instructions", () => prepareInstructionsFile(dataRoot));
        reads.context = step("context", () => readContext(repositoryId, thread));
        reads.environment = step("environment", environment);
      },
      async values(...names) {
        const found = await Promise.all(names.map((name) => reads[name]?.()));
        return Object.fromEntries(names.map((name, index) => [name, found[index]]));
      },
    });
  }

  return Object.freeze({ begin, readBoard, repositoryRoot });
}
