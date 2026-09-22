import { useEffect, useRef, useState } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { stateEndpoint } from "../../dashboard-utils";
import { subscribeLiveEvents } from "../../live-events";

// One commit publishes a revision event per session domain; a short settle folds that burst into
// one composed-state poll instead of a poll per domain.
const REVISION_BURST_SETTLE_MS = 100;

/**
 * Composed `/api/state` polling for transitional session tabs. Callers key their component on
 * sessionId, so a session change remounts and resets `state`/`error`/refs instead of reusing them;
 * the previous instance's cleanup (abort controller, clear timer, unsubscribe) still runs before the
 * fresh one mounts and issues its own revision-less request.
 */
export function useTransitionalSessionState({ sessionId, historical, paused }: { sessionId: string; historical: boolean; paused: boolean }) {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState(false);
  const revision = useRef<number | string | null>(null);
  const retainedState = useRef<MonitorState | null>(null);
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let timer: number | null = null;
    let inFlight = false;
    let refreshAfterFlight = false;
    let reconnecting = false;
    let initialConnection = true;
    const schedule = (delay: number, options: { force?: boolean } = {}) => {
      if ((historical && !options.force) || controller.signal.aborted) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void poll(); }, delay);
    };
    const poll = async () => {
      if (inFlight) { refreshAfterFlight = true; return; }
      inFlight = true;
      let unresolved = retainedState.current === null || Object.values(retainedState.current.readiness || {}).includes("loading");
      let succeeded = false;
      try {
        const response = await fetch(stateEndpoint(sessionId, revision.current), { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error();
        if (response.status === 204) {
          if (!retainedState.current || revision.current === null) throw new Error();
          unresolved = Object.values(retainedState.current.readiness || {}).includes("loading");
        } else {
          const value = await response.json() as MonitorState;
          if (controller.signal.aborted) return;
          // The monitor serves a well-formed "still loading" placeholder (no session yet,
          // readiness.core: "loading") the first time this session's legacy full state is
          // requested, for example on a cold hard navigation before hydration completes. That
          // placeholder carries no session to check against and is not a failure, so it must not
          // be treated the same as a genuinely wrong or stale response: only a body that claims a
          // *different* session is invalid.
          if (value.session === null && value.readiness?.core === "loading") {
            // A well-formed loading placeholder is only valid for the requested session: one
            // whose catalogIdentity names a different session is a wrong-session response, not
            // an unresolved cold start, and must be rejected the same as a session mismatch below.
            if (value.catalogIdentity && value.catalogIdentity.id !== sessionId) throw new Error();
            unresolved = true;
          } else {
            if (value.session?.id !== sessionId) throw new Error();
            revision.current = value.revision ?? response.headers.get("x-pomegr-revision");
            unresolved = Object.values(value.readiness || {}).includes("loading");
            retainedState.current = value;
            setState(value);
          }
        }
        setError(false);
        succeeded = true;
      } catch { if (!controller.signal.aborted) setError(true); }
      finally {
        inFlight = false;
        if (controller.signal.aborted) return;
        if (refreshAfterFlight) { refreshAfterFlight = false; void poll(); return; }
        if (historical) {
          // A historical session has no live revision events to rely on, so an unresolved
          // placeholder or a failed poll must retry itself; once a poll fully resolves, no
          // further timer is scheduled. Mirrors the browser store's historical retry cadence.
          if (unresolved || !succeeded) schedule(document.hidden ? 30_000 : 5_000, { force: true });
          return;
        }
        schedule(document.hidden ? 30_000 : unresolved ? 1_000 : !succeeded || reconnecting ? 5_000 : 30_000);
      }
    };
    const foreground = () => { if (!document.hidden) void poll(); };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    const release = subscribeLiveEvents((event) => {
      if (event.type === "connection") {
        reconnecting = event.state === "reconnecting";
        if (initialConnection) { initialConnection = false; return; }
        if (timer !== null) { window.clearTimeout(timer); timer = null; }
        if (event.state === "connected" && !document.hidden) void poll();
        else schedule(document.hidden ? 30_000 : 5_000);
        return;
      }
      if (event.sessionId !== sessionId || document.hidden) return;
      if (inFlight) refreshAfterFlight = true;
      else schedule(REVISION_BURST_SETTLE_MS, { force: true });
    });
    void poll();
    return () => { controller.abort(); if (timer !== null) window.clearTimeout(timer); release(); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [historical, paused, sessionId]);
  return { state, error };
}
