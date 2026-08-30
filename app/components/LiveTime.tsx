"use client";

import type { Agent, ExecutionTask, MonitorState } from "../../shared/monitor-contract";
import { coarseRelativeTime, formatDuration, minuteRelativeTime, relativeTime, resetCountdown, retryCountdown, sessionRelativeTime } from "../dashboard-utils";
import { formatAgentRowWallTime, formatExecutionTaskWallTime, liveWallTimeMs } from "../formatting.mjs";
import { useLiveNow } from "../hooks/LiveClockContext";

export function RelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{relativeTime(value, now)}</>;
}

export function MinuteRelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{minuteRelativeTime(value, now)}</>;
}

export function CoarseRelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{coarseRelativeTime(value, now)}</>;
}

export function SessionRelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{sessionRelativeTime(value, now)}</>;
}

export function ResetCountdownText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{resetCountdown(value, now)}</>;
}

export function RetryCountdownText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{retryCountdown(value, now)}</>;
}

export function AgentWallTimeText({ agent }: { agent: Agent }) {
  const now = useLiveNow();
  return <>{formatAgentRowWallTime(agent, now)}</>;
}

export function ExecutionTaskWallTimeText({ task }: { task: ExecutionTask }) {
  const now = useLiveNow();
  return <>{formatExecutionTaskWallTime(task, now)}</>;
}

export function SessionWallTimeText({ session, historical }: {
  session: NonNullable<MonitorState["session"]>;
  historical: boolean;
}) {
  const now = useLiveNow();
  const durationMs = liveWallTimeMs(session.durationMs, session.startedAt, !historical, now);
  if (!historical && durationMs < 60_000) return <>Less than 1m</>;
  return <>{formatDuration(durationMs)}</>;
}
