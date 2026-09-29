const QUALIFIED_SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

/**
 * Keep the normalized-session-to-recorder association only in the development
 * composition. Recorder APIs receive opaque scopes, never session identifiers.
 */
export function createDevelopmentTraceScopeRegistry({ createScope, now = () => performance.now(), maxEntries = 1_024, ttlMs = 300_000 } = {}) {
  if (typeof createScope !== "function") throw new TypeError("Development trace scopes require a recorder scope factory");
  const limit = Number.isInteger(maxEntries) && maxEntries >= 1 && maxEntries <= 1_024 ? maxEntries : 1_024;
  const lifetime = Number.isInteger(ttlMs) && ttlMs >= 1_000 && ttlMs <= 300_000 ? ttlMs : 300_000;
  const entries = new Map();
  const unmatched = createScope();

  function prune(observedAt) {
    for (const [key, entry] of entries) if (entry.expiresAt <= observedAt) entries.delete(key);
  }

  function scopeForSession(qualifiedId) {
    if (typeof qualifiedId !== "string" || !QUALIFIED_SESSION_ID.test(qualifiedId)) return unmatched;
    const observedAt = now();
    prune(observedAt);
    const found = entries.get(qualifiedId);
    if (found) {
      entries.delete(qualifiedId);
      entries.set(qualifiedId, { ...found, expiresAt: observedAt + lifetime });
      return found.scope;
    }
    while (entries.size >= limit) entries.delete(entries.keys().next().value);
    const scope = createScope();
    entries.set(qualifiedId, { scope, expiresAt: observedAt + lifetime });
    return scope;
  }

  function resolveSessionScope(selector) {
    if (typeof selector !== "string" || !QUALIFIED_SESSION_ID.test(selector)) return unmatched;
    const observedAt = now();
    prune(observedAt);
    const found = entries.get(selector);
    return found ? found.scope : unmatched;
  }

  return Object.freeze({ scopeForSession, resolveSessionScope });
}
