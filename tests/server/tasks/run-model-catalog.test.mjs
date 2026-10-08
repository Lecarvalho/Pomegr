import assert from "node:assert/strict";
import test from "node:test";
import { createRunModelCatalog } from "../../../server/runtime/run-model-catalog.mjs";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";

const ready = (models) => ({ provider: "codex", status: "ready", complete: true, models, knownIds: [] });

test("the run-model catalog keeps the last committed Codex rows with labels and drops an unavailable one", () => {
  const catalog = createRunModelCatalog();
  assert.deepEqual(catalog.codex(), []);
  catalog.accept([{ provider: "claude", status: "ready", complete: true, models: [{ id: "claude-x", label: "X" }] }]);
  assert.deepEqual(catalog.codex(), []);
  catalog.accept([ready([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }])]);
  assert.deepEqual(catalog.codex(), [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }]);
  catalog.accept([{ provider: "codex", announcements: [] }]);
  assert.equal(catalog.codex().length, 1);
  catalog.accept([{ provider: "codex", status: "unavailable", complete: false, models: [] }]);
  assert.deepEqual(catalog.codex(), []);
});

test("createTaskLookups serves the catalog through resolveRunModels, empty when none is wired", () => {
  const base = { observationStore: {}, catalogSessions: () => [], repositoryInventory: {} };
  assert.deepEqual(createTaskLookups(base).resolveRunModels(), []);
  const catalog = createRunModelCatalog();
  catalog.accept([ready([{ id: "gpt-6.1-sol", label: "Sol" }])]);
  assert.deepEqual(createTaskLookups({ ...base, runModels: catalog }).resolveRunModels(), [{ id: "gpt-6.1-sol", label: "Sol" }]);
});
