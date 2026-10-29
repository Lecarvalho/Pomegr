// The facts of the Pomegr task worktrees that an Aril turn reads, kept in desktop main between turns so that a turn never waits on Git or on a
// folder walk. See [Task worktree facts](../../docs/internal/architecture/agent-chat.md#task-worktree-facts). The cache holds the facts of
// `task-worktree.mjs` (clean, unique commits, size) and nothing else: never a path, a file name, or Git output. The board's own facts
// (state, column) are joined on every read, because they change faster than the cache. A removal never reads this cache: `remove`
// reads the live tree and the live commits itself.

const STALE_MS = 3 * 60_000;
// A refresh that has run this long is given up on, so a folder walk that hangs cannot stop every later refresh.
const RUN_LIMIT_MS = 60_000;
// When desktop main reads the facts of every repository with a board: a little after start so it does not compete with it, and again for
// the repositories the monitor had not located yet.
const PREFETCH_DELAYS_MS = Object.freeze([10_000, 60_000]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

// A row for the prompt: the cached facts and the task's current state and column from the board.
function describe(rows, tasks, columns) {
  const board = new Map(tasks.map((task) => [task?.id, task]));
  const names = new Map(columns.map((column) => [column?.id, column?.name]));
  return rows.map((row) => {
    const task = board.get(row.taskId);
    return { taskId: row.taskId, state: task?.state ?? "not on board", column: task ? names.get(task.columnId) ?? null : "not on board", clean: row.clean, uniqueCommits: row.uniqueCommits, sizeMB: row.sizeMB, atLeast: row.atLeast };
  });
}

/**
 * `worktrees.inventory({ repositoryRoot, repositoryId })` answers the Git facts of each worktree, and `worktrees.sizes(...)`, when it has
 * it, their sizes. `read(...)` never waits: it answers the cached rows at once, or `{ rows: null, readAt: null }` for a repository with no
 * cache yet, whose first read it has just started in the background. A cache older than `staleMs`, or one a change made out of date, is
 * read again in the background, one repository at a time. A row keeps its last known size until the new walk ends, and a size nobody
 * measured is `null`. A refresh given up on may still answer later; its answer is dropped.
 */
export function createWorktreeInventory({ worktrees, now = Date.now, staleMs = STALE_MS } = {}) {
  const repositories = new Map();
  const stateOf = (repositoryId) => {
    if (!repositories.has(repositoryId)) repositories.set(repositoryId, { entry: null, version: 0, running: null });
    return repositories.get(repositoryId);
  };

  // Starts the one refresh of the repository, or answers the one that runs. `facts` ends when the Git facts are stored; `done` ends after the walks.
  function refresh(repositoryId, repositoryRoot) {
    const state = stateOf(repositoryId);
    if (state.running && now() - state.running.startedAt < RUN_LIMIT_MS) return state.running;
    const version = state.version;
    const running = { startedAt: now() };
    const live = () => state.running === running;
    running.facts = (async () => {
      const found = await worktrees.inventory({ repositoryRoot, repositoryId });
      if (!live()) return;
      const known = new Map((state.entry?.rows ?? []).map((row) => [row.taskId, row]));
      const rows = (Array.isArray(found) ? found : []).map(({ taskId, clean, uniqueCommits }) => ({ taskId, clean, uniqueCommits, sizeMB: known.get(taskId)?.sizeMB ?? null, atLeast: known.get(taskId)?.atLeast ?? false }));
      state.entry = { readAt: now(), version, rows };
    })();
    running.done = running.facts.then(async () => {
      if (!live()) return;
      const measured = await worktrees.sizes?.({ repositoryRoot, repositoryId });
      if (!live() || !Array.isArray(measured) || !state.entry) return;
      const sizes = new Map(measured.map((size) => [size?.taskId, size]));
      state.entry = { ...state.entry, rows: state.entry.rows.map((row) => (sizes.has(row.taskId) ? { ...row, sizeMB: sizes.get(row.taskId).sizeMB, atLeast: sizes.get(row.taskId).atLeast } : row)) };
    }).catch(() => { /* A refresh that failed leaves the last facts, and the next read tries again. */ }).finally(() => { if (live()) state.running = null; });
    state.running = running;
    return running;
  }

  // Begins a refresh when the repository has no cache, an old one, or one a change made out of date; answers it, or null.
  function ensure(repositoryId, repositoryRoot) {
    const { entry, version } = stateOf(repositoryId);
    return !entry || now() - entry.readAt > staleMs || entry.version !== version ? refresh(repositoryId, repositoryRoot) : null;
  }

  /**
   * `{ rows, readAt }`: the rows `{ taskId, state, column, clean, uniqueCommits, sizeMB, atLeast }` and when their Git facts were read, in
   * milliseconds. Both are null while the repository has no cache: nothing is known yet, which is not the same as no worktrees.
   */
  function read({ repositoryRoot, repositoryId, tasks = [], columns = [] } = {}) {
    ensure(repositoryId, repositoryRoot);
    const { entry } = stateOf(repositoryId);
    return entry ? { rows: describe(entry.rows, tasks, columns), readAt: entry.readAt } : { rows: null, readAt: null };
  }

  /** Reads the repository's facts in the background when it has none or they are old. Answers when the Git facts are stored, never rejects. */
  async function warm({ repositoryRoot, repositoryId } = {}) {
    try { await ensure(repositoryId, repositoryRoot)?.facts; } catch { /* The next read tries again. */ }
  }

  /**
   * A worktree was made, was removed, or was tried for removal: what the cache holds is out of date. A removed task's row leaves at once, and
   * the next read starts a new refresh, which a refresh already running does not satisfy because it began earlier.
   */
  function changed(repositoryId, removedTaskId = null) {
    const state = repositories.get(repositoryId);
    if (!state) return;
    state.version += 1;
    if (removedTaskId && state.entry) state.entry = { ...state.entry, rows: state.entry.rows.filter((row) => row.taskId !== removedTaskId) };
  }

  // The worktrees' own changes, such as a task start making one or a Done task's removal, reach the cache too.
  const unsubscribe = typeof worktrees?.onChange === "function" ? worktrees.onChange(changed) : () => {};

  return Object.freeze({ read, warm, changed, close: unsubscribe });
}

/**
 * Reads the worktree facts of every repository that has a Pomegr board, a little after desktop main starts, so the first message finds them.
 * `readHome()` answers the Tasks home of the monitor (`{ boards: [{ repositoryId }] }`) and `rootOf(repositoryId)` the repository root or
 * null. One repository at a time, so many boards do not start many Git processes together. A repository whose root is not known yet is
 * tried again at the next delay; one the prefetch never reaches is read by its first turn, which waits for nothing either. The timers
 * do not keep the process alive. `cancel()` stops the ones still waiting.
 */
export function prefetchWorktreeFacts({ inventory, readHome, rootOf, delaysMs = PREFETCH_DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const warmed = new Set();
  const timers = new Set();
  let closed = false;
  async function pass() {
    let boards = [];
    try { const home = await readHome(); boards = Array.isArray(home?.boards) ? home.boards : []; } catch { return; }
    for (const board of boards) {
      const repositoryId = board?.repositoryId;
      if (closed) return;
      if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || warmed.has(repositoryId)) continue;
      let repositoryRoot = null;
      try { repositoryRoot = await rootOf(repositoryId); } catch { /* Tried again at the next delay. */ }
      if (!repositoryRoot || closed) continue;
      warmed.add(repositoryId);
      await inventory.warm({ repositoryRoot, repositoryId });
    }
  }
  for (const delay of delaysMs) {
    const timer = setTimer(() => { timers.delete(timer); void pass(); }, delay);
    timer?.unref?.();
    timers.add(timer);
  }
  return Object.freeze({ cancel() { closed = true; for (const timer of timers) clearTimer(timer); timers.clear(); } });
}
