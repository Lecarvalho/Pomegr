import { randomBytes } from "node:crypto";
import { taskStartRevision } from "../../shared/task-start-revision.mjs";
import { createArilPilotStore, PILOT_HISTORY_LIMIT, PILOT_REPOSITORY, PILOT_TASK, bounded, plain, pilotProjection, runChoice } from "./aril-pilot-store.mjs";
import { composePilotPrompt, parsePilotDecision, pilotEvidence } from "./aril-pilot-prompt.mjs";
import { pilotRunningTaskIds } from "./aril-pilot-concurrency.mjs";

const DEFAULTS = Object.freeze({ durationHours: 24, roundLimit: 20, startLimit: 3, concurrency: 1, minIntervalMinutes: 5 });
const TERMINAL = new Set(["revoked", "expired", "finished"]);
const STARTABLE = new Set(["not_queued", "queued", "scheduled"]);
const NO_LAUNCH = new Set(["invalid", "cancelled", "busy", "gate_held", "tree_dirty", "not_startable", "not_found", "cli_missing", "plugin_missing", "unsupported_platform", "worktree_dirty"]);
const TRANSIENT_START = new Set(["busy", "gate_held", "tree_dirty", "cancelled"]);
const FINISHED_TASK = new Set(["done", "needs_review", "blocked", "stalled"]);
// Match the monitor gate's ten-minute evidence lifetime; its status remains authoritative.
const USAGE_MAX_AGE_MS = 10 * 60_000;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const allowed = (grant, run) => grant.allowedRuns.some((entry) => entry.provider === run.provider && entry.model === run.model);
const atMs = (value) => Date.parse(value);
const clone = (value) => structuredClone(value);
const ownerRequeuedAfter = (task, receipt) => !!task && !task.session && STARTABLE.has(task.state) && Number.isFinite(atMs(task.updatedAt)) && atMs(task.updatedAt) > atMs(receipt.at);

function activation(value) {
  const keys = ["repositoryId", "goal", "taskIds", "durationHours", "roundLimit", "startLimit", "concurrency", "minIntervalMinutes", "allowedRuns", "inference"];
  if (!plain(value) || Object.keys(value).some((key) => !keys.includes(key)) || typeof value.repositoryId !== "string" || !PILOT_REPOSITORY.test(value.repositoryId)
    || !bounded(value.goal, 2000) || !Array.isArray(value.taskIds) || !integer(value.taskIds.length, 1, 32)
    || value.taskIds.some((id) => typeof id !== "string" || !PILOT_TASK.test(id)) || new Set(value.taskIds).size !== value.taskIds.length
    || !Array.isArray(value.allowedRuns) || !integer(value.allowedRuns.length, 1, 32) || !value.allowedRuns.every(runChoice) || !runChoice(value.inference)) return null;
  const normalized = { ...DEFAULTS, ...clone(value), goal: value.goal.trim() };
  if (!integer(normalized.durationHours, 1, 168) || !integer(normalized.roundLimit, 1, 100) || !integer(normalized.startLimit, 1, 32)
    || !integer(normalized.concurrency, 1, 4) || normalized.concurrency > normalized.startLimit || !integer(normalized.minIntervalMinutes, 5, 1440)) return null;
  return normalized;
}

/** Desktop-only bounded authority, independent of the chat panel lifecycle. All collaborators are synthetic-test seams. */
export function createArilPilotCoordinator(options = {}) {
  const store = options.store ?? createArilPilotStore({ directory: options.directory });
  const clock = options.now ?? (() => new Date());
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  let disposed = false;
  let running = null;
  let timer = null;
  let started = false;
  let recovery = null;
  let lastScheduledGrantId = null;
  const date = () => new Date(clock());
  const iso = () => date().toISOString();
  const latestFor = (state, repositoryId) => state.grants.findLast((grant) => grant.repositoryId === repositoryId) ?? null;
  const receipt = (action, status, evidenceRevision, reason = "", taskId = null, run = null) => ({ at: iso(), taskId, action, status, provider: run?.provider ?? null, model: run?.model ?? null, reason, evidenceRevision });

  async function change(id, mutate, isAuthorized) {
    return store.update((state) => {
      const grant = state.grants.find((entry) => entry.id === id);
      if (!grant) return { ok: false, error: "conflict" };
      const outcome = mutate(grant, state);
      if (outcome?.ok === false) return outcome;
      grant.revision += 1;
      return { pilot: pilotProjection(grant), ...outcome };
    }, isAuthorized);
  }

  // Crash recovery never dispatches. A durable reservation consumes its budget, even if its outcome is unknown.
  async function recover(grantIds = null, isAuthorized = async () => true) {
    if (!grantIds && recovery) return recovery;
    const pendingRecovery = (async () => {
      const state = await store.read();
      if (!state) return false;
      for (const grant of state.grants) {
        if (grantIds && !grantIds.has(grant.id)) continue;
        if (!grant.receipts.some((row) => row.status === "pending")) continue;
        let board;
        try { board = await options.readBoard(grant.repositoryId); } catch { /* uncertainty remains private and blocks starts */ }
        const result = await change(grant.id, (saved) => {
          let uncertain = false;
          for (const row of saved.receipts) if (row.status === "pending") {
            row.status = row.action === "start" ? (board?.repositoryId === saved.repositoryId && board?.tasks?.some((task) => task.id === row.taskId && task.session) ? "started" : "uncertain") : "interrupted";
            uncertain ||= row.status === "uncertain";
            row.reason = row.action === "start" ? "A previous start has no confirmed outcome. Review the task before another attempt." : "A previous decision was interrupted.";
          }
          if (!TERMINAL.has(saved.status) && uncertain) saved.status = "needs_you";
          if (["active", "needs_you"].includes(saved.status)) saved.summary = uncertain ? "The pilot stopped after an uncertain start. Review its receipts." : "The previous decision was interrupted; the pilot will observe fresh evidence.";
          saved.lastFingerprint = null;
          saved.lastRoundAt = iso();
          saved.nextWakeAt = uncertain ? null : new Date(date().getTime() + saved.minIntervalMinutes * 60_000).toISOString();
          saved.waiting = uncertain ? null : "Waiting after an interrupted decision.";
        }, isAuthorized);
        if (!result.ok) return false;
      }
      return true;
    })();
    if (!grantIds) recovery = pendingRecovery;
    try {
      const result = await pendingRecovery;
      if (!result && !grantIds && recovery === pendingRecovery) recovery = null;
      return result;
    } catch (error) {
      if (!grantIds && recovery === pendingRecovery) recovery = null;
      throw error;
    }
  }

  async function expire(isAuthorized = async () => true) {
    const state = await store.read();
    if (!state) return false;
    for (const grant of state.grants) if (!TERMINAL.has(grant.status) && atMs(grant.expiresAt) <= date().getTime()) {
      const result = await change(grant.id, (saved) => { saved.status = "expired"; saved.summary = "The authorization expired."; saved.waiting = null; saved.nextWakeAt = null; }, isAuthorized);
      if (!result.ok) return false;
    }
    return true;
  }

  async function read(repositoryId) {
    if (typeof repositoryId !== "string" || !PILOT_REPOSITORY.test(repositoryId)) return { ok: false, error: "invalid" };
    if (!await recover()) return { ok: false, error: "unavailable" };
    await expire();
    const state = await store.read();
    if (!state) return { ok: false, error: "unavailable" };
    const latest = latestFor(state, repositoryId);
    return { ok: true, pilot: pilotProjection(latest), history: state.grants.filter((grant) => grant.repositoryId === repositoryId && grant.id !== latest?.id).map(pilotProjection).reverse() };
  }

  async function activate(payload, isAuthorized = async () => true) {
    const spec = activation(payload);
    if (!spec) return { ok: false, error: "invalid" };
    if (!await isAuthorized()) return { ok: false, error: "conflict" };
    if (!await recover(null, isAuthorized)) return { ok: false, error: await isAuthorized() ? "unavailable" : "conflict" };
    if (!await expire(isAuthorized)) return { ok: false, error: await isAuthorized() ? "unavailable" : "conflict" };
    let board;
    try { board = await options.readBoard(spec.repositoryId); } catch { return { ok: false, error: "unavailable" }; }
    if (board?.repositoryId !== spec.repositoryId || board?.readiness !== "ready" || !Array.isArray(board.tasks)) return { ok: false, error: "unavailable" };
    if (spec.taskIds.some((id) => !board.tasks.some((task) => task.id === id))) return { ok: false, error: "invalid" };
    const { durationHours, ...authorization } = spec;
    const grant = {
      ...authorization, id: `pilot-${randomBytes(12).toString("hex")}`, revision: 1, status: "active", expiresAt: new Date(date().getTime() + durationHours * 3_600_000).toISOString(),
      roundsUsed: 0, startsUsed: 0, nextWakeAt: iso(), waiting: null, receipts: [], summary: "The pilot is watching the authorized tasks.", lastFingerprint: null, lastRoundAt: null, resetRequired: {}, wakeConsumed: null, waitDeadline: null,
    };
    return store.update((state) => {
      if (state.grants.some((entry) => entry.repositoryId === spec.repositoryId && !TERMINAL.has(entry.status))) return { ok: false, error: "conflict" };
      if (state.grants.length >= PILOT_HISTORY_LIMIT) return { ok: false, error: "limit" };
      // A new grant is not a retry mechanism for an old uncertain or completed attempt.
      if (state.grants.some((entry) => entry.repositoryId === spec.repositoryId && entry.receipts.some((row) => row.action === "start" && ["pending", "started", "uncertain"].includes(row.status) && spec.taskIds.includes(row.taskId)
        && !ownerRequeuedAfter(board.tasks.find((task) => task.id === row.taskId), row)))) return { ok: false, error: "conflict" };
      state.grants.push(grant);
      return { pilot: pilotProjection(grant) };
    }, isAuthorized);
  }

  async function control(repositoryId, status, isAuthorized = async () => true) {
    if (!PILOT_REPOSITORY.test(repositoryId)) return { ok: false, error: "invalid" };
    if (!await isAuthorized()) return { ok: false, error: "conflict" };
    if (!await recover(null, isAuthorized)) return { ok: false, error: await isAuthorized() ? "unavailable" : "conflict" };
    const state = await store.read();
    if (!state) return { ok: false, error: "unavailable" };
    const grant = latestFor(state, repositoryId);
    if (!grant || TERMINAL.has(grant.status)) return { ok: false, error: "conflict" };
    return change(grant.id, (saved) => {
      if (TERMINAL.has(saved.status)) return { ok: false, error: "conflict" };
      saved.status = status; saved.nextWakeAt = null; saved.waiting = null;
      saved.summary = status === "paused" ? "The owner paused the pilot." : "The owner revoked this authorization.";
    }, isAuthorized);
  }

  async function authorized(id, revision, { allowReserved = false } = {}) {
    if (disposed) return null;
    const state = await store.read();
    const grant = state?.grants.find((entry) => entry.id === id);
    return grant && grant.revision === revision && grant.status === "active" && atMs(grant.expiresAt) > date().getTime()
      && grant.roundsUsed <= grant.roundLimit && (allowReserved ? grant.startsUsed <= grant.startLimit : grant.startsUsed < grant.startLimit) ? grant : null;
  }

  function capacity(grant, board, evidence, provider) {
    const gate = board?.queue?.gates;
    if (gate?.usage?.[provider]?.status !== "ok" || gate?.providerStatus?.[provider] !== "ok") return false;
    if (!options.readUsage) return true; // Integration can rely solely on the monitor gate if no reset feed is configured.
    const row = evidence.usage.find((item) => item.provider === provider);
    if (!row?.ready || !row.available || !row.fetchedAt || row.limits.length === 0) return false;
    if (atMs(row.fetchedAt) > date().getTime() || date().getTime() - atMs(row.fetchedAt) > USAGE_MAX_AGE_MS) return false;
    if (row.limits.some((limit) => (limit.usedPercent === null || limit.usedPercent >= gate.threshold
      || (limit.resetsAt && atMs(limit.resetsAt) <= date().getTime() && atMs(row.fetchedAt) <= atMs(limit.resetsAt))))) return false;
    const required = grant.resetRequired[provider];
    return !required || atMs(row.fetchedAt) > atMs(required);
  }

  async function gather(repositoryId, taskIds) {
    const [board, usage] = await Promise.all([options.readBoard(repositoryId), options.readUsage ? options.readUsage() : null]);
    if (board?.repositoryId !== repositoryId || board?.readiness !== "ready" || !Array.isArray(board.tasks)) return null;
    return { board, evidence: pilotEvidence(board, usage, taskIds) };
  }

  function activeCount(board, grant = null) {
    return pilotRunningTaskIds(board, grant).length;
  }

  async function waitFor(grant, reason, nextWakeAt = null) {
    if (grant.waiting === reason && grant.nextWakeAt === nextWakeAt) return;
    await change(grant.id, (saved) => { if (saved.status === "active") { saved.waiting = reason; saved.summary = reason; saved.nextWakeAt = nextWakeAt; saved.waitDeadline = nextWakeAt; saved.lastFingerprint = null; } });
  }

  function taskCapacityWait(grant, board, evidence) {
    const candidates = board.tasks.filter((task) => grant.taskIds.includes(task.id) && STARTABLE.has(task.state) && !task.session);
    if (!candidates.length) return null;
    const providers = new Set(candidates.flatMap((task) => task.run?.provider ? [task.run.provider] : grant.allowedRuns.map((run) => run.provider)));
    if ([...providers].some((provider) => capacity(grant, board, evidence, provider))) return null;
    // Account observations can change while every permitted task provider remains held.
    // Rechecking those deterministic gates needs no model call and spends no decision round.
    const resets = evidence.usage.filter((row) => providers.has(row.provider)).flatMap((row) => row.limits)
      .filter((limit) => limit.resetsAt && atMs(limit.resetsAt) > date().getTime() && (limit.usedPercent === null || limit.usedPercent >= board.queue.gates.threshold))
      .map((limit) => limit.resetsAt).sort();
    return { nextWakeAt: resets[0] ?? null };
  }

  async function runGrant(grantId) {
    if (disposed) return;
    await expire();
    let state = await store.read();
    let grant = state?.grants.find((entry) => entry.id === grantId);
    if (!grant || grant.status !== "active") return;
    let gathered;
    try { gathered = await gather(grant.repositoryId, grant.taskIds); } catch { return; }
    if (!gathered || disposed) return;
    let { board, evidence } = gathered;
    // Record reset boundaries before asking the normal acquisition path to refresh.
    const now = date().getTime();
    const resets = {};
    for (const row of evidence.usage) for (const limit of row.limits) {
      if (limit.resetsAt && row.fetchedAt && atMs(limit.resetsAt) <= now && atMs(row.fetchedAt) <= atMs(limit.resetsAt)
        && (!grant.resetRequired[row.provider] || atMs(grant.resetRequired[row.provider]) < atMs(limit.resetsAt))
        && (!resets[row.provider] || atMs(resets[row.provider]) < atMs(limit.resetsAt))) resets[row.provider] = limit.resetsAt;
    }
    if (Object.keys(resets).length) {
      const saved = await change(grant.id, (value) => { Object.assign(value.resetRequired, resets); });
      if (!saved.ok) return;
      state = await store.read(); grant = state.grants.find((value) => value.id === grant.id);
      try { await options.refreshUsage?.(); } catch { /* acquisition failures retain the last known evidence */ }
      return;
    }
    // A persisted uncertain start can be reconciled only with a linked session, never by trying again.
    if (grant.receipts.some((row) => row.action === "start" && ["uncertain", "pending"].includes(row.status))) {
      await change(grant.id, (saved) => { saved.status = "needs_you"; saved.summary = "A previous start has no confirmed outcome. Review the task."; saved.nextWakeAt = null; });
      return;
    }
    if (grant.roundsUsed >= grant.roundLimit || grant.startsUsed >= grant.startLimit) {
      const launched = grant.receipts.filter((row) => row.action === "start" && row.status === "started");
      const unsettled = launched.some((row) => { const task = board.tasks.find((entry) => entry.id === row.taskId); return task && !FINISHED_TASK.has(task.state); });
      const outcomes = launched.map((row) => {
        const task = board.tasks.find((entry) => entry.id === row.taskId);
        const checks = (task?.report?.results ?? []).filter((result) => ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"].includes(result?.check) && typeof result.passed === "boolean")
          .map((result) => `${result.check} ${result.unavailable === true ? "unavailable" : result.passed ? "passed" : "failed"}`).join(", ");
        return `${row.taskId}: ${task ? FINISHED_TASK.has(task.state) ? task.state : "running or awaiting session binding" : "removed"}${checks ? ` (${checks})` : ""}`;
      }).join("; ");
      await change(grant.id, (saved) => {
        if (saved.status !== "active") return { ok: false, error: "conflict" };
        saved.status = unsettled ? "active" : "finished";
        saved.summary = `${saved.roundsUsed >= saved.roundLimit ? "Decision" : "Start"} budget exhausted.${outcomes ? ` ${outcomes}` : ""}`.slice(0, 500);
        saved.waiting = unsettled ? "Watching the results of started work without further decisions." : null; saved.nextWakeAt = null;
      }); return;
    }
    if (board.tasks.filter((task) => grant.taskIds.includes(task.id)).every((task) => task.state === "done")) {
      await change(grant.id, (saved) => { saved.status = "finished"; saved.summary = "All authorized tasks are done or removed."; saved.nextWakeAt = null; saved.waiting = null; }); return;
    }
    if (!capacity(grant, board, evidence, grant.inference.provider)) {
      const row = evidence.usage.find((item) => item.provider === grant.inference.provider);
      const reset = row?.limits.filter((limit) => limit.resetsAt && atMs(limit.resetsAt) > now).map((limit) => limit.resetsAt).sort()[0] ?? null;
      await waitFor(grant, "Waiting for fresh provider capacity before another decision.", reset); return;
    }
    if (activeCount(board, grant) >= grant.concurrency) { await waitFor(grant, "Waiting for running work to finish."); return; }
    const taskWait = taskCapacityWait(grant, board, evidence);
    if (taskWait) { await waitFor(grant, "Waiting for fresh capacity for the authorized task providers.", taskWait.nextWakeAt); return; }
    const lastInference = grant.receipts.findLast((row) => row.action === "inference");
    if (lastInference?.status === "failed" && grant.nextWakeAt && atMs(grant.nextWakeAt) > now) return;
    if (grant.nextWakeAt && atMs(grant.nextWakeAt) > now && grant.lastFingerprint === evidence.wakeRevision) return;
    if (grant.lastRoundAt && now - atMs(grant.lastRoundAt) < grant.minIntervalMinutes * 60_000) return;
    const explicitWake = grant.waitDeadline && atMs(grant.waitDeadline) <= now && grant.wakeConsumed !== grant.waitDeadline;
    const scheduleWake = board.tasks.filter((task) => grant.taskIds.includes(task.id) && task.scheduledAt && atMs(task.scheduledAt) <= now && (!grant.lastRoundAt || atMs(task.scheduledAt) > atMs(grant.lastRoundAt))).map((task) => task.scheduledAt).sort().at(-1);
    if ((grant.lastFingerprint === evidence.wakeRevision && !explicitWake && !scheduleWake) || options.isBusy?.()) return;
    const before = grant.revision;
    const reserve = await change(grant.id, (saved) => {
      if (saved.revision !== before || saved.status !== "active" || atMs(saved.expiresAt) <= date().getTime()) return { ok: false, error: "conflict" };
      saved.roundsUsed += 1; saved.lastRoundAt = iso(); saved.lastFingerprint = evidence.wakeRevision;
      if (explicitWake) saved.wakeConsumed = grant.waitDeadline;
      saved.waitDeadline = null;
      saved.waiting = null; saved.nextWakeAt = new Date(date().getTime() + saved.minIntervalMinutes * 60_000).toISOString();
      saved.receipts.push(receipt("inference", "pending", evidence.evidenceRevision, "Decision reserved.", null, saved.inference));
    });
    if (!reserve.ok) return;
    let result;
    try {
      const fresh = await gather(grant.repositoryId, grant.taskIds);
      if (!await authorized(grant.id, reserve.pilot.revision) || !fresh || fresh.evidence.evidenceRevision !== evidence.evidenceRevision || !capacity(grant, fresh.board, fresh.evidence, grant.inference.provider)) result = { status: "busy" };
      else result = await options.decide({ repositoryId: grant.repositoryId, ...grant.inference, prompt: composePilotPrompt({ ...grant, roundsUsed: reserve.pilot.roundsUsed }, fresh.evidence) });
    } catch { result = { status: "failed" }; }
    const decision = result?.status === "complete" ? parsePilotDecision(result.text, evidence.evidenceRevision) : null;
    const settle = await change(grant.id, (saved) => {
      const pending = saved.receipts.findLast((row) => row.action === "inference" && row.status === "pending");
      if (!pending) return { ok: false, error: "conflict" };
      pending.status = result?.status === "busy" ? "busy" : result?.status === "interrupted" ? "interrupted" : decision ? "complete" : "failed";
      pending.reason = decision ? decision.reason : result?.status === "busy" ? "The interactive chat owns the provider slot."
        : result?.status === "complete" ? "The decision response was invalid." : "The decision run did not complete.";
      if (result?.status === "busy") { saved.receipts.splice(saved.receipts.indexOf(pending), 1); saved.roundsUsed -= 1; saved.lastFingerprint = grant.lastFingerprint; saved.lastRoundAt = grant.lastRoundAt; if (saved.status === "active") { saved.nextWakeAt = grant.nextWakeAt; saved.wakeConsumed = grant.wakeConsumed; saved.waitDeadline = grant.waitDeadline; } }
      else if (result?.status === "interrupted" && saved.status === "active") { saved.lastFingerprint = null; saved.waiting = "Waiting after the interactive chat took priority."; saved.summary = saved.waiting; }
      else if (!decision && saved.status === "active") {
        let failures = 0;
        for (const row of saved.receipts.filter((row) => row.action === "inference").reverse()) {
          if (row.status !== "failed") break;
          failures += 1;
        }
        saved.summary = pending.reason;
        if (failures >= 3) { saved.status = "needs_you"; saved.nextWakeAt = null; saved.waiting = null; }
        else {
          saved.waiting = "Waiting before retrying a failed read-only decision.";
          saved.nextWakeAt = new Date(Math.min(atMs(saved.expiresAt), date().getTime() + saved.minIntervalMinutes * 60_000 * failures)).toISOString();
          saved.waitDeadline = saved.nextWakeAt; saved.lastFingerprint = null;
        }
      }
    });
    if (!settle.ok || !decision || disposed) return;
    grant = (await store.read()).grants.find((entry) => entry.id === grant.id);
    if (!await authorized(grant.id, grant.revision)) return;
    if (decision.action !== "start") {
      await change(grant.id, (saved) => {
        if (saved.status !== "active") return { ok: false, error: "conflict" };
        saved.receipts.push(receipt(decision.action, "complete", evidence.evidenceRevision, decision.reason));
        saved.summary = decision.reason;
        if (decision.action === "wait") { saved.waiting = decision.reason; saved.nextWakeAt = new Date(Math.min(atMs(saved.expiresAt), Math.max(date().getTime() + saved.minIntervalMinutes * 60_000, decision.waitUntil ? atMs(decision.waitUntil) : 0))).toISOString(); saved.waitDeadline = decision.waitUntil ? saved.nextWakeAt : null; }
        else { saved.status = decision.action === "finish" ? "finished" : "needs_you"; saved.waiting = null; saved.nextWakeAt = null; }
      }); return;
    }
    // Re-read committed gates and task configuration after inference. No model answer is an authorization.
    try { gathered = await gather(grant.repositoryId, grant.taskIds); } catch { gathered = null; }
    if (!gathered) return;
    ({ board, evidence } = gathered);
    const task = board.tasks.find((entry) => entry.id === decision.taskId);
    const chosen = { provider: decision.provider, model: decision.model };
    const priorAttempt = (await store.read()).grants.some((entry) => entry.repositoryId === grant.repositoryId && entry.receipts.some((row) => row.action === "start" && ["pending", "started", "uncertain"].includes(row.status) && row.taskId === decision.taskId
      && (entry.id === grant.id || !ownerRequeuedAfter(task, row))));
    const configured = task?.run?.provider != null;
    if (!grant.taskIds.includes(decision.taskId) || !task || !STARTABLE.has(task.state) || task.session || priorAttempt || !allowed(grant, chosen)
      || (configured && (task.run.provider !== chosen.provider || task.run.model !== chosen.model)) || activeCount(board, grant) >= grant.concurrency) {
      await change(grant.id, (saved) => { if (saved.status === "active") { saved.status = "needs_you"; saved.summary = "The selected start is no longer authorized or its evidence changed."; saved.nextWakeAt = null; } }); return;
    }
    if (!capacity(grant, board, evidence, chosen.provider) || evidence.evidenceRevision !== decision.evidenceRevision) {
      await waitFor(grant, "Waiting for changed evidence and fresh provider capacity before a start."); return;
    }
    const startReserve = await change(grant.id, (saved) => {
      if (saved.revision !== grant.revision || saved.status !== "active" || atMs(saved.expiresAt) <= date().getTime() || saved.startsUsed >= saved.startLimit) return { ok: false, error: "conflict" };
      saved.startsUsed += 1;
      saved.receipts.push(receipt("start", "pending", decision.evidenceRevision, decision.reason, task.id, chosen));
      saved.summary = "A start is reserved; waiting for its confirmed outcome.";
    });
    if (!startReserve.ok) return;
    const revision = startReserve.pilot.revision;
    const isAuthorized = async (plan) => {
      const authority = await authorized(grant.id, revision, { allowReserved: true });
      if (!authority || !authority.taskIds.includes(task.id) || !allowed(authority, chosen)) return false;
      if (plan && (plan.taskId !== task.id || plan.provider !== chosen.provider || plan.model !== chosen.model || (task.run?.effort != null && plan.effort !== task.run.effort))) return false;
      let fresh;
      try { fresh = await gather(grant.repositoryId, grant.taskIds); } catch { return false; }
      // The current reserved task occupies its own concurrency slot.
      return !!fresh && activeCount(fresh.board, { ...authority, receipts: authority.receipts.filter((row) => !(row.action === "start" && row.taskId === task.id && row.status === "pending")) }) < authority.concurrency && capacity(authority, fresh.board, fresh.evidence, chosen.provider)
        && !!await authorized(grant.id, revision, { allowReserved: true });
    };
    let outcome;
    try {
      if (!await isAuthorized()) outcome = { status: "cancelled" };
      else outcome = await options.starter.startAutonomous(grant.repositoryId, task.id, { isAuthorized, attemptId: `${grant.id}_${task.id}_${grant.roundsUsed}`, expectedUpdatedAt: task.updatedAt, expectedTaskDigest: taskStartRevision(task), expectedRun: clone(task.run), ...(!configured ? { run: chosen } : {}) });
    } catch { outcome = { status: "uncertain" }; }
    await change(grant.id, (saved) => {
      const pending = saved.receipts.findLast((row) => row.action === "start" && row.taskId === task.id && row.status === "pending");
      if (!pending) return { ok: false, error: "conflict" };
      pending.status = outcome?.status === "started" ? "started" : NO_LAUNCH.has(outcome?.status) ? "blocked" : "uncertain";
      pending.reason = pending.status === "started" ? decision.reason : pending.status === "blocked" ? `The start was refused (${outcome.status}); no session was launched.` : "The start has no confirmed outcome. Review the task before another attempt.";
      if (saved.status === "active") saved.summary = pending.reason;
      if (pending.status !== "started" && saved.status === "active") {
        if (pending.status === "blocked" && TRANSIENT_START.has(outcome?.status)) { saved.waiting = "Waiting for changed evidence after a refused start."; saved.nextWakeAt = null; }
        else { saved.status = "needs_you"; saved.nextWakeAt = null; saved.waiting = null; }
      }
    });
  }

  async function runTick() {
    if (disposed || !await recover()) return;
    await expire();
    const state = await store.read();
    if (!state) return;
    const active = state.grants.filter((grant) => grant.status === "active");
    if (!active.length) return;
    const previousIndex = active.findIndex((grant) => grant.id === lastScheduledGrantId);
    const ordered = previousIndex < 0 ? active : [...active.slice(previousIndex + 1), ...active.slice(0, previousIndex + 1)];
    lastScheduledGrantId = ordered[0].id;
    for (const grant of ordered) {
      if (disposed) return;
      try { await runGrant(grant.id); } catch { try { await recover(new Set([grant.id])); } catch { /* preserve the durable receipt for restart recovery */ } }
    }
  }

  function tick() {
    if (running) return running;
    running = runTick().finally(() => { running = null; });
    return running;
  }
  function arm() {
    if (disposed || !started) return;
    timer = setTimer(async () => { timer = null; try { await tick(); } catch { /* no automatic effect retry */ } arm(); }, 15_000);
    timer?.unref?.();
  }
  return Object.freeze({ read, activate, pause: (id, isAuthorized) => control(id, "paused", isAuthorized), revoke: (id, isAuthorized) => control(id, "revoked", isAuthorized), tick,
    start() { if (started || disposed) return; started = true; arm(); },
    dispose() { disposed = true; if (timer !== null) clearTimer(timer); timer = null; },
  });
}

export const createArilPilot = createArilPilotCoordinator;
