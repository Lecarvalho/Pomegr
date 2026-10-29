// The facts of the Pomegr task worktrees that an Aril turn reads, kept in desktop main between turns so that a turn never waits on Git or on a
// folder walk. See [Task worktrees](../../docs/internal/architecture/agent-chat.md#task-worktree-facts). The cache holds the facts of
// `task-worktree.mjs` (clean, unique commits, size) and nothing else: never a path, a file name, or Git output. The board's own facts
// (state, column) are joined on every read, because they change faster than the cache. A removal never reads this cache: `remove`
// reads the live tree and the live commits itself.

const STALE_MS = 3 * 60_000;
// A refresh that has run this long is given up on, so a folder walk that hangs cannot stop every later refresh.
const RUN_LIMIT_MS = 60_000;

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
 * it, their sizes. `read(...)` answers the cached rows at once. A repository with no cache reads the Git facts and waits for them, never
 * for a size. A cache older than `staleMs`, or one a change made out of date, is read again in the background, one repository at a time.
 * A row keeps its last known size until the new walk ends, and a size nobody measured is `null`. A refresh given up on may still answer
 * later; its answer is dropped.
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

  /**
   * `{ rows, readAt }`: the rows `{ taskId, state, column, clean, uniqueCommits, sizeMB, atLeast }` and when their Git facts were read, in
   * milliseconds. Rejects only when a repository with no cache could not read its Git facts.
   */
  async function read({ repositoryRoot, repositoryId, tasks = [], columns = [] } = {}) {
    const state = stateOf(repositoryId);
    if (!state.entry) await refresh(repositoryId, repositoryRoot).facts;
    else if (now() - state.entry.readAt > staleMs || state.entry.version !== state.version) refresh(repositoryId, repositoryRoot);
    // No entry only when the refresh was given up on while this read waited for it.
    return state.entry ? { rows: describe(state.entry.rows, tasks, columns), readAt: state.entry.readAt } : { rows: [], readAt: null };
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

  return Object.freeze({ read, changed, close: unsubscribe });
}
