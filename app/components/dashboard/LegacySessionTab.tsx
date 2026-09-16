"use client";

import { useEffect, useRef, useState } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { stateEndpoint } from "../../dashboard-utils";
import { subscribeLiveEvents } from "../../live-events";
import { RepositoryDisclosurePanel } from "./RepositoryDisclosurePanel";
import { ResourceUsagePanel } from "./ResourceUsagePanel";
import { SessionDetailsPanel } from "./SessionDetailsPanel";
import { RequestsActionsPanel } from "./RequestsActionsPanel";
import { ActivityPanel } from "./ActivityPanel";
import { CacheEvidenceDisclosure } from "./CacheEvidenceDisclosure";
import { InsightsPanel } from "./InsightsPanel";
import { useSessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import type { SessionTab } from "./session-route";

export function LegacySessionTab({ tab, sessionId, historical, paused, showEstimatedCost, onNavigateAgent }: { tab: Exclude<SessionTab, "overview" | "agents">; sessionId: string; historical: boolean; paused: boolean; showEstimatedCost: boolean; onNavigateAgent: (agentId: string) => void }) {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const revision = useRef<number | string | null>(null);
  const retainedState = useRef<MonitorState | null>(null);
  useEffect(() => {
    revision.current = null;
    retainedState.current = null;
    setState(null);
    setError(false);
  }, [sessionId]);
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let timer: number | null = null;
    let inFlight = false;
    let refreshAfterFlight = false;
    let reconnecting = false;
    let initialConnection = true;
    const schedule = (delay: number) => {
      if (historical || controller.signal.aborted) return;
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
      void poll();
    });
    void poll();
    return () => { controller.abort(); if (timer !== null) window.clearTimeout(timer); release(); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [historical, paused, sessionId, refreshRequest]);
  const visibleState = state?.session?.id === sessionId ? state : null;
  if (!visibleState) return <div className="sessionTabState">{error ? "This session panel is temporarily unavailable." : `Loading ${tab}…`}</div>;
  const notice = error ? <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded panel state.</div> : null;
  if (tab === "activities") return <>{notice}<LegacyActivities state={visibleState} historical={historical} paused={paused} onRefresh={() => setRefreshRequest((value) => value + 1)} /></>;
  if (tab === "signals") return <>{notice}<LegacySignals state={visibleState} historical={historical} paused={paused} onNavigateAgent={onNavigateAgent} /></>;
  if (tab === "repository" && visibleState.session) return <>{notice}<RepositoryDisclosurePanel session={visibleState.session} historical={historical} /></>;
  if (tab === "resources") return <>{notice}<ResourceUsagePanel resources={visibleState.metrics.resources || undefined} /></>;
  if (tab === "details") return <>{notice}<SessionDetailsPanel state={visibleState} historical={historical} showEstimatedCost={showEstimatedCost} /></>;
  return null;
}

function useLegacySelection(state: MonitorState, historical: boolean, enabled: boolean) {
  return useSessionRequestSelection({
    historyEnabled: enabled, sessionId: state.session?.id, agents: state.agents,
    requestSnapshots: state.metrics.tokens.requestSnapshots,
    contextBoundaries: state.metrics.tokens.contextHistory.boundaries,
    historical, cacheEvents: state.metrics.tokens.cacheEvents, cacheReadDrops: state.metrics.tokens.cacheReadDrops,
  });
}

function LegacyActivities({ state, historical, paused, onRefresh }: { state: MonitorState; historical: boolean; paused: boolean; onRefresh: () => void }) {
  const selection = useLegacySelection(state, historical, !paused);
  if (!state.session) return <div className="sessionTabState">Activity evidence is unavailable.</div>;
  return <div className="sessionLegacyStack">
    <RequestsActionsPanel agents={state.agents} requestSnapshots={state.metrics.tokens.requestSnapshots} contextBoundaries={state.metrics.tokens.contextHistory.boundaries} cacheWriteAvailable={state.capabilities.cacheWriteUsage} historical={historical} cacheEvents={state.metrics.tokens.cacheEvents} cacheReadDrops={state.metrics.tokens.cacheReadDrops} selection={selection} />
    <ActivityPanel activity={state.activity} historical={historical} loading={false} onRefresh={onRefresh} selection={selection} sessionId={state.session.id} historyEnabled={!paused} />
  </div>;
}

function LegacySignals({ state, historical, paused, onNavigateAgent }: { state: MonitorState; historical: boolean; paused: boolean; onNavigateAgent: (agentId: string) => void }) {
  const selection = useLegacySelection(state, historical, !paused);
  return <div className="sessionLegacyStack">
    <InsightsPanel insights={state.insights} onShowAgent={onNavigateAgent} />
    <CacheEvidenceDisclosure agents={state.agents} cacheEvents={state.metrics.tokens.cacheEvents} requestSnapshots={state.metrics.tokens.requestSnapshots} cacheWriteAvailable={state.capabilities.cacheWriteUsage} historical={historical} selectedSnapshot={selection.selected} onSelectSnapshot={(snapshot) => selection.locate(snapshot.id)} />
  </div>;
}
