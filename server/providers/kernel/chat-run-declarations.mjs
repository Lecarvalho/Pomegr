// Pomegr's own agent chat runs, which desktop main declares for the length of one turn. A declared run is never a
// session: an adapter drops a native registration whose session ID is declared before anything reads it. The
// declaration holds the session ID that desktop main gave the run and an expiry, in memory only: no path, no token,
// no text. It expires on its own, so a desktop that dies mid-turn hides nothing for longer than one turn could last.

export const CHAT_RUN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The chat's turn timeout (10 minutes) and one minute for the run to exit after it.
export const CHAT_RUN_DECLARATION_MS = 11 * 60_000;
// One turn runs at a time; the rest is room for a withdrawal that never arrived.
export const CHAT_RUN_DECLARATION_LIMIT = 8;

export function createChatRunDeclarations({ now = () => Date.now(), ttlMs = CHAT_RUN_DECLARATION_MS } = {}) {
  const expiries = new Map();
  function prune() {
    const at = now();
    for (const [sessionId, expiry] of expiries) if (expiry <= at) expiries.delete(sessionId);
  }
  return Object.freeze({
    declare(sessionId) {
      if (typeof sessionId !== "string" || !CHAT_RUN_SESSION_ID.test(sessionId)) return false;
      prune();
      expiries.delete(sessionId);
      if (expiries.size >= CHAT_RUN_DECLARATION_LIMIT) expiries.delete(expiries.keys().next().value);
      expiries.set(sessionId, now() + ttlMs);
      return true;
    },
    withdraw(sessionId) {
      if (typeof sessionId !== "string" || !CHAT_RUN_SESSION_ID.test(sessionId)) return false;
      expiries.delete(sessionId);
      return true;
    },
    has(sessionId) {
      const expiry = expiries.get(sessionId);
      if (expiry === undefined) return false;
      if (expiry > now()) return true;
      expiries.delete(sessionId);
      return false;
    },
  });
}

// The monitor's one set: desktop main declares into it, and the adapters read it.
export const chatRunDeclarations = createChatRunDeclarations();
