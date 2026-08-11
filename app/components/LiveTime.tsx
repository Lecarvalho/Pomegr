"use client";

import type { Agent, ExecutionTask, MonitorState } from "../../shared/monitor-contract";
import { formatDuration, minuteRelativeTime, relativeTime, resetCountdown } from "../dashboard-utils";
import { formatAgentWallTime, formatExecutionTaskWallTime, liveWallTimeMs } from "../formatting.mjs";
import { useLiveNow } from "../hooks/LiveClockContext";

export function RelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{relativeTime(value, now)}</>;
}

export function MinuteRelativeTimeText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{minuteRelativeTime(value, now)}</>;
}

export function ResetCountdownText({ value }: { value: string | null }) {
  const now = useLiveNow();
  return <>{resetCountdown(value, now)}</>;
}

export function AgentWallTimeText({ agent }: { agent: Agent }) {
  const now = useLiveNow();
  return <>{formatAgentWallTime(agent, now)}</>;
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
