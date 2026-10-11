
import crypto from "node:crypto";

export const RECENT_ADD_WINDOW_MS = 5 * 60 * 1000;
export const RECENT_ADD_LIMIT = 256;

export function recentAddKey(repositoryId, sessionId, text, featureId) {
  return crypto.createHash("sha256").update(JSON.stringify([repositoryId, sessionId, text, featureId ?? null])).digest("hex");
}

export function createRecentAdds({ now = Date.now, windowMs = RECENT_ADD_WINDOW_MS, limit = RECENT_ADD_LIMIT } = {}) {
  const entries = new Map();
  const fresh = (entry, at) => at - entry.at >= 0 && at - entry.at < windowMs;

  function find(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (fresh(entry, now())) return entry.number;
    entries.delete(key);
    return null;
  }

  // The window counts from the add itself; a repeated call never extends it.
  function remember(key, number) {
    const at = now();
    for (const [existing, entry] of entries) if (!fresh(entry, at)) entries.delete(existing);
    entries.delete(key);
    while (entries.size >= limit) entries.delete(entries.keys().next().value);
    entries.set(key, { number, at });
  }

  const forget = (key) => { entries.delete(key); };

  return { find, remember, forget, get size() { return entries.size; } };
}
