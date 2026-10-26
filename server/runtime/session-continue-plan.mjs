import path from "node:path";
import { stat } from "node:fs/promises";
import { parseProviderSessionId } from "../providers/provider-contract.mjs";

export async function readSessionContinuePlan(sessionId, observation, registry) {
  const parsed = parseProviderSessionId(sessionId);
  if (!parsed) return null;
  const committed = observation.store.getByQualifiedId(sessionId);
  const identity = observation.coordinator.catalogIdentity(sessionId);
  if (!committed) return identity ? { ok: false, reason: "unknown" } : null;
  const primary = committed.evidence?.agents?.find((agent) => agent.id === "primary");
  // A closed catalog identity means the provider's own process record is gone, so a turn the
  // process left unfinished (for example when its terminal was ended) no longer blocks Continue.
  const closed = identity?.isLive === false && identity.activityStatus === "closed";
  if (identity?.isLive === true || committed.publicState?.session?.isLive === true
    || (!closed && ["active", "waiting", "needs_input", "warm"].includes(primary?.status))) {
    return { ok: false, reason: "live" };
  }
  const historicalClaude = parsed.providerId === "claude" && committed.evidence?.historical === true && !primary?.liveness;
  if (!closed && (identity?.activityStatus === "unknown" || !["idle", "finished", "stopped"].includes(primary?.status)
    || (!historicalClaude && primary?.liveness?.freshness !== "current"))) {
    return { ok: false, reason: "unknown" };
  }
  const recordedCwd = committed.evidence?.session?.cwd;
  if (typeof recordedCwd !== "string" || !path.isAbsolute(recordedCwd) || /[\u0000-\u001f\u007f]/u.test(recordedCwd)) {
    return { ok: false, reason: "folder_missing" };
  }
  const cwd = path.resolve(recordedCwd);
  if (!await stat(cwd).then((value) => value.isDirectory(), () => false)) return { ok: false, reason: "folder_missing" };
  const provider = registry.providerForSessionId(sessionId);
  if (typeof provider?.peekSessionSource !== "function") return undefined;
  const source = provider.peekSessionSource(parsed.localSessionId);
  if (typeof source !== "string" || !path.isAbsolute(source)
    || !await stat(source).then((value) => value.isFile(), () => false)) return { ok: false, reason: "history_missing" };
  const title = typeof committed.evidence.session.title === "string"
    ? committed.evidence.session.title.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160) : "";
  return { ok: true, plan: { provider: parsed.providerId, sessionId, localId: parsed.localSessionId, cwd, title } };
}
