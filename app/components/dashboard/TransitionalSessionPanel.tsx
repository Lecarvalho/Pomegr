"use client";

import type { ReactNode } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { useTransitionalSessionState } from "./useTransitionalSessionState";

type TransitionalSessionPanelProps = {
  sessionId: string; historical: boolean; paused: boolean; loadingLabel: string;
  children: (state: MonitorState) => ReactNode;
};

// Keying the panel on sessionId makes React unmount and remount it on a session change instead of
// reusing the instance, so the polled state, its refs and everything rendered from them reset for
// free (see useTransitionalSessionState).
export function TransitionalSessionPanel(props: TransitionalSessionPanelProps) {
  return <PolledSessionPanel key={props.sessionId} {...props} />;
}

function PolledSessionPanel({ sessionId, historical, paused, loadingLabel, children }: TransitionalSessionPanelProps) {
  const { state, error } = useTransitionalSessionState({ sessionId, historical, paused });
  const visibleState = state?.session?.id === sessionId ? state : null;
  if (!visibleState) return <div className="sessionTabState">{error ? "This session panel is temporarily unavailable." : `Loading ${loadingLabel}…`}</div>;
  return <>
    {error && <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded panel state.</div>}
    {children(visibleState)}
  </>;
}
