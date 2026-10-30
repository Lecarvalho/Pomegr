// The two approved actions of the chat that are not task actions: the start of a session and the removal of a task worktree. Each runs only
// after the owner applied a proposal in the desktop window, and goes through the desktop's own path (the manual start, the unforced removal).

import { START_FAILURES, WORKTREE_RESULTS } from "./agent-chat-proposal.mjs";

/**
 * An approved start goes to the manual start of the Tasks page and to nothing else: the same start plan, gates, and launch slot and native
 * confirmation. Only a confirmed launch answers the proposal; a start that was held or failed keeps it pending with the fixed status, so the
 * owner may apply it again. Null when the start was cancelled (the app is closing), which stores nothing.
 */
export function createSessionStart(startTask) {
  return async function startSession(event, repositoryId, taskId, proposal) {
    let status;
    try { status = (await startTask(event, repositoryId, taskId))?.status; } catch { status = "failed"; }
    if (status === "cancelled") return null;
    if (status === "started") return { ...proposal, state: "applied", results: [{ ok: true, start: "started" }] };
    return { ...proposal, state: "pending", results: [{ ok: false, error: "not_started", start: START_FAILURES.includes(status) ? status : "unavailable" }] };
  };
}

/**
 * The removal of one task's worktree, answered with one fixed word. `monitor` and `readBoard` read the board and the task; `repositoryRoot`
 * finds the folder; `worktrees` locates and removes; `worktreeInventory` forgets what was removed or found out of date.
 */
export function createWorktreeRemoval({ readBoard, monitor, repositoryRoot, worktrees, worktreeInventory }) {
  return async function removeWorktree(repositoryId, operation) {
    try {
      const board = await readBoard(repositoryId);
      if (!board) return "failed";
      const task = board.tasks.find(({ id }) => id === operation.id);
      if (task?.review?.state === "running") return "in_use";
      // A task with no outcome yet may have a session or a live dispatch.
      if (task && !["needs_review", "stalled", "blocked", "done"].includes(task.state)) {
        if (task.session) return "in_use";
        // The board omits dispatch tokens. Its existing private task read also checks an unbound live dispatch.
        const read = await monitor(`/internal/agent-chat/task?${new URLSearchParams({ repositoryId, taskId: task.id })}`, { method: "GET" });
        if (read?.ok !== true || typeof read.task?.editable !== "boolean") return "failed";
        if (!read.task.editable) return "in_use";
      }
      const root = await repositoryRoot(repositoryId);
      if (!root) return "failed";
      const request = { repositoryRoot: root, repositoryId, taskId: operation.id };
      // The removal reads the live tree and the live commits itself (`remove` in task-worktree.mjs); the turns' cached facts are never asked.
      if (!await worktrees.locate(request)) { worktreeInventory.changed(repositoryId, operation.id); return "not_found"; }
      const result = await worktrees.remove({ ...request, deleteBranch: operation.branch, detailed: true });
      // A removed worktree leaves the cached rows at once; any other answer means the cached facts were out of date.
      worktreeInventory.changed(repositoryId, result === "removed" ? operation.id : null);
      return WORKTREE_RESULTS.includes(result) ? result : "failed";
    } catch { return "failed"; }
  };
}
