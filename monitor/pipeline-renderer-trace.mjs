import { normalizeRendererTracePayload } from "../shared/renderer-trace-contract.mjs";
import { randomBytes } from "node:crypto";

const MAX_REVISIONS = 128;
const MAX_TOKEN_AGE_MS = 5_000;
const MIN_CLOCK_ERROR_US = 1_000;

/** Monitor-private capture-local revision tokens for renderer timing. */
export function createPipelineRendererTraceBridge({ recorder, maxRevisions = MAX_REVISIONS, nonce = null } = {}) {
  if (!recorder || typeof recorder.isActive !== "function" || typeof recorder.createRevision !== "function") {
    throw new TypeError("Renderer trace bridge requires a recorder");
  }
  const limit = Number.isInteger(maxRevisions) && maxRevisions >= 1 && maxRevisions <= 512 ? maxRevisions : MAX_REVISIONS;
  const captureNonce = typeof nonce === "string" && /^[a-f0-9]{16}$/u.test(nonce) ? nonce : randomBytes(8).toString("hex");
  const revisions = new Map();
  let active = false;
  let epoch = null;
  let nextToken = 1;

  function synchronize() {
    const nextActive = recorder.isActive();
    const nextEpoch = typeof recorder.captureEpoch === "function" ? recorder.captureEpoch() : null;
    if (nextActive !== active || nextEpoch !== epoch) revisions.clear();
    active = nextActive;
    epoch = nextEpoch;
    return active;
  }

  return Object.freeze({
    /** Called only by the monitor when it serves a committed revision. */
    issueRevision(domain) {
      if (!synchronize() || !["catalog", "activity", "requests"].includes(domain)) return null;
      if (revisions.size >= limit) revisions.delete(revisions.keys().next().value);
      const handle = recorder.createRevision();
      if (!handle) return null;
      const token = `r${captureNonce}_${nextToken++}`;
      const issuedAt = recorder.monotonicNow?.();
      if (!Number.isFinite(issuedAt)) return null;
      revisions.set(token, Object.freeze({ domain, handle, issuedAt }));
      // This zero-length point marks the committed cache response that minted
      // the revision handle. It joins renderer spans without exporting a token.
      recorder.recordDuration?.({ stage: "cache_serve", domain: "serving", revision: handle, durationMs: 0, startedAt: issuedAt,
        outcome: "accepted", surface: domain });
      return token;
    },
    record(value) {
      if (!synchronize()) return false;
      const payload = normalizeRendererTracePayload(value);
      if (!payload || !payload.records.length) {
        recorder.noteRendererCalibrationRejected?.();
        return false;
      }
      const token = payload.records[0].token;
      const revision = revisions.get(token);
      const receivedAt = Number(recorder.monotonicNow?.());
      const elapsedMs = receivedAt - Number(revision?.issuedAt);
      const intervalMs = payload.calibration.responseReceivedMs - payload.calibration.requestStartedMs;
      if (!revision || payload.records.some((entry) => entry.token !== token || entry.domain !== revision.domain)
        || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_TOKEN_AGE_MS || !Number.isFinite(intervalMs)) {
        recorder.noteRendererCalibrationRejected?.();
        return false;
      }
      const midpointMs = payload.calibration.requestStartedMs + intervalMs / 2;
      const clockErrorUs = Math.min(1_001_000, MIN_CLOCK_ERROR_US + Math.ceil(intervalMs * 500));
      const clockErrorMs = clockErrorUs / 1_000;
      if (payload.records.some((entry) => revision.issuedAt + (entry.endedAtMs - midpointMs) - clockErrorMs > receivedAt)) {
        recorder.noteRendererCalibrationRejected?.();
        return false;
      }
      let accepted = false;
      for (const entry of payload.records) {
        const backendStartedAt = revision.issuedAt + (entry.startedAtMs - midpointMs);
        accepted = recorder.recordDuration({
          stage: entry.stage, domain: "presentation", revision: revision.handle,
          durationMs: entry.durationMs, startedAt: backendStartedAt, outcome: "observed",
          clock: "request_interval_bound", clockErrorUs, surface: revision.domain,
        }) || accepted;
      }
      return accepted;
    },
    clear() { revisions.clear(); active = recorder.isActive(); },
  });
}
