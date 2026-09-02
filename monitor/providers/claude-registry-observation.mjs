import { readSessionRegistry } from "../session-registry.mjs";
import { SESSION_REGISTRY_GRACE_MS } from "../session-discovery.mjs";
import { normalizeClaudeSessionRegistryEntry } from "./claude-session-status.mjs";

const MAX_OWNERS = 512;
const DEPARTURE_CHECK_MS = 250;

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "ESRCH" ? false : null; }
}

// U1-only, memory-only ownership evidence. A missing/partial registry entry alone
// is not an exit. Retain validated owners briefly enough to observe actual exit
// after Claude removes its entry, without blocking on another process enumeration.
export function createClaudeRegistryObservation({ root, validateOwners, now = Date.now, ownerExists = processExists }) {
  const owners = new Map();
  const closed = new Set();
  const listeners = new Set();
  const probes = new Map();
  let timer = null;

  function exists(pid) {
    const cached = probes.get(pid);
    if (cached && now() - cached.at < DEPARTURE_CHECK_MS) return cached.value;
    let value = null;
    try { value = ownerExists(pid); } catch { /* Inspection failure is unknown. */ }
    probes.delete(pid);
    probes.set(pid, { at: now(), value });
    while (probes.size > MAX_OWNERS) probes.delete(probes.keys().next().value);
    return value;
  }

  function probeBatch() {
    const results = new Map();
    return (pid) => {
      if (!results.has(pid)) results.set(pid, exists(pid));
      return results.get(pid);
    };
  }

  function schedule() {
    if (timer || !listeners.size || ![...owners.values()].some((owner) => owner.deadline > now())) return;
    timer = setTimeout(() => {
      timer = null;
      const departed = [];
      const probe = probeBatch();
      for (const [id, owner] of owners) {
        if (!owner.deadline) continue;
        if (probe(owner.pid) === false) {
          owner.deadline = 0;
          closed.add(id);
          departed.push(id);
        } else if (owner.deadline <= now()) owner.deadline = 0;
      }
      if (departed.length) for (const notify of listeners) notify(departed);
      schedule();
    }, DEPARTURE_CHECK_MS);
    timer.unref?.();
  }

  function read() {
    const registry = readSessionRegistry(root, {
      normalizeEntry: normalizeClaudeSessionRegistryEntry,
      validateOwners(entries) {
        const validation = validateOwners(entries);
        for (const entry of entries) {
          let current = validation.get(entry.sessionId);
          const previous = owners.get(entry.sessionId);
          const sameOwner = previous?.pid === entry.pid && previous?.procStart === entry.procStart;
          if (current === true && !sameOwner) probes.delete(entry.pid);
          // A cached positive identity cannot undo a later definitive exit for
          // that same owner. A replacement start identity has its own probe cache.
          if (current === true && sameOwner && closed.has(entry.sessionId) && exists(entry.pid) === false) {
            current = false;
            validation.set(entry.sessionId, false);
          }
          if (current === false) closed.add(entry.sessionId);
          if (current !== true && current !== false) continue;
          owners.delete(entry.sessionId);
          owners.set(entry.sessionId, { pid: entry.pid, procStart: entry.procStart, deadline: 0, missing: false });
          if (current === true) closed.delete(entry.sessionId);
        }
        return validation;
      },
    });
    while (owners.size > MAX_OWNERS) {
      const id = owners.keys().next().value;
      owners.delete(id);
      closed.delete(id);
    }
    const probe = probeBatch();
    for (const [id, owner] of owners) {
      if (registry.has(id)) {
        const entry = registry.get(id);
        if (entry.pid !== owner.pid || entry.procStart !== owner.procStart) {
          owners.delete(id);
          closed.delete(id);
          continue;
        }
        owner.missing = false;
        owner.deadline = 0;
      } else if (!closed.has(id)) {
        if (probe(owner.pid) === false) closed.add(id);
        else if (!owner.missing) owner.deadline = now() + SESSION_REGISTRY_GRACE_MS;
        owner.missing = true;
      }
    }
    schedule();
    return { registry, closedSessionIds: closed };
  }

  return {
    read,
    subscribe(notify) {
      listeners.add(notify);
      schedule();
      return () => {
        listeners.delete(notify);
        if (!listeners.size) { clearTimeout(timer); timer = null; }
      };
    },
  };
}

export function observeClaudeRegistryDepartures(observer, ...sources) {
  let cleanup = () => {};
  return {
    ...observer,
    async start(publisher, signal) {
      cleanup();
      const unsubscribes = sources.flatMap((source) => {
        if (typeof source?.subscribe !== "function") return [];
        return [source.subscribe((sessionIds) => {
          void observer.refresh({ fresh: true, sessionIds: Array.isArray(sessionIds) ? sessionIds : [] }).catch(() => {});
        })];
      });
      cleanup = () => {
        for (const unsubscribe of unsubscribes) {
          try { unsubscribe(); } catch { /* Observer shutdown remains best-effort. */ }
        }
        signal?.removeEventListener("abort", cleanup);
      };
      if (signal?.aborted) cleanup();
      else signal?.addEventListener("abort", cleanup, { once: true });
      try { return await observer.start(publisher, signal); }
      catch (error) { cleanup(); throw error; }
    },
    stop() { cleanup(); observer.stop(); },
  };
}
