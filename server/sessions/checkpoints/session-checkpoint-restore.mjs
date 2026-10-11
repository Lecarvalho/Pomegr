import { parseProviderSessionId } from "../../providers/provider-contract.mjs";
import { qualifiedSessionId } from "../catalog/session-catalog-runtime.mjs";

const MAX_ON_DEMAND_RESTORES = 256;

export function createCheckpointRestore({ checkpointStore, ready, projectState, apply, maxOnDemand = MAX_ON_DEMAND_RESTORES }) {
  if (typeof apply !== "function" || typeof projectState !== "function") {
    throw new TypeError("checkpoint restore requires apply and projectState hooks");
  }
  let active = null;

  async function waitReady(window, id) {
    const pending = ready?.(id);
    if (pending) await pending;
    return window.isCurrent();
  }

  async function bulk({ isCurrent, freshSessions }) {
    const window = { isCurrent, freshSessions, onDemand: new Map() };
    active = window;
    try {
      if (!checkpointStore) return;
      // Inline (not waitReady) so an already-ready restore keeps its original microtask order.
      const pending = ready?.();
      if (pending) await pending;
      if (!window.isCurrent()) return;
      const loaded = await checkpointStore.load({ includeRecord: () => true, projectState });
      if (!window.isCurrent()) return;
      for (const record of loaded.records) {
        if (window.onDemand.has(qualifiedSessionId(record.providerId, record.localSessionId))) continue;
        apply(record, freshSessions);
      }
    } finally {
      if (active === window) active = null;
    }
  }

  function request(qualifiedId, onSettled) {
    const window = active;
    const parsed = typeof qualifiedId === "string" ? parseProviderSessionId(qualifiedId) : null;
    if (!window || !parsed || typeof checkpointStore?.loadOne !== "function" || !window.isCurrent()) return false;
    const id = qualifiedSessionId(parsed.providerId, parsed.localSessionId);
    const existing = window.onDemand.get(id);
    if (existing) return existing.state === "pending";
    if (window.onDemand.size >= maxOnDemand) return false;
    const entry = { state: "pending" };
    window.onDemand.set(id, entry);
    void (async () => {
      if (!(await waitReady(window, id))) return false;
      const record = await checkpointStore.loadOne(parsed.providerId, parsed.localSessionId, { projectState });
      if (!record || !window.isCurrent()) return false;
      return apply(record, window.freshSessions) === true;
    })().catch(() => false).then((restored) => {
      entry.state = restored ? "restored" : "absent";
      try { onSettled?.(restored); } catch { /* a consumer cannot fail the restore */ }
    });
    return true;
  }

  return Object.freeze({ bulk, request, active: () => active !== null });
}
