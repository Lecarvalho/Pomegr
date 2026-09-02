import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createClaudeRegistryObservation, observeClaudeRegistryDepartures } from "../monitor/providers/claude-registry-observation.mjs";
import { createClaudeCatalogPresence } from "../monitor/providers/claude-catalog-presence.mjs";

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
  return { root, projectsRoot, registryRoot, localId, mainFile, registryFile, writeRegistry };
}

function watchedProvider(values, watchers, options = {}) {
  return createClaudeProvider({
    homeDir: values.root,
    projectsRoot: values.projectsRoot,
    registryRoot: values.registryRoot,
    observerIntervalMs: options.intervalMs ?? 60_000,
    registryProcessIdentities: options.processIdentities || (() => new Map([[42, "owner-start"]])),
    registryProcessExists: options.processExists || (() => true),
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

test("recent Claude exit bypasses grace and publishes historical detail without a safety poll", async (context) => {
  const values = await fixture(context);
  await values.writeRegistry("idle");
  await utimes(values.mainFile, new Date(), new Date());
  let alive = true;
  const watchers = new Map();
  const provider = watchedProvider(values, watchers, { processExists: () => alive });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const catalogs = [];
  const details = [];
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_id, candidate) { details.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  await observer.hydrate(values.localId);
  await waitFor(() => details.length && catalogs.at(-1)?.[0]?.activityStatus === "open");
  await unlink(values.registryFile);
  watchers.get(path.resolve(values.registryRoot))("rename", path.basename(values.registryFile));
  await waitFor(() => catalogs.at(-1)?.[0]?.activityStatus === "unknown");
  assert.equal(catalogs.at(-1)[0].isLive, true, "registry departure alone is not proof of exit");
  alive = false; // No further filesystem event: registry deletion precedes process exit.
  await waitFor(() => catalogs.at(-1)?.[0]?.isLive === false && details.at(-1)?.historical === true,
    "actual exit must bypass both 15-second grace and 60-second reconciliation");
  assert.equal(catalogs.at(-1)[0].activityStatus, "idle");
});

test("Claude retains startup grace, but a stale current owner cannot revive it", async (context) => {
  const values = await fixture(context);
  await utimes(values.mainFile, new Date(), new Date());
  const provider = watchedProvider(values, new Map(), { processIdentities: () => new Map() });
  assert.equal((await provider.listSessions())[0].isLive, true, "no owner observed at startup");
  await values.writeRegistry("idle");
  assert.equal((await provider.listSessions())[0].isLive, false, "invalid native owner overrides recent activity");
});

test("retained Claude owners distinguish confirmed exit, registry gaps, inspection failures, and resume", async (context) => {
  const values = await fixture(context);
  let validation = true;
  let existence = true;
  let clock = Date.now();
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot,
    now: () => clock,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, validation])),
    ownerExists: () => { if (existence instanceof Error) throw existence; return existence; },
  });
  await values.writeRegistry("idle");
  assert.equal(observation.read().registry.has(values.localId), true);
  await writeFile(values.registryFile, "{");
  for (const value of [true, null, Object.assign(new Error("denied"), { code: "EPERM" })]) {
    clock += 251;
    existence = value;
    assert.equal(observation.read().closedSessionIds.has(values.localId), false);
  }
  existence = false;
  clock += 251;
  assert.equal(observation.read().closedSessionIds.has(values.localId), true);
  await values.writeRegistry("idle");
  validation = undefined;
  assert.equal(observation.read().registry.has(values.localId), true, "inspection failure preserves registry compatibility");
  assert.equal(observation.read().closedSessionIds.has(values.localId), true, "unknown does not erase prior exit evidence");
  validation = true;
  existence = true;
  clock += 251;
  assert.equal(observation.read().closedSessionIds.has(values.localId), false, "fresh validated registration clears closure");
  existence = true; // May be a reused PID; existence alone never proves identity continuity or exit.
  clock += 251;
  await rm(values.registryRoot, { recursive: true });
  assert.equal(observation.read().closedSessionIds.has(values.localId), false);
  existence = false;
  clock += 251;
  assert.equal(observation.read().closedSessionIds.has(values.localId), true, "directory removal cannot restore five-minute grace");
});

test("an unvalidated replacement owner discards the previous live association", async (context) => {
  const values = await fixture(context);
  let valid = true;
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, valid])),
    ownerExists: () => false,
  });
  await values.writeRegistry("idle");
  observation.read();
  valid = undefined;
  await writeFile(values.registryFile, JSON.stringify({ sessionId: values.localId, pid: 43, procStart: "different-start" }));
  assert.equal(observation.read().registry.has(values.localId), true);
  await unlink(values.registryFile);
  assert.equal(observation.read().closedSessionIds.has(values.localId), false, "old owner's exit cannot close an unvalidated replacement");
});

test("cached validation cannot revive an exited owner or leak an old absence into a reused PID", async (context) => {
  const values = await fixture(context);
  let alive = true;
  let clock = Date.now();
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot, now: () => clock,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, true])),
    ownerExists: () => alive,
  });
  await values.writeRegistry("idle");
  observation.read();
  await unlink(values.registryFile);
  alive = false;
  clock += 251;
  assert.equal(observation.read().closedSessionIds.has(values.localId), true);
  await values.writeRegistry("idle");
  assert.equal(observation.read().registry.has(values.localId), false, "stale positive identity loses to definite later absence");
  alive = true;
  await writeFile(values.registryFile, JSON.stringify({ sessionId: values.localId, pid: 42, procStart: "new-start", status: "idle" }));
  assert.equal(observation.read().registry.has(values.localId), true);
  await unlink(values.registryFile);
  assert.equal(observation.read().closedSessionIds.has(values.localId), false, "replacement owner cannot inherit cached PID absence");
});

test("native existence probe observes an isolated child exit without a plugin or identity helper", async (context) => {
  const values = await fixture(context);
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdout.write('ready'); process.stdin.on('end', () => process.exit(0));"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  let clock = Date.now();
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot,
    now: () => clock,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, true])),
  });
  await writeFile(values.registryFile, JSON.stringify({ sessionId: values.localId, pid: child.pid, procStart: "test-validated-start" }));
  observation.read();
  await unlink(values.registryFile);
  assert.equal(observation.read().closedSessionIds.has(values.localId), false);
  const exit = once(child, "exit");
  child.stdin.end();
  await exit;
  clock += 251;
  assert.equal(observation.read().closedSessionIds.has(values.localId), true);
  const restarted = createClaudeRegistryObservation({ root: values.registryRoot, validateOwners: () => new Map() });
  assert.equal(restarted.read().closedSessionIds.size, 0, "retirement evidence is memory-only");
});

test("retained ownership is bounded and missing-owner probes deduplicate shared PIDs", async (context) => {
  const values = await fixture(context);
  await Promise.all(Array.from({ length: 515 }, (_, index) => writeFile(path.join(values.registryRoot, `${index}.json`), JSON.stringify({
    sessionId: `session-${index}`, pid: 42, procStart: "shared-start",
  }))));
  let probes = 0;
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, true])),
    ownerExists: () => { probes += 1; return false; },
  });
  observation.read();
  await rm(values.registryRoot, { recursive: true });
  assert.equal(observation.read().closedSessionIds.size, 512);
  assert.equal(probes, 1);
});

test("departure rechecks are rate-bounded, stop with the observer, and expire after grace", async (context) => {
  const values = await fixture(context);
  let clock = Date.now();
  let probes = 0;
  const observation = createClaudeRegistryObservation({
    root: values.registryRoot, now: () => clock,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, true])),
    ownerExists: () => { probes += 1; return true; },
  });
  let refreshes = 0;
  let stops = 0;
  const observer = observeClaudeRegistryDepartures({
    start() {}, stop() { stops += 1; }, refresh() { refreshes += 1; return Promise.resolve(); },
  }, observation);
  await observer.start({});
  await values.writeRegistry("idle");
  observation.read();
  await unlink(values.registryFile);
  for (let index = 0; index < 20; index += 1) observation.read();
  assert.equal(probes, 1, "detail reads share the short existence cache");
  clock += 251;
  await waitFor(() => probes === 2);
  observer.stop();
  clock += 251;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(probes, 2, "direct stop clears the private departure timer");
  assert.equal(stops, 1);
  assert.equal(refreshes, 0);
  await observer.start({});
  clock += 15_001;
  await waitFor(() => probes === 3);
  clock += 251;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(probes, 3, "an uncertain gap cannot create an indefinite fast-poll loop");
  observer.stop();
});

test("Claude discovers a native session before its first prompt and merges its later transcript without duplicates", async (context) => {
  const values = await fixture(context);
  await unlink(values.mainFile);
  const startedAt = new Date().toISOString();
  const registration = { sessionId: values.localId, pid: 42, procStart: "owner-start", startedAt, status: "idle",
    prompt: "PRIVATE_PROMPT", cwd: "PRIVATE_DIRECTORY", token: "PRIVATE_TOKEN" };
  const watchers = new Map();
  const provider = watchedProvider(values, watchers);
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const catalogs = [];
  const details = [];
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_id, candidate) { details.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  await waitFor(() => watchers.has(path.resolve(values.registryRoot)));
  await writeFile(values.registryFile, JSON.stringify(registration));
  watchers.get(path.resolve(values.registryRoot))("rename", path.basename(values.registryFile));
  await waitFor(() => catalogs.at(-1)?.length === 1);
  const first = catalogs.at(-1)[0];
  assert.equal(first.localId, values.localId);
  assert.equal(first.activityStatus, "open");
  assert.equal(first.isLive, true);
  assert.equal(first.detailReadiness, "unavailable");
  assert.equal(first.updatedAt, startedAt);
  assert.equal(details.length, 0, "registry metadata must not invent session evidence");
  assert.equal(await provider.readSession(values.localId), null);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  await writeFile(values.registryFile, JSON.stringify({ ...registration, updatedAt: new Date(Date.now() + 120_000).toISOString() }));
  assert.equal((await provider.listSessions())[0].updatedAt, startedAt, "registry refresh cannot renew Open's five-minute window");
  const restarted = watchedProvider(values, new Map());
  assert.equal((await restarted.listSessions())[0].updatedAt, startedAt, "restart preserves the native opening time");
  await writeFile(values.mainFile, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: [] } })}\n`);
  await values.writeRegistry("active");
  watchers.get(path.resolve(values.projectsRoot))("rename", path.relative(values.projectsRoot, values.mainFile));
  await waitFor(() => catalogs.at(-1)?.[0]?.activityStatus === "working" && details.length > 0);
  assert.equal(catalogs.at(-1).length, 1);
  assert.equal(catalogs.at(-1)[0].localId, values.localId);
  assert.equal(catalogs.at(-1)[0].detailReadiness, undefined);
  assert.equal(details.at(-1).localId, values.localId);
  await unlink(values.mainFile);
  const retained = (await provider.listSessions())[0];
  assert.equal(retained.detailReadiness, undefined, "missing previously-recorded source cannot become metadata-only");
});

test("registry-only discovery requires validated ownership and a recorded start, and closes without a prompt", async (context) => {
  const values = await fixture(context);
  await unlink(values.mainFile);
  const row = { sessionId: values.localId, pid: 42, procStart: "owner-start", status: "idle", startedAt: new Date().toISOString() };
  await writeFile(values.registryFile, JSON.stringify(row));
  for (const processIdentities of [() => new Map(), () => null]) {
    const provider = watchedProvider(values, new Map(), { processIdentities });
    assert.deepEqual(await provider.listSessions(), []);
  }
  const watchers = new Map();
  const provider = watchedProvider(values, watchers);
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  let catalog = null;
  await observer.start({ publishCatalog(entries) { catalog = entries; }, publishSession() { assert.fail("no transcript"); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => catalog?.length === 1);
  await unlink(values.registryFile);
  watchers.get(path.resolve(values.registryRoot))("rename", path.basename(values.registryFile));
  await waitFor(() => catalog?.length === 0, "closing before a prompt must not wait for transcript activity");
});

test("registry-only catalog union is bounded, respects explicit selection, and never duplicates known sources", () => {
  const presence = createClaudeCatalogPresence();
  const registry = new Map(Array.from({ length: 70 }, (_, index) => [`session-${index}`, {
    sessionId: `session-${index}`, status: "idle", ownerStartedAt: 1_787_000_000_000 + index,
    resourceOwner: { pid: index + 1, processStartIdentity: "start" },
  }]));
  assert.equal(presence.merge([], [], registry).length, 50);
  assert.equal(presence.liveSessionIds().length, 50);
  assert.deepEqual(presence.merge([], [], registry, { explicitSession: "explicit.jsonl" }), []);
  const rows = presence.merge([], [{ file: "session-69.jsonl" }], registry);
  assert.equal(rows.some((entry) => entry.localId === "session-69"), false);
  const valid = registry.get("session-69");
  for (const [status, needsInput, expected] of [["active", false, "working"], ["waiting", true, "needs_input"], ["", false, "unknown"]]) {
    const result = presence.merge([], [], new Map([[valid.sessionId, { ...valid, status, needsInput }]]));
    assert.equal(result[0].activityStatus, expected);
  }
  assert.deepEqual(createClaudeCatalogPresence().merge([], [], new Map([["no-start", { ...valid, sessionId: "no-start", ownerStartedAt: undefined }]])), []);
});
