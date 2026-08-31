import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { createEmptyProviderStatusSnapshot, PROVIDER_STATUS_SOURCES, PROVIDER_STATUS_STALE_MS } from "../shared/provider-status.mjs";

const NORMAL_INTERVAL_MS = 5 * 60_000;
const INCIDENT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000];
const text = z.string().min(1).max(200).refine((value) => !/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value));
const timestamp = z.iso.datetime({ offset: true }).nullable();
const candidateSchema = z.strictObject({
  status: z.enum(["operational", "degraded", "outage", "maintenance", "unknown"]),
  updatedAt: timestamp,
  incidents: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
    label: text,
    status: z.enum(["investigating", "identified", "monitoring", "maintenance"]),
    impact: z.enum(["none", "minor", "major", "critical"]),
    updatedAt: timestamp,
    url: z.string().max(300),
  })).max(8),
});

function validatedCandidate(value, source) {
  const candidate = candidateSchema.parse(value);
  const ids = new Set();
  for (const incident of candidate.incidents) {
    const url = new URL(incident.url);
    if (url.origin !== new URL(source.statusPageUrl).origin || url.username || url.password
      || url.search || url.hash || !/^\/incidents\/[a-zA-Z0-9_-]+\/?$/u.test(url.pathname)
      || ids.has(incident.id)) throw new TypeError("Invalid normalized provider status");
    ids.add(incident.id);
  }
  if (["operational", "unknown"].includes(candidate.status) && candidate.incidents.length) {
    throw new TypeError("Inconsistent normalized provider status");
  }
  return candidate;
}

/** Independent U1/U2 -> C/D -> S service domain; no transcript work or persistence. */
export function createProviderStatusObservation({
  readStatus,
  now = Date.now,
  schedule = (task, delay) => setTimeout(task, delay),
  cancel = clearTimeout,
  random = Math.random,
} = {}) {
  const cache = createCommittedResponseCache({ includeRevision: true, now });
  const jobs = new Map();
  let rows = createEmptyProviderStatusSnapshot().providers;
  let active = false;
  let generation = 0;

  function publish(provider, row) {
    const previous = rows.find((entry) => entry.provider === provider);
    if (JSON.stringify(previous) === JSON.stringify(row)) return;
    rows = rows.map((entry) => entry.provider === provider ? row : entry);
    cache.commit({ generatedAt: new Date(now()).toISOString(), providers: rows });
  }

  function queue(provider, delay) {
    if (!active) return;
    const job = jobs.get(provider);
    if (job.timer !== null) cancel(job.timer);
    // Spread installations without changing the published polling policy materially.
    const jittered = Math.round(delay * (0.9 + random() * 0.2));
    job.timer = schedule(() => { job.timer = null; void refresh(provider); }, jittered);
    job.timer?.unref?.();
  }

  function scheduleStale(provider, checkedAt) {
    const job = jobs.get(provider);
    if (job.staleTimer !== null) cancel(job.staleTimer);
    job.staleTimer = schedule(() => {
      job.staleTimer = null;
      if (!active) return;
      const row = rows.find((entry) => entry.provider === provider);
      if (row.checkedAt === checkedAt) publish(provider, { ...row, freshness: "stale" });
    }, Math.max(0, Date.parse(checkedAt) + PROVIDER_STATUS_STALE_MS - now()));
    job.staleTimer?.unref?.();
  }

  function refresh(provider) {
    const job = jobs.get(provider);
    if (!active || job.inFlight) return job?.inFlight;
    const startedGeneration = generation;
    const source = PROVIDER_STATUS_SOURCES.find((entry) => entry.provider === provider);
    const controller = new AbortController();
    job.controller = controller;
    const timeout = schedule(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout?.unref?.();
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Provider status request cancelled")), { once: true });
    });
    const work = (async () => {
      let delay = NORMAL_INTERVAL_MS;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => readStatus(provider, { signal: controller.signal })),
          aborted,
        ]);
        if (!active || generation !== startedGeneration || controller.signal.aborted) return;
        const candidate = validatedCandidate(value, source);
        const previous = rows.find((entry) => entry.provider === provider);
        const hasIssue = !["operational", "unknown"].includes(candidate.status);
        const previousIds = new Set(previous.incidents.map((entry) => entry.id));
        const hasNewIncident = candidate.incidents.some((entry) => !previousIds.has(entry.id));
        const checkedAt = new Date(now()).toISOString();
        publish(provider, {
          ...source,
          ...candidate,
          readiness: "ready",
          freshness: "fresh",
          checkedAt,
          incidentKey: hasIssue ? previous.incidentKey && !hasNewIncident ? previous.incidentKey : randomUUID() : null,
        });
        scheduleStale(provider, checkedAt);
        job.failures = 0;
        delay = hasIssue ? INCIDENT_INTERVAL_MS : NORMAL_INTERVAL_MS;
      } catch {
        if (!active || generation !== startedGeneration) return;
        const previous = rows.find((entry) => entry.provider === provider);
        publish(provider, {
          ...previous,
          readiness: "unavailable",
          freshness: previous.checkedAt
            ? now() - Date.parse(previous.checkedAt) >= PROVIDER_STATUS_STALE_MS ? "stale" : "fresh"
            : "unknown",
        });
        delay = RETRY_DELAYS_MS[job.failures];
        job.failures = Math.min(job.failures + 1, RETRY_DELAYS_MS.length - 1);
      } finally {
        cancel(timeout);
        if (job.controller === controller) job.controller = null;
        if (generation === startedGeneration) {
          job.inFlight = null;
          if (active) queue(provider, delay);
        }
      }
    })();
    job.inFlight = work;
    return work;
  }

  function start() {
    if (active) return;
    active = true;
    generation += 1;
    rows = createEmptyProviderStatusSnapshot().providers;
    cache.commit({ generatedAt: null, providers: rows });
    for (const { provider } of PROVIDER_STATUS_SOURCES) {
      jobs.set(provider, { timer: null, staleTimer: null, inFlight: null, controller: null, failures: 0 });
      void refresh(provider);
    }
  }

  async function stop() {
    active = false;
    generation += 1;
    const pending = [];
    for (const job of jobs.values()) {
      if (job.timer !== null) cancel(job.timer);
      if (job.staleTimer !== null) cancel(job.staleTimer);
      job.controller?.abort();
      if (job.inFlight) pending.push(job.inFlight);
    }
    await Promise.allSettled(pending);
  }

  return Object.freeze({ start, stop, read: (revision) => cache.read(revision) });
}
