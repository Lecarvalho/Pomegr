// Card moves: one card, or a parallel group's cards that have not started, between and inside the columns, and the
// "Queue group" that takes a planned group into the queue in the order it holds.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { readColumnRoles, readyColumnId, taskNumbersInOrder, writeTaskOrder } from "./task-columns.mjs";
import { groupCardsNotStarted, pruneTaskGroups, readTaskGroups, writeTaskGroup } from "./task-groups.mjs";
import { normalizeMovePayload } from "./task-record.mjs";
import { markTaskDone } from "./task-report.mjs";

const columnExists = (database, repositoryId, id) =>
  preparedStatement(database, "SELECT 1 FROM columns WHERE repository_id = ? AND id = ?").get(repositoryId, id) !== undefined;

// A move to Done also accepts the task. Other moves change only its column, position, and update time.
// A grouped card that has not started moves with its group
// ("block"), or leaves it ("leave", and any move that lands it away from every other card of its group in that column).
export function moveTask({ database, repositoryId, now, resolveOutcomeFacts = null }, payload) {
  const input = normalizeMovePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT column_id, state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task || !columnExists(database, repositoryId, input.columnId)) return { ok: false, error: "not_found" };
  const readyId = readyColumnId(database, repositoryId) ?? input.columnId;
  const waits = (task.state === "queued" || task.state === "scheduled") && (task.session_id ?? null) === null;
  if (waits && input.columnId !== readyId) return { ok: false, error: "conflict" };
  pruneTaskGroups(database, repositoryId);
  const at = now();
  const group = readTaskGroups(database, repositoryId).get(input.number);
  const members = group === undefined ? [] : groupCardsNotStarted(database, repositoryId, group, at);
  const grouped = members.includes(input.number);
  // The cards that move: the one card, or the cards of its group that have not started, in the order they have.
  const block = input.group === "block" && grouped ? members : [input.number];
  const queuedIn = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ? AND state IN ('queued', 'scheduled') AND session_id IS NULL");
  if (input.columnId !== readyId && block.some((number) => queuedIn.get(repositoryId, number) !== undefined)) return { ok: false, error: "conflict" };
  const moving = new Set(block);
  const sources = new Set(block.map((number) => preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number).column_id));
  const before = taskNumbersInOrder(database, repositoryId, input.columnId);
  const order = before.filter((number) => !moving.has(number));
  order.splice(Math.min(input.position, order.length), 0, ...block);
  const arrive = preparedStatement(database, "UPDATE tasks SET column_id = ?, updated_at = ? WHERE repository_id = ? AND number = ?");
  if (task.column_id !== input.columnId || before.join() !== order.join()) arrive.run(input.columnId, Date.now(), repositoryId, input.number);
  for (const number of block) if (number !== input.number && !before.includes(number)) arrive.run(input.columnId, Date.now(), repositoryId, number);
  writeTaskOrder(database, repositoryId, order);
  for (const columnId of sources) if (columnId !== input.columnId) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  if (grouped && input.group !== "block") {
    const siblings = new Set(members.filter((number) => number !== input.number));
    // Only the cards that have not started count as neighbours: a card that started, between two cards of the group,
    // does not part them.
    const open = new Set(preparedStatement(database, "SELECT number FROM tasks WHERE repository_id = ? AND state IN ('not_queued', 'queued', 'scheduled') AND session_id IS NULL")
      .all(repositoryId).map((row) => Number(row.number)));
    const cards = order.filter((number) => open.has(number));
    const index = cards.indexOf(input.number);
    const beside = [cards[index - 1], cards[index + 1]].some((number) => number !== undefined && siblings.has(number));
    if (input.group === "leave" || !beside) writeTaskGroup(database, repositoryId, input.number, null);
  }
  // Accept after placing the cards, so Mark done's effects keep the owner's chosen order.
  // Reordering an already Done card is only a move; an old unfinished card in Done can be accepted in place.
  if (readColumnRoles(database, repositoryId).get(input.columnId) === "done") {
    const state = preparedStatement(database, "SELECT state FROM tasks WHERE repository_id = ? AND number = ?");
    for (const number of block) {
      if (state.get(repositoryId, number).state !== "done") markTaskDone({ database, repositoryId, now, resolveOutcomeFacts }, number);
    }
  }
  return { ok: true };
}

// "Queue group": every card of the task's group that has not started is queued, and the cards take the end of Ready
// in the order they had, so the plan made in Backlog is the start order. `queue` is the statement that queues one task.
export function queueGroupCards({ database, repositoryId, now }, taskNumber, queue) {
  pruneTaskGroups(database, repositoryId);
  const group = readTaskGroups(database, repositoryId).get(taskNumber);
  const cards = group === undefined ? [] : groupCardsNotStarted(database, repositoryId, group, now());
  const readyId = readyColumnId(database, repositoryId);
  if (!cards.includes(taskNumber) || readyId === null) return { ok: false, error: "conflict" };
  const state = preparedStatement(database, "SELECT state, column_id FROM tasks WHERE repository_id = ? AND number = ?");
  const left = new Set();
  for (const number of cards) {
    const row = state.get(repositoryId, number);
    if (row.state === "not_queued") queue.run("queued", null, Date.now(), repositoryId, number);
    if (row.column_id !== readyId) left.add(row.column_id);
  }
  const moving = new Set(cards);
  preparedStatement(database, `UPDATE tasks SET column_id = ? WHERE repository_id = ? AND number IN (${cards.map(() => "?").join(", ")})`).run(readyId, repositoryId, ...cards);
  const order = taskNumbersInOrder(database, repositoryId, readyId).filter((number) => !moving.has(number));
  writeTaskOrder(database, repositoryId, [...order, ...cards]);
  for (const columnId of left) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  return { ok: true };
}
