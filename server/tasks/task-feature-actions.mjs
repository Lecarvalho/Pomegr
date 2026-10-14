// The desktop's `feature_delete`: the one feature action that also writes task rows.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { deleteFeatureDetails, findFeature } from "./task-feature-details.mjs";
import { normalizeFeatureDeletePayload, rowStarted } from "./task-record.mjs";

// The feature goes and its tasks stay: each loses its feature and keeps every other field, its place in Ready and its
// parallel group included. A task that has started and is not done refuses the delete, because its session holds the
// feature's title.
export function deleteFeature({ database, repositoryId, now }, payload) {
  const input = normalizeFeatureDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const stored = findFeature(database, repositoryId, input.feature);
  if (!stored) return { ok: false, error: "not_found" };
  const at = now();
  const tasks = preparedStatement(database, "SELECT state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND feature_id = ?").all(repositoryId, stored.id);
  if (tasks.some((row) => row.state !== "done" && rowStarted(row, at))) return { ok: false, error: "conflict" };
  preparedStatement(database, "UPDATE tasks SET feature_id = NULL, step = NULL WHERE repository_id = ? AND feature_id = ?").run(repositoryId, stored.id);
  preparedStatement(database, "DELETE FROM features WHERE repository_id = ? AND id = ?").run(repositoryId, stored.id);
  deleteFeatureDetails(database, repositoryId, stored.id);
  return { ok: true };
}
