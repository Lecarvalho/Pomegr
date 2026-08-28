function boundedRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

/**
 * Provider-neutral L1 response cache. Derivation commits one complete immutable
 * value; Serving reuses the exact serialized representation for that revision.
 */
export function createCommittedResponseCache(options = {}) {
  const serialize = options.serialize || JSON.stringify;
  const clone = options.clone || structuredClone;
  const includeRevision = options.includeRevision === true;
  const now = options.now || (() => Date.now());
  let committed = null;
  let revision = boundedRevision(options.initialRevision) || 0;

  function commit(value, commitOptions = {}) {
    const nextRevision = boundedRevision(commitOptions.revision);
    const committedRevision = nextRevision !== null && nextRevision > revision ? nextRevision : revision + 1;
    const cloned = clone(value);
    const revisionedValue = includeRevision && cloned && typeof cloned === "object" && !Array.isArray(cloned)
      ? { ...cloned, revision: committedRevision }
      : cloned;
    const frozenValue = freeze(revisionedValue);
    const serialized = serialize(frozenValue);
    if (typeof serialized !== "string") throw new TypeError("Committed response serialization must return a string");
    const candidate = Object.freeze({
      revision: committedRevision,
      value: frozenValue,
      serialized,
      committedAt: new Date(commitOptions.observedAt ?? now()).toISOString(),
    });
    revision = committedRevision;
    committed = candidate;
    return committed;
  }

  function read(currentRevision = null) {
    if (!committed) return Object.freeze({ status: "empty", revision: 0, snapshot: null });
    return Object.freeze({
      status: boundedRevision(currentRevision) === committed.revision ? "unchanged" : "ready",
      revision: committed.revision,
      snapshot: committed,
    });
  }

  return Object.freeze({
    commit,
    read,
    current: () => committed,
    clear: () => { committed = null; },
  });
}
