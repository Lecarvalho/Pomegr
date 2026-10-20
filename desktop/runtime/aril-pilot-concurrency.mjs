const FINISHED_TASK = new Set(["done", "needs_review", "blocked", "stalled"]);
const FINISHED_SESSION = new Set(["completed", "complete", "ended", "failed", "stopped"]);

// Shared by the dispatch guard and the decision evidence. A still-open provider
// session does not occupy a slot once its task has reported an outcome.
export function pilotRunningTaskIds(board, grant = null) {
  const active = new Set(board.tasks.filter((task) => task.session && !FINISHED_TASK.has(task.state)
    && !FINISHED_SESSION.has(task.session.state)).map((task) => task.id));
  for (const row of grant?.receipts ?? []) if (row.action === "start" && ["pending", "started"].includes(row.status)) {
    const task = board.tasks.find((entry) => entry.id === row.taskId);
    if (task && !task.session && !FINISHED_TASK.has(task.state)) active.add(row.taskId);
  }
  return [...active].sort();
}
