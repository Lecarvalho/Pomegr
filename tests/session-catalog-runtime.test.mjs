import assert from "node:assert/strict";
import test from "node:test";
import { catalogSourceScopeKey } from "../monitor/session-catalog-runtime.mjs";

test("catalog source scope binds opaque provider source configuration", () => {
  const base = { providerFolders: { folders: { codexHome: "C:/private/codex" } } };
  const archived = catalogSourceScopeKey({ ...base, providers: [{ id: "codex", catalogSourceScope: "a".repeat(64) }] });
  const activeOnly = catalogSourceScopeKey({ ...base, providers: [{ id: "codex", catalogSourceScope: "b".repeat(64) }] });
  assert.match(archived, /^[a-f0-9]{64}$/u);
  assert.notEqual(archived, activeOnly);
  assert.doesNotMatch(archived, /private|codex/i);
});
