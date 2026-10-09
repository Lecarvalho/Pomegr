import assert from "node:assert/strict";
import test from "node:test";
import { createTaskLookups, MINIMUM_TASK_PLUGIN_VERSION } from "../../../server/runtime/task-start-lookup.mjs";

const REPOSITORY = "repo-0123456789abcdef01234567";
const ROOT = "C:/Work/repo";
const installed = (overrides = {}) => ({ readiness: "ready", installation: "installed", version: MINIMUM_TASK_PLUGIN_VERSION, enabled: true, ...overrides });

function resolveStart(setups, provider) {
  const asked = [];
  const lookups = createTaskLookups({
    observationStore: { get: () => null }, catalogSessions: () => [],
    repositoryInventory: {
      repositoryRoot: (id) => (id === REPOSITORY ? ROOT : null),
      readPluginSetup: (id, providerId) => { asked.push(providerId); return id === REPOSITORY ? setups[providerId] ?? null : null; },
    },
  });
  return { ...lookups.resolveTaskStart(REPOSITORY, provider), asked };
}
const ready = (setup, provider = "claude") => resolveStart({ [provider]: setup }, provider).pluginReady;

test("the first task-capable plugin version is 0.9.0", () => {
  assert.equal(MINIMUM_TASK_PLUGIN_VERSION, "0.9.0");
});

test("a plugin older than the minimum is not proof, the minimum and anything newer are", () => {
  for (const version of ["0.8.3", "0.8.99", "0.0.1", "0.9.0-rc.1"]) assert.equal(ready(installed({ version })), false, version);
  for (const version of ["0.9.0", "0.9.1", "0.10.0", "1.0.0", "1.0.0-beta.1"]) assert.equal(ready(installed({ version })), true, version);
});

test("an unknown or unreadable version holds the start like a missing plugin", () => {
  for (const version of [null, undefined, "", "0.9", "latest", "v0.9.0", 9, "0.9.0 "]) assert.equal(ready(installed({ version })), false, String(version));
  const withoutVersion = installed();
  delete withoutVersion.version;
  assert.equal(ready(withoutVersion), false);
});

test("a task-capable version does not replace the installed, ready, and enabled proof", () => {
  assert.equal(ready(null), false);
  assert.equal(ready(installed({ readiness: "loading" })), false);
  assert.equal(ready(installed({ readiness: "unavailable" })), false);
  assert.equal(ready(installed({ installation: "not_installed" })), false);
  assert.equal(ready(installed({ installation: "unknown" })), false);
  assert.equal(ready(installed({ enabled: false })), false);
  assert.equal(ready(installed({ enabled: null })), true);
});

test("the version is judged for the provider being started, with one minimum for both plugins", () => {
  const setups = { claude: installed({ version: "0.9.0" }), codex: installed({ version: "0.8.3" }) };
  assert.deepEqual(resolveStart(setups, "claude"), { root: ROOT, pluginReady: true, asked: ["claude"] });
  assert.deepEqual(resolveStart(setups, "codex"), { root: ROOT, pluginReady: false, asked: ["codex"] });
  assert.deepEqual(resolveStart({ claude: setups.codex, codex: setups.claude }, "codex"), { root: ROOT, pluginReady: true, asked: ["codex"] });
  assert.equal(resolveStart(setups).pluginReady, true);
});
