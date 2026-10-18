// The tasks an agent reads through get_task and list_tasks (task T-118), built from a projected board. The route
// (server/serving/task-agent-read-routes.mjs) bounds each one again on the way out.

import { plainTaskText, rowStarted } from "./task-record.mjs";

// Each task of a projected board, in board order (column, then card). `rows` are the stored rows it was projected
// from: whether `update_task` can change a task is the rule of the desktop `update` action, which reads a live dispatch.
export function agentTaskEntries(board, rows, at, { includeChatReport = false } = {}) {
  const columnNames = new Map(board.columns.map((column) => [column.id, column.name]));
  const featureNames = new Map(board.features.map((feature) => [feature.id, feature.name]));
  const stored = new Map(rows.tasks.map((row) => [Number(row.number), row]));
  return board.tasks.map((task) => {
    const row = stored.get(Number(task.id.slice(2)));
    return {
      id: task.id,
      ...(includeChatReport ? { report: { block_reason: task.report?.blockReason ?? null, attention: task.report?.attention ?? null } } : {}),
      text: plainTaskText(task.text),
      ownCondition: task.completeWhen?.own ?? null,
      completeWhen: [...(task.completeWhen?.checks ?? [])],
      provider: task.run?.provider ?? null,
      model: task.run?.model ?? null,
      effort: task.run?.effort ?? null,
      feature: task.featureId === null ? null : featureNames.get(task.featureId) ?? null,
      column: columnNames.get(task.columnId) ?? null,
      state: task.state,
      // The tasks of the board it runs after (task T-111), so an agent holds the whole list before update_task replaces it.
      runsAfter: [...(task.after ?? [])],
      editable: row !== undefined && !rowStarted(row, at),
    };
  });
}
