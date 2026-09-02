import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";

async function waitFor(predicate, message = "observer state did not settle") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-registry-observation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const localId = "registry-observation-session";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const registryFile = path.join(registryRoot, `${localId}.json`);
  await mkdir(path.dirname(mainFile), { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  await writeFile(mainFile, `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-01T00:00:00.000Z",
    message: { content: [] },
  })}\n`, "utf8");
  const old = new Date("2026-08-01T00:00:00.000Z");
  await utimes(mainFile, old, old);
  const writeRegistry = async (status) => writeFile(registryFile, JSON.stringify({
    sessionId: localId,
    status,
    pid: 42,
    procStart: "owner-start",
  }), "utf8");
  return { root, projectsRoot, registryRoot, localId, registryFile, writeRegistry };
}

function watchedProvider(values, watchers, options = {}) {
  return createClaudeProvider({
    homeDir: values.root,
    projectsRoot: values.projectsRoot,
    registryRoot: values.registryRoot,
    observerIntervalMs: options.intervalMs ?? 60_000,
    registryProcessIdentities: () => new Map([[42, "owner-start"]]),
    observerWatchSource(target, watchOptions, callback) {
      const listener = typeof watchOptions === "function" ? watchOptions : callback;
      if (options.unsupportedRegistryWatch && path.resolve(target) === path.resolve(values.registryRoot)) {
        throw new Error("unsupported test watcher");
      }
      watchers.set(path.resolve(target), listener);
      return { close() {} };
    },
    usageRequest: async () => { throw new Error("not requested"); },
  });
}

test("Claude registry events publish close/open transitions and refresh departed detail without transcript changes", async (context) => {
  const values = await fixture(context);
  await values.writeRegistry("idle");
  const watchers = new Map();
  const provider = watchedProvider(values, watchers);
  assert.deepEqual(provider.watchTargets.map((target) => path.resolve(target)).sort(), [
    path.resolve(values.projectsRoot),
    path.resolve(values.registryRoot),
  ].sort());

  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const catalogs = [];
  const details = [];
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_sessionId, candidate) { details.push(candidate); },
    invalidateSession() {},
  }, controller.signal);
  await waitFor(() => catalogs.length > 0);
  await observer.hydrate(values.localId);
  await waitFor(() => details.length > 0);
  assert.deepEqual(catalogs.at(-1).map(({ localId, isLive, activityStatus }) => ({ localId, isLive, activityStatus })), [{
    localId: values.localId,
    isLive: true,
    activityStatus: "open",
  }]);

  await unlink(values.registryFile);
  watchers.get(path.resolve(values.registryRoot))("rename", path.basename(values.registryFile));
  await waitFor(() => catalogs.some((entries) => entries[0]?.isLive === false)
    && details.at(-1)?.historical === true, "registry departure must settle without the 60-second safety poll");
  assert.deepEqual(catalogs.at(-1).map(({ localId, isLive, activityStatus }) => ({ localId, isLive, activityStatus })), [{
    localId: values.localId,
    isLive: false,
    activityStatus: "idle",
  }]);

  await values.writeRegistry("active");
  watchers.get(path.resolve(values.registryRoot))("rename", path.basename(values.registryFile));
  await waitFor(() => catalogs.at(-1)?.[0]?.isLive === true && catalogs.at(-1)?.[0]?.activityStatus === "working"
    && details.at(-1)?.historical === false);

  await values.writeRegistry("idle");
  watchers.get(path.resolve(values.registryRoot))("change", path.basename(values.registryFile));
  await waitFor(() => catalogs.at(-1)?.[0]?.activityStatus === "open" && details.at(-1)?.agents?.[0]?.status === "idle");
});

test("Claude registry observation falls back to safety reconciliation when its watcher is unsupported", async (context) => {
  const values = await fixture(context);
  await values.writeRegistry("idle");
  const watchers = new Map();
  const provider = watchedProvider(values, watchers, { intervalMs: 100, unsupportedRegistryWatch: true });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const catalogs = [];
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession() {}, invalidateSession() {},
  }, controller.signal);
  await waitFor(() => catalogs.at(-1)?.[0]?.isLive === true);
  await unlink(values.registryFile);
  await waitFor(() => catalogs.at(-1)?.[0]?.isLive === false,
    "the polling safety net must retire a registry-backed session when watching is unavailable");
  assert.equal(watchers.has(path.resolve(values.projectsRoot)), true);
  assert.equal(watchers.has(path.resolve(values.registryRoot)), false);
});
