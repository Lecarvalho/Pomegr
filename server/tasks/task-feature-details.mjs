// A feature's description and app version: the context a task's session reads with `get_feature`.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { FEATURE_ID, isRepositoryId, normalizeFeatureAppVersion, normalizeFeatureDescription, normalizeFeatureName, normalizeFeatureReference } from "./task-record.mjs";

const descriptionKey = (repositoryId, featureId) => `feature_description:${repositoryId}:${featureId}`;
const appVersionKey = (repositoryId, featureId) => `feature_app_version:${repositoryId}:${featureId}`;

const readValue = (database, key) => preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value;

function writeValue(database, key, value) {
  if (value === null) preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  else preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// A stored value that does not validate reads as not set, never as raw text.
export function readFeatureDetails(database, repositoryId, featureId) {
  if (!isRepositoryId(repositoryId) || typeof featureId !== "string" || !FEATURE_ID.test(featureId)) return { description: null, appVersion: null };
  return {
    description: normalizeFeatureDescription(readValue(database, descriptionKey(repositoryId, featureId))) ?? null,
    appVersion: normalizeFeatureAppVersion(readValue(database, appVersionKey(repositoryId, featureId))) ?? null,
  };
}

// An absent field is left as stored, and a null one is cleared.
export function writeFeatureDetails(database, repositoryId, featureId, { description, appVersion }) {
  if (description !== undefined) writeValue(database, descriptionKey(repositoryId, featureId), description);
  if (appVersion !== undefined) writeValue(database, appVersionKey(repositoryId, featureId), appVersion);
}

export function deleteFeatureDetails(database, repositoryId, featureId) {
  writeFeatureDetails(database, repositoryId, featureId, { description: null, appVersion: null });
}

// The stored feature a reference names, by ID or by exact title, or null.
export function findFeature(database, repositoryId, reference) {
  if (reference === null || typeof reference !== "object") return null;
  const row = typeof reference.id === "string"
    ? preparedStatement(database, "SELECT id, name FROM features WHERE repository_id = ? AND id = ?").get(repositoryId, reference.id)
    : preparedStatement(database, "SELECT id, name FROM features WHERE repository_id = ? AND name = ?").get(repositoryId, reference.name);
  return row ?? null;
}

// One feature as an agent reads it: `{ id, title, description, appVersion }`, or null.
export function readFeature({ database, repositoryId, feature }) {
  if (!isRepositoryId(repositoryId)) return null;
  const row = findFeature(database, repositoryId, normalizeFeatureReference(feature));
  const title = row ? normalizeFeatureName(row.name) : undefined;
  if (title === undefined || !FEATURE_ID.test(row.id)) return null;
  return { id: row.id, title, ...readFeatureDetails(database, repositoryId, row.id) };
}
