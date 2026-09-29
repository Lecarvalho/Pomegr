import { parseProviderSessionId } from "../../providers/provider-contract.mjs";
import { qualifiedSessionId } from "../catalog/session-catalog-runtime.mjs";

const MAX_ON_DEMAND_RESTORES = 256;

/**
 * Owns the startup L2 restore window. The bulk pass loads every valid checkpoint;
 * while it runs, a requested session that is not yet in the store may restore its
 * own checkpoint first by reading the one identity-keyed file. Both paths apply a
 * record through the same coordinator hook, so validation, lifecycle downgrade,
 * revision preservation and fresh-candidate precedence are identical. Each identity
 * is read on demand at most once per window, and the bulk pass skips any identity
 * the on-demand path has claimed, so a record is never restored twice and a later
 * bulk pass cannot replace a newer committed revision.
 */
export function createCheckpointRestore({ checkpointStore, ready, projectState, apply, maxOnDemand = MAX_ON_DEMAND_RESTORES }) {
  if (typeof apply !== "function" || typeof projectState !== "function") {
    throw new TypeError("checkpoint restore requires apply and projectState hooks");
  }
  let active = null;

  async function waitReady(window) {
    const pending = ready?.();
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

  /**
   * Start one on-demand restore for a qualified session ID. Returns false when no
   * restore window is open, the identity was already tried in this window, or the
   * bound is reached; the caller then keeps its ordinary hydration path. Returns
   * true while a load is pending; only the call that started it gets `onSettled`
   * with whether the record committed.
   */
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
      if (!(await waitReady(window))) return false;
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
