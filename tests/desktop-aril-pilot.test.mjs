import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArilPilotCoordinator } from "../desktop/runtime/aril-pilot.mjs";
import { createArilPilotStore, normalizePilotGrant } from "../desktop/runtime/aril-pilot-store.mjs";
import { parsePilotDecision, pilotEvidence } from "../desktop/runtime/aril-pilot-prompt.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const secondRepository = "repo-abcdef0123456789abcdef01";
const initial = "2026-10-18T10:00:00.000Z";
const choice = { provider: "codex", model: "gpt-6-luna" };
function task(id = "T-1", overrides = {}) {
  return { id, text: "Implement a bounded improvement", state: "queued", columnId: "ready", position: 0, featureId: null, run: { ...choice, effort: "high" }, session: null, report: null, completeWhen: { checks: ["pr_open"], own: null }, scheduledAt: null, updatedAt: initial, ...overrides };
}
function board() {
  return { repositoryId, readiness: "ready", columns: [{ id: "ready", name: "Ready", position: 0, role: null }], features: [], tasks: [task()], queue: {
    status: "off", order: ["T-1"], blockedBy: null, gates: { threshold: 85, workingTree: "clean", providerStatus: { claude: "ok", codex: "ok" }, usage: { claude: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 15 }, codex: { status: "ok", fiveHourPercent: 20, sevenDayPercent: 15 } } },
  } };
}
function usage() {
  return { revision: 1, readiness: { claude: "ready", codex: "ready" }, providers: ["claude", "codex"].map((provider) => ({ provider, usageLimits: { available: true, freshness: "fresh", fetchedAt: initial, attemptedAt: initial, limits: [{ id: "current", label: "Current", window: "5 hours", percent: 20, resetsAt: "2026-10-18T15:00:00.000Z", active: false }] } })) };
}
const spec = (extra = {}) => ({ repositoryId, goal: "Finish the bounded work", taskIds: ["T-1"], allowedRuns: [choice, { provider: "claude", model: null }], inference: choice, ...extra });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function harness(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-aril-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { directory, board: board(), usage: usage(), time: new Date(initial), calls: [], starts: [], refreshes: 0, action: "wait", reason: "Wait for relevant evidence.", ...overrides };
  const options = {
    directory, now: () => h.time,
    readBoard: async () => structuredClone(h.board), readUsage: async () => structuredClone(h.usage), refreshUsage: async () => { h.refreshes += 1; },
    isBusy: () => false,
    decide: async (request) => {
      h.calls.push(request);
      const evidence = JSON.parse(request.prompt.match(/<evidence>(.*?)<\/evidence>/su)[1]);
      return { status: "complete", text: JSON.stringify({ action: h.action, taskId: h.action === "start" ? "T-1" : null, provider: h.action === "start" ? choice.provider : null, model: h.action === "start" ? choice.model : null, reason: h.reason, waitUntil: null, evidenceRevision: evidence.evidenceRevision }) };
    },
    starter: { startAutonomous: async (...args) => { h.starts.push(args); assert.equal(await args[2].isAuthorized({ taskId: args[1], ...choice, effort: "high" }), true); return { status: "started" }; } },
  };
  Object.assign(options, h.options ?? {});
  h.options = options;
  h.pilot = createArilPilotCoordinator(options);
  t.after(() => h.pilot.dispose());
  h.activate = (extra) => h.pilot.activate(spec(extra));
  h.read = async () => (await h.pilot.read(repositoryId)).pilot;
  h.advance = (minutes = 5) => { h.time = new Date(h.time.getTime() + minutes * 60_000); };
  return h;
}

test("bounded defaults persist only private grants and reject scope expansion", async (t) => {
  const h = await harness(t);
  const result = await h.activate();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.pilot.roundLimit, result.pilot.startLimit, result.pilot.concurrency, result.pilot.minIntervalMinutes], [20, 3, 1, 5]);
  assert.equal(result.pilot.expiresAt, "2026-10-19T10:00:00.000Z");
  assert.equal(Object.hasOwn(result.pilot, "lastFingerprint"), false);
  assert.deepEqual(await h.activate(), { ok: false, error: "conflict" });
  for (const extra of [{ taskIds: [] }, { taskIds: ["T-2"] }, { taskIds: ["T-1", "T-1"] }, { goal: "" }, { durationHours: 169 }, { roundLimit: 101 }, { startLimit: 33 }, { concurrency: 4, startLimit: 3 }, { minIntervalMinutes: 4 }, { allowedRuns: [{ provider: "codex", model: "../model" }] }, { path: "secret" }]) {
    assert.equal((await h.activate(extra)).error, "invalid", JSON.stringify(extra));
  }
  const disk = JSON.parse(await readFile(path.join(h.directory, "authority-v1.json"), "utf8"));
  assert.ok(normalizePilotGrant(disk.grants[0]));
});

test("changed revisions or acquisition times alone do not trigger inference", async (t) => {
  const h = await harness(t);
  await h.activate(); await h.pilot.tick();
  assert.equal(h.calls.length, 1);
  h.advance(); h.usage.revision += 1; h.usage.providers[0].usageLimits.fetchedAt = h.time.toISOString();
  await h.pilot.tick(); await h.pilot.tick();
  assert.equal(h.calls.length, 1);
  h.board.tasks[0].text = "A materially changed task";
  await h.pilot.tick();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.read()).roundsUsed, 2);
});

test("start reservation and budget are durable before starter effects", async (t) => {
  const h = await harness(t, { action: "start" });
  h.options.starter.startAutonomous = async (...args) => {
    h.starts.push(args);
    const disk = JSON.parse(await readFile(path.join(h.directory, "authority-v1.json"), "utf8"));
    assert.equal(disk.grants[0].startsUsed, 1);
    assert.equal(disk.grants[0].receipts.at(-1).status, "pending");
    assert.equal(await args[2].isAuthorized({ taskId: "T-1", ...choice, effort: "high" }), true);
    return { status: "started" };
  };
  await h.activate(); await h.pilot.tick();
  assert.equal(h.starts.length, 1);
  assert.equal((await h.read()).receipts.at(-1).status, "started");
  assert.equal(h.starts[0][2].run, undefined);
  assert.deepEqual(h.starts[0][2].expectedRun, h.board.tasks[0].run);
  h.advance(); h.board.tasks[0].text += " changed";
  await h.pilot.tick();
  assert.equal(h.starts.length, 1);
  assert.equal((await h.read()).status, "active");
});

test("pause during inference or between plan and spawn invalidates authorization", async (t) => {
  for (const stage of ["inference", "spawn"]) {
    const h = await harness(t, { action: "start" });
    if (stage === "inference") {
      const decide = h.options.decide;
      h.options.decide = async (request) => { await h.pilot.pause(repositoryId); return decide(request); };
      h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
    } else {
      h.options.starter.startAutonomous = async (...args) => { await h.pilot.pause(repositoryId); assert.equal(await args[2].isAuthorized({ taskId: "T-1", ...choice, effort: "high" }), false); return { status: "cancelled" }; };
    }
    await h.activate(); await h.pilot.tick();
    assert.equal((await h.read()).status, "paused", stage);
    assert.equal(h.starts.length, 0);
  }
});

test("expiration during an inference prevents a start", async (t) => {
  const h = await harness(t, { action: "start" });
  const decide = h.options.decide;
  h.options.decide = async (request) => { h.advance(61); return decide(request); };
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate({ durationHours: 1 }); await h.pilot.tick();
  assert.equal(h.starts.length, 0);
  assert.equal((await h.read()).status, "expired");
});

test("busy chat slot consumes no round and can retry unchanged evidence", async (t) => {
  const h = await harness(t);
  h.options.decide = async () => ({ status: "busy" });
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); await h.pilot.tick();
  assert.equal((await h.read()).roundsUsed, 0);
  assert.equal((await h.read()).receipts.length, 0);
});

test("interactive priority interrupted inference waits with an explicit receipt", async (t) => {
  const h = await harness(t);
  h.options.decide = async () => ({ status: "interrupted" });
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); await h.pilot.tick();
  const saved = await h.read();
  assert.equal(saved.status, "active"); assert.equal(saved.roundsUsed, 1); assert.equal(saved.receipts[0].status, "interrupted");
});

test("read and activation during a live provider run do not recover its pending receipt", async (t) => {
  const entered = deferred(); const release = deferred();
  const h = await harness(t);
  const secondBoard = structuredClone(h.board);
  secondBoard.repositoryId = secondRepository;
  const boards = new Map([[repositoryId, h.board], [secondRepository, secondBoard]]);
  h.options.readBoard = async (id) => structuredClone(boards.get(id));
  const decide = h.options.decide;
  h.options.decide = async (request) => { entered.resolve(); await release.promise; return decide(request); };
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate();
  const running = h.pilot.tick();
  await entered.promise;

  assert.equal((await h.pilot.read(repositoryId)).pilot.receipts.at(-1).status, "pending");
  assert.equal((await h.pilot.activate(spec({ repositoryId: secondRepository }))).ok, true);
  assert.equal((await h.pilot.read(repositoryId)).pilot.receipts.at(-1).status, "pending");
  assert.equal((await h.pilot.read(repositoryId)).pilot.status, "active");

  release.resolve();
  await running;
  assert.equal((await h.pilot.read(repositoryId)).pilot.receipts.at(-1).status, "complete");
});

test("activation authorization is rechecked at the serialized commit boundary", async (t) => {
  const entered = deferred(); const release = deferred();
  const h = await harness(t);
  let authorized = true;
  h.options.readBoard = async () => { entered.resolve(); await release.promise; return structuredClone(h.board); };
  const activating = h.pilot.activate(spec(), async () => authorized);
  await entered.promise;
  authorized = false;
  release.resolve();
  assert.deepEqual(await activating, { ok: false, error: "conflict" });
  assert.equal((await createArilPilotStore({ directory: h.directory }).read()).grants.length, 0);
  assert.equal((await h.activate()).ok, true);
  assert.deepEqual(await h.pilot.pause(repositoryId, async () => false), { ok: false, error: "conflict" });
  assert.deepEqual(await h.pilot.revoke(repositoryId, async () => false), { ok: false, error: "conflict" });
  assert.equal((await h.read()).status, "active");
  await h.pilot.revoke(repositoryId);
  h.action = "start";
  let pairedAuthorization = true;
  const approved = await h.pilot.activate(spec(), async () => pairedAuthorization);
  assert.equal(approved.ok, true);
  pairedAuthorization = false;
  const journal = JSON.parse(await readFile(path.join(h.directory, "authority-v1.json"), "utf8"));
  assert.equal(Object.hasOwn(journal.grants.at(-1), "isAuthorized"), false);
  await h.pilot.tick();
  assert.equal(h.starts.length, 1);
  assert.equal((await h.read()).status, "active");
});

test("quota holds apply to inference and reset waits require fresh committed acquisition", async (t) => {
  const h = await harness(t);
  h.board.queue.gates.usage.codex.status = "over";
  h.usage.providers[1].usageLimits.limits[0].percent = 90;
  h.usage.providers[1].usageLimits.limits[0].resetsAt = "2026-10-18T10:05:00.000Z";
  await h.activate(); await h.pilot.tick();
  assert.equal(h.calls.length, 0);
  h.advance(); await h.pilot.tick();
  assert.equal(h.refreshes, 1); assert.equal(h.calls.length, 0);
  // A timer and a permissive old board gate cannot manufacture fresh headroom.
  h.board.queue.gates.usage.codex.status = "ok";
  await h.pilot.tick(); assert.equal(h.calls.length, 0);
  h.usage.providers[1].usageLimits.fetchedAt = "2026-10-18T10:05:01.000Z";
  h.time = new Date("2026-10-18T10:05:02.000Z");
  h.usage.providers[1].usageLimits.limits[0].percent = 10;
  h.usage.providers[1].usageLimits.limits[0].resetsAt = "2026-10-18T15:00:00.000Z";
  await h.pilot.tick(); assert.equal(h.calls.length, 1);
});

test("fresh quota over threshold blocks even when the board cache still says ok", async (t) => {
  const h = await harness(t);
  h.usage.providers[1].usageLimits.limits[0].percent = 85;
  await h.activate(); await h.pilot.tick(); assert.equal(h.calls.length, 0);
});

test("quota changes after inference hold the launch and never repeat it", async (t) => {
  const h = await harness(t, { action: "start" });
  const decide = h.options.decide;
  h.options.decide = async (request) => { const answer = await decide(request); h.board.queue.gates.usage.codex.status = "over"; return answer; };
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); await h.pilot.tick();
  assert.equal(h.starts.length, 0); assert.equal((await h.read()).status, "active");
});

test("explicit configured provider default is immutable; unset provider can be filled", async (t) => {
  const configured = await harness(t, { action: "start" });
  configured.board.tasks[0].run.model = null;
  await configured.activate(); await configured.pilot.tick();
  assert.equal(configured.starts.length, 0); assert.equal((await configured.read()).status, "needs_you");
  const unset = await harness(t, { action: "start" });
  unset.board.tasks[0].run.provider = null; unset.board.tasks[0].run.model = null;
  await unset.activate(); await unset.pilot.tick();
  assert.deepEqual(unset.starts[0][2].run, choice);
});

test("concurrency and minimum interval prevent repeated decisions", async (t) => {
  const h = await harness(t);
  h.board.tasks.push(task("T-2", { session: { id: "codex:synthetic", state: "active" } }));
  await h.activate(); await h.pilot.tick(); assert.equal(h.calls.length, 0);
  h.board.tasks[1].session = null;
  await h.pilot.tick(); assert.equal(h.calls.length, 1);
  h.board.tasks[0].text += " changed";
  await h.pilot.tick(); assert.equal(h.calls.length, 1);
  h.advance(); await h.pilot.tick(); assert.equal(h.calls.length, 2);
});

test("the durable round budget finishes without an extra inference", async (t) => {
  const h = await harness(t);
  await h.activate({ roundLimit: 1 }); await h.pilot.tick(); h.advance(); await h.pilot.tick();
  assert.equal(h.calls.length, 1); assert.equal((await h.read()).status, "finished");
  assert.match((await h.read()).summary, /budget/u);
});

test("uncertain start and corrupted journal cannot launch on restart or be erased", async (t) => {
  const h = await harness(t, { action: "start" });
  h.options.starter.startAutonomous = async () => { throw new Error("synthetic private failure"); };
  await h.activate(); await h.pilot.tick();
  assert.equal((await h.read()).receipts.at(-1).status, "uncertain");
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.pilot.tick(); assert.equal(h.starts.length, 0); assert.equal((await h.read()).status, "needs_you");
  await h.pilot.revoke(repositoryId);
  assert.deepEqual(await h.activate(), { ok: false, error: "conflict" });
  const target = path.join(h.directory, "authority-v1.json");
  const broken = '{"version":999,"grants":[]}';
  await writeFile(target, broken);
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  assert.equal((await h.activate()).error, "unavailable");
  assert.equal(await readFile(target, "utf8"), broken);
});

test("restart with a pending decision consumes its reservation without rerunning", async (t) => {
  const h = await harness(t);
  await h.activate();
  const store = createArilPilotStore({ directory: h.directory });
  const evidenceRevision = pilotEvidence(h.board, h.usage).evidenceRevision;
  await store.update((state) => {
    const saved = state.grants[0]; saved.roundsUsed = 1;
    saved.receipts.push({ at: initial, taskId: null, action: "inference", status: "pending", provider: choice.provider, model: choice.model, reason: "reserved", evidenceRevision });
  });
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.pilot.tick();
  assert.equal(h.calls.length, 0); assert.equal((await h.read()).roundsUsed, 1); assert.equal((await h.read()).receipts[0].status, "interrupted");
});

test("one active grant per repository keeps revoked history scoped", async (t) => {
  const h = await harness(t);
  await h.activate(); await h.pilot.revoke(repositoryId);
  h.board.repositoryId = secondRepository;
  const result = await h.activate({ repositoryId: secondRepository });
  assert.equal(result.ok, true);
  assert.equal((await h.pilot.read(repositoryId)).pilot.status, "revoked");
  assert.equal((await h.pilot.read(repositoryId)).history.length, 0);
  assert.equal((await h.pilot.activate(spec())).error, "unavailable");
});

test("different repositories run independent grants with identical task IDs", async (t) => {
  const h = await harness(t);
  h.action = "start";
  const opus = { provider: "claude", model: "claude-opus-4-1" };
  h.board.queue.status = "off";
  h.board.tasks[0].run = { ...opus, effort: "high" };
  const secondBoard = structuredClone(h.board);
  secondBoard.repositoryId = secondRepository;
  secondBoard.tasks[0].run = { provider: null, model: null, effort: "high" };
  secondBoard.tasks[0].group = "grp-0123456789ab";
  const boards = new Map([[repositoryId, h.board], [secondRepository, secondBoard]]);
  h.options.readBoard = async (id) => structuredClone(boards.get(id));
  const decide = h.options.decide;
  h.options.decide = async (request) => {
    const result = await decide(request);
    if (request.repositoryId !== repositoryId) return result;
    const answer = JSON.parse(result.text);
    answer.provider = opus.provider; answer.model = opus.model;
    return { ...result, text: JSON.stringify(answer) };
  };
  h.options.starter.startAutonomous = async (...args) => {
    h.starts.push(args);
    const selected = args[0] === repositoryId ? opus : choice;
    assert.equal(await args[2].isAuthorized({ taskId: args[1], ...selected, effort: "high" }), true);
    return { status: "started" };
  };
  assert.equal((await h.options.readBoard(repositoryId)).repositoryId, repositoryId);
  const first = await h.activate({ allowedRuns: [choice, opus] });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await h.options.readBoard(secondRepository)).repositoryId, secondRepository);
  assert.equal((await createArilPilotStore({ directory: h.directory }).read()).grants.length, 1);
  const second = await h.pilot.activate(spec({ repositoryId: secondRepository, goal: "Finish Pokrr work" }));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await h.pilot.activate(spec())).error, "conflict");

  await h.pilot.tick();
  assert.deepEqual(h.calls.map((call) => call.repositoryId).sort(), [repositoryId, secondRepository].sort());
  assert.equal((await h.pilot.read(repositoryId)).pilot.roundsUsed, 1);
  assert.equal((await h.pilot.read(secondRepository)).pilot.roundsUsed, 1);
  assert.equal((await h.pilot.read(repositoryId)).pilot.startsUsed, 1);
  assert.equal((await h.pilot.read(secondRepository)).pilot.startsUsed, 1);
  assert.deepEqual(h.starts.map(([id, taskId]) => [id, taskId]).sort(), [[repositoryId, "T-1"], [secondRepository, "T-1"]].sort());
  assert.notEqual(h.starts[0][2].attemptId, h.starts[1][2].attemptId);
  assert.equal((await h.pilot.read(repositoryId)).pilot.taskIds[0], "T-1");
  assert.equal((await h.pilot.read(secondRepository)).pilot.taskIds[0], "T-1");
  await h.pilot.pause(secondRepository);
  assert.equal((await h.pilot.read(secondRepository)).pilot.status, "paused");
  assert.equal((await h.pilot.read(repositoryId)).pilot.status, "active");
  await h.pilot.revoke(repositoryId);
  assert.equal((await h.pilot.read(repositoryId)).pilot.status, "revoked");
  assert.equal((await h.pilot.read(secondRepository)).pilot.status, "paused");

  const store = createArilPilotStore({ directory: h.directory });
  const duplicate = await store.update((state) => {
    const copy = structuredClone(state.grants.find((grant) => grant.repositoryId === secondRepository));
    copy.status = "active";
    copy.id = `pilot-${"f".repeat(24)}`;
    state.grants.push(copy);
  });
  assert.deepEqual(duplicate, { ok: false, error: "invalid" });
  const journalPath = path.join(h.directory, "authority-v1.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const copy = structuredClone(journal.grants.find((grant) => grant.repositoryId === secondRepository));
  copy.status = "active";
  copy.id = `pilot-${"e".repeat(24)}`;
  journal.grants.push(copy);
  await writeFile(journalPath, JSON.stringify(journal));
  const restarted = createArilPilotCoordinator({ ...h.options, directory: h.directory });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.read(repositoryId)).error, "unavailable");
});

test("active repositories rotate first visitation across sweeps", async (t) => {
  const h = await harness(t);
  const secondBoard = structuredClone(h.board);
  secondBoard.repositoryId = secondRepository;
  const boards = new Map([[repositoryId, h.board], [secondRepository, secondBoard]]);
  h.options.readBoard = async (id) => structuredClone(boards.get(id));
  await h.activate();
  assert.equal((await h.pilot.activate(spec({ repositoryId: secondRepository }))).ok, true);

  await h.pilot.tick();
  assert.deepEqual(h.calls.map((call) => call.repositoryId), [repositoryId, secondRepository]);
  h.advance();
  h.board.tasks[0].text += " changed";
  secondBoard.tasks[0].text += " changed";
  await h.pilot.tick();
  assert.deepEqual(h.calls.slice(2).map((call) => call.repositoryId), [secondRepository, repositoryId]);
});

test("only one tick owns the decider and strict decisions reject instruction-shaped output", async (t) => {
  const entered = deferred(); const release = deferred();
  const h = await harness(t);
  const decide = h.options.decide;
  h.options.decide = async (request) => { entered.resolve(); await release.promise; return decide(request); };
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); const first = h.pilot.tick(); await entered.promise; const second = h.pilot.tick();
  assert.equal(first, second); release.resolve(); await first; assert.equal(h.calls.length, 1);
  const revision = "a".repeat(64);
  const good = { action: "wait", taskId: null, provider: null, model: null, reason: "Waiting", waitUntil: null, evidenceRevision: revision };
  assert.ok(parsePilotDecision(JSON.stringify(good), revision));
  for (const value of [{ ...good, shell: "rm" }, { ...good, evidenceRevision: "b".repeat(64) }, { ...good, action: "start", taskId: "../../x", provider: "codex" }, { ...good, reason: "" }]) assert.equal(parsePilotDecision(JSON.stringify(value), revision), null);
});

test("prompt boundary excludes raw transcript credentials paths and usage error text", async (t) => {
  const h = await harness(t);
  const sentinel = "PRIVATE_TRANSCRIPT_CREDENTIAL_ERROR_SENTINEL";
  h.board.transcript = sentinel; h.board.repositoryRoot = sentinel; h.board.tasks[0].path = sentinel; h.board.tasks[0].rawResponse = sentinel;
  h.usage.providers[0].usageLimits.error = sentinel;
  await h.activate(); await h.pilot.tick();
  assert.equal(h.calls[0].prompt.includes(sentinel), false);
  assert.match(h.calls[0].prompt, /BOTH allowed providers/u);
  assert.match(h.calls[0].prompt, /an unrelated hold is never a grant-wide veto/u);
});

test("owner-held work does not stop another eligible authorized task", async (t) => {
  const h = await harness(t);
  h.board.tasks[0].state = "needs_review";
  h.board.tasks.push(task("T-2"));
  h.board.queue.order = ["T-2"];
  h.options.decide = async (request) => {
    h.calls.push(request);
    assert.match(request.prompt, /If another authorized task is eligible, choose that task and continue the grant/u);
    assert.match(request.prompt, /Use needs_you only when every remaining authorized task requires an owner decision/u);
    const evidence = JSON.parse(request.prompt.match(/<evidence>(.*?)<\/evidence>/su)[1]);
    return { status: "complete", text: JSON.stringify({ action: "start", taskId: "T-2", provider: choice.provider, model: choice.model, reason: "T-2 is eligible while T-1 awaits owner validation.", waitUntil: null, evidenceRevision: evidence.evidenceRevision }) };
  };
  await h.activate({ taskIds: ["T-1", "T-2"] });
  await h.pilot.tick();
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0][1], "T-2");
  assert.equal((await h.read()).status, "active");
  assert.equal((await h.read()).receipts.at(-1).status, "started");
  assert.equal(h.board.tasks[0].state, "needs_review");
  assert.equal(h.board.tasks[1].state, "queued");
});

test("a deterministic gate refusal is retried only after changed evidence with a new durable attempt", async (t) => {
  const h = await harness(t, { action: "start" });
  h.options.starter.startAutonomous = async (...args) => { h.starts.push(args); return { status: h.starts.length === 1 ? "gate_held" : "started" }; };
  await h.activate(); await h.pilot.tick();
  assert.equal((await h.read()).status, "active"); assert.equal((await h.read()).receipts.at(-1).status, "blocked");
  h.advance(); await h.pilot.tick(); assert.equal(h.starts.length, 1);
  h.board.queue.gates.usage.codex.fiveHourPercent = 18;
  await h.pilot.tick(); assert.equal(h.starts.length, 2);
  assert.notEqual(h.starts[0][2].attemptId, h.starts[1][2].attemptId);
  assert.equal((await h.read()).startsUsed, 2);
});

test("an explicit wait deadline is one semantic wake and an ordinary wait has no periodic inference", async (t) => {
  const h = await harness(t);
  const decide = h.options.decide;
  h.options.decide = async (request) => {
    const result = await decide(request); const value = JSON.parse(result.text);
    if (h.calls.length === 1) value.waitUntil = "2026-10-18T10:05:00.000Z";
    return { ...result, text: JSON.stringify(value) };
  };
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); await h.pilot.tick(); h.advance(); await h.pilot.tick();
  assert.equal(h.calls.length, 2);
  h.advance(); await h.pilot.tick(); await h.pilot.tick();
  assert.equal(h.calls.length, 2);
});

test("a selected task's schedule becomes a one-time wake without board revision changes", async (t) => {
  const h = await harness(t);
  h.board.tasks[0].state = "scheduled"; h.board.tasks[0].scheduledAt = "2026-10-18T10:05:00.000Z";
  await h.activate(); await h.pilot.tick(); assert.equal(h.calls.length, 1);
  h.advance(); await h.pilot.tick(); assert.equal(h.calls.length, 2);
  h.advance(); await h.pilot.tick(); assert.equal(h.calls.length, 2);
});

test("an idle or unknown linked session and an unbound started receipt occupy concurrency", async (t) => {
  for (const state of ["idle", "unknown", "needs_input"]) {
    const h = await harness(t);
    h.board.tasks.push(task("T-2", { session: { id: "codex:synthetic", state } }));
    await h.activate(); await h.pilot.tick(); assert.equal(h.calls.length, 0, state);
  }
  const h = await harness(t, { action: "start" });
  await h.activate(); await h.pilot.tick(); h.advance(); h.board.tasks[0].text += " changed";
  await h.pilot.tick(); assert.equal(h.calls.length, 1); assert.equal(h.starts.length, 1);
});

test("budget exhaustion accompanies launched results and saves a final normalized summary", async (t) => {
  const h = await harness(t, { action: "start" });
  await h.activate({ startLimit: 1 }); await h.pilot.tick(); await h.pilot.tick();
  assert.equal((await h.read()).status, "active"); assert.match((await h.read()).waiting, /Watching/u);
  h.board.tasks[0].state = "needs_review";
  h.board.tasks[0].report = { results: [{ check: "ci_passed", passed: true }, { check: "tree_clean", passed: false, unavailable: true }] };
  await h.pilot.tick();
  const saved = await h.read();
  assert.equal(saved.status, "finished"); assert.match(saved.summary, /T-1: needs_review/u); assert.match(saved.summary, /ci_passed passed/u); assert.match(saved.summary, /tree_clean unavailable/u);
  assert.equal(h.calls.length, 1);
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  assert.equal((await h.read()).summary, saved.summary);
});

test("pause/revoke summaries survive in-flight settlement", async (t) => {
  const h = await harness(t, { action: "start" });
  h.options.starter.startAutonomous = async () => { await h.pilot.revoke(repositoryId); return { status: "cancelled" }; };
  await h.activate(); await h.pilot.tick();
  assert.equal((await h.read()).status, "revoked"); assert.equal((await h.read()).summary, "The owner revoked this authorization.");
});

test("irrelevant task edits and timestamps alone do not spend rounds", async (t) => {
  const h = await harness(t);
  h.board.tasks.push(task("T-2", { state: "not_queued" }));
  await h.activate(); await h.pilot.tick(); h.advance();
  h.board.tasks[1].text += " unrelated update"; h.board.tasks[0].updatedAt = h.time.toISOString();
  await h.pilot.tick(); assert.equal(h.calls.length, 1);
});

test("usage older than the authoritative gate lifetime cannot authorize inference", async (t) => {
  const h = await harness(t);
  h.advance(11); await h.activate(); await h.pilot.tick(); assert.equal(h.calls.length, 0);
});

test("a failed durable start reservation performs no launch", async (t) => {
  const h = await harness(t, { action: "start" });
  let writes = 0;
  h.options.store = createArilPilotStore({ directory: h.directory, filesystem: { ...filesystem, open: (...args) => { writes += 1; if (writes === 4) throw new Error("synthetic disk failure"); return filesystem.open(...args); } } });
  h.pilot.dispose(); h.pilot = createArilPilotCoordinator(h.options);
  await h.activate(); await h.pilot.tick();
  assert.equal(h.starts.length, 0); assert.equal((await h.read()).startsUsed, 0);
});

test("a fresh owner requeue permits a new explicit grant after revoke, retaining the old uncertain receipt", async (t) => {
  const h = await harness(t, { action: "start" });
  h.options.starter.startAutonomous = async () => ({ status: "uncertain" });
  await h.activate(); await h.pilot.tick(); await h.pilot.revoke(repositoryId);
  assert.equal((await h.activate()).error, "conflict");
  h.advance(); h.board.tasks[0].updatedAt = h.time.toISOString();
  assert.equal((await h.activate()).ok, true);
  const read = await h.pilot.read(repositoryId);
  assert.equal(read.history.length, 1); assert.equal(read.history[0].receipts.at(-1).status, "uncertain");
  await h.pilot.tick(); assert.equal((await h.read()).receipts.at(-1).status, "uncertain");
});
