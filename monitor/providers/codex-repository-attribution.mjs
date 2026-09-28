import { createHash } from "node:crypto";

/**
 * Bounded per-session repository attribution. A session accumulates proven mutation
 * roots (from bound file-change evidence) until either a single root stands alone
 * (attribution "single") or a second distinct root appears (attribution "multiple",
 * permanent for that session). Both maps are bounded LRUs so a long-running monitor
 * cannot grow this state without limit.
 */
export function createCodexRepositoryAttributionTracker() {
  const attributions = new Map();
  const bindingRoots = new Map();

  function remember(localSessionId, bindings) {
    if (!bindings.size) return get(localSessionId);
    const roots = bindingRoots.get(localSessionId) || new Map();
    for (const [repositoryId, binding] of bindings) {
      if (roots.size >= 2) break; // Two proven roots permanently establish ambiguity.
      roots.set(repositoryId, binding);
    }
    bindingRoots.delete(localSessionId);
    bindingRoots.set(localSessionId, roots);
    while (bindingRoots.size > 128) bindingRoots.delete(bindingRoots.keys().next().value);
    const values = [...roots.values()];
    const attribution = values.length === 1
      ? { state: "single", repositoryId: values[0].repositoryId, root: values[0].root, fingerprint: createHash("sha256").update(values[0].root).digest("hex").slice(0, 32) }
      : { state: "multiple" };
    attributions.delete(localSessionId);
    attributions.set(localSessionId, attribution);
    while (attributions.size > 128) attributions.delete(attributions.keys().next().value);
    return attribution;
  }

  function get(localSessionId) {
    return attributions.get(localSessionId) || { state: "unknown" };
  }

  /** Update an attribution in place, keeping its recency position. */
  function set(localSessionId, attribution) {
    attributions.set(localSessionId, attribution);
  }

  return { remember, get, set };
}
