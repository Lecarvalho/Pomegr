import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function rollout(id, timestamp) {
  return `${JSON.stringify({
    type: "session_meta",
    timestamp,
    payload: {
      id,
      session_id: id,
      timestamp,
      cwd: "C:\\synthetic\\project",
      source: "cli",
    },
  })}\n${JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "task_started", turn_id: `${id}-turn` },
  })}\n`;
}

test("a known rollout replaced in place never publishes under its previous session ID", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-discovery-replacement-"));
  const sessionsRoot = path.join(root, "sessions");
  const rolloutFile = path.join(sessionsRoot, "rollout-reused-path.jsonl");
  const oldId = "old-replaced-root";
  const newId = "new-replacement-root";
  const initialAt = new Date().toISOString();
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(rolloutFile, rollout(oldId, initialAt), "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  let watcher = null;
  const publications = [];
  const catalogs = [];
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 60_000,
    observerIntervalMs: 60_000,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
    observerWatchSource(target, _options, callback) {
      if (path.resolve(target) === path.resolve(sessionsRoot)) watcher = callback;
      return { close() {} };
    },
  });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => { controller.abort(); observer.stop(); });
  await observer.start({
    publishCatalog(rows) { catalogs.push(rows); },
    publishSession(localId, candidate) { publications.push({ localId, candidate }); },
    invalidateSession() {},
  }, controller.signal);

  await waitFor(
    () => publications.some((item) => item.localId === oldId),
    "initial rollout was not hydrated",
  );
  assert.equal(typeof watcher, "function");

  const replacementAt = new Date(Date.now() + 1_000).toISOString();
  await writeFile(rolloutFile, rollout(newId, replacementAt), "utf8");
  const beforeReplacement = publications.length;
  watcher("change", path.basename(rolloutFile));

  await waitFor(
    () => publications.length > beforeReplacement,
    "the watcher did not reconcile the replaced rollout",
  );
  const afterReplacement = publications.slice(beforeReplacement);
  assert.equal(
    afterReplacement.some((item) => item.localId === oldId),
    false,
    "a replaced rollout must not be normalized under the stale reverse-index session ID",
  );
  assert.equal(afterReplacement.some((item) => item.localId === newId), true);
  assert.equal(catalogs.at(-1).some((row) => row.localId === newId), true);
});
