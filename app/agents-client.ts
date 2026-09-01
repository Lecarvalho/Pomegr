"use client";

import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import type { AgentsAnalyticsSnapshot } from "../shared/agents-contract";

export type AgentsFilters = Pick<AgentsAnalyticsSnapshot["filters"], "project" | "days" | "scope">;
export type AgentsClientState = {
  data: AgentsAnalyticsSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  connected: boolean;
  checkedAt: string | null;
};

export const AGENTS_POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const EMPTY_STATE: AgentsClientState = Object.freeze({ data: null, loading: true, refreshing: false, connected: true, checkedAt: null });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(512).regex(/^[^\u0000-\u001f\u007f]*$/u);
const id = text.min(1).max(256);
const timestamp = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value))).nullable();
const role = z.enum(["orchestrator", "explore", "plan", "builder", "reviewer", "tester", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"]);
const workKind = z.enum(["shell", "search", "read", "write", "test", "build", "git", "git_push", "pull_request", "process", "web", "image", "input", "transfer", "skill", "report", "agent", "integration", "wait"]);
const scope = z.enum(["all", "main", "delegated"]);
const work = z.array(z.object({ workKind, count }).strict()).max(32);
const run = z.object({
  id, agentId: id, sessionId: id, source: z.enum(["Claude Code", "Codex"]),
  project: text, sessionTitle: text, label: text, assignment: text.nullable(), role,
  model: text.max(256).nullable(), modelEvidence: z.enum(["latest_reported", "unavailable"]),
  scope: z.enum(["main", "delegated"]), parentId: id.nullable(), depth: count.max(64),
  status: z.enum(["active", "waiting", "needs_input", "warm", "finished", "stopped", "idle", "unknown"]),
  startedAt: timestamp, lastSeen: timestamp, latestContextTotal: count.nullable(),
  toolCalls: count.nullable(), executionTaskCount: count.nullable(), work,
}).strict();
const snapshotSchema: z.ZodType<AgentsAnalyticsSnapshot> = z.object({
  revision: count, readiness: z.enum(["loading", "ready", "unavailable"]), refreshReadiness: z.enum(["ready", "unavailable"]).optional(), generatedAt: timestamp,
  coverage: z.object({
    retainedSessions: count, eligibleSessions: count, missingSessions: count, retainedRuns: count,
    truncated: z.boolean(), earliestStartedAt: timestamp,
  }).strict(),
  filters: z.object({
    project: text, days: z.union([z.literal(7), z.literal(30), z.literal(90)]), scope,
    projects: z.array(text).max(100),
  }).strict(),
  summary: z.object({ runCount: count, sessionCount: count, modelCount: count, mainRunCount: count, delegatedRunCount: count }).strict(),
  models: z.array(z.object({
    model: text.max(256).nullable(), runCount: count, mainRunCount: count, delegatedRunCount: count,
    roles: z.array(z.object({ role, runCount: count }).strict()).max(16),
  }).strict()).max(128),
  work, runs: z.array(run).max(2000), roster: z.array(run).max(2000),
}).strict();

export function normalizeAgentsSnapshot(input: unknown): AgentsAnalyticsSnapshot | null {
  const result = snapshotSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** One serialized local-cache polling lane per selected filter set. */
export class AgentsStore {
  private state: AgentsClientState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestController: AbortController | null = null;
  private inFlight = false;
  private generation = 0;
  private restartWhenIdle = false;

  constructor(readonly filters: AgentsFilters) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY_STATE;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.stop(); };
  };

  private publish(next: AgentsClientState) {
    this.state = Object.freeze(next);
    this.listeners.forEach((listener) => listener());
  }

  async refresh() {
    if (this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.requestController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.publish({ ...this.state, refreshing: this.state.data !== null });
    try {
      const query = new URLSearchParams({ project: this.filters.project, days: String(this.filters.days), scope: this.filters.scope });
      if (this.state.data) query.set("revision", String(this.state.data.revision));
      const response = await fetch("/api/agents?" + query, { cache: "no-store", signal: controller.signal });
      if (generation !== this.generation) return;
      if (response.status === 204) {
        if (!this.state.data) throw new Error("Missing initial agent summary");
        this.publish({ ...this.state, loading: false, refreshing: false, connected: this.state.data.refreshReadiness !== "unavailable", checkedAt: new Date().toISOString() });
        return;
      }
      if (!response.ok) throw new Error("Agent summary unavailable");
      const next = normalizeAgentsSnapshot(await response.json());
      if (generation !== this.generation) return;
      if (!next || next.filters.project !== this.filters.project || next.filters.days !== this.filters.days || next.filters.scope !== this.filters.scope) throw new Error("Invalid agent summary");
      const data = next.readiness === "ready" ? next : this.state.data;
      this.publish({ data, loading: !data && next.readiness === "loading", refreshing: false, connected: next.readiness !== "unavailable" && next.refreshReadiness !== "unavailable", checkedAt: new Date().toISOString() });
    } catch {
      if (generation === this.generation) this.publish({ ...this.state, loading: false, refreshing: false, connected: false });
    } finally {
      clearTimeout(timeout);
      if (this.requestController === controller) this.requestController = null;
      this.inFlight = false;
      if (this.restartWhenIdle && this.listeners.size && !document.hidden) {
        this.restartWhenIdle = false;
        void this.poll();
      }
    }
  }

  private start() {
    ++this.generation;
    if (typeof window === "undefined") return;
    window.addEventListener("focus", this.onFocus);
    document.addEventListener("visibilitychange", this.onVisibility);
    if (!document.hidden) {
      if (this.inFlight) this.restartWhenIdle = true;
      else void this.poll();
    }
  }

  private stop() {
    ++this.generation;
    this.restartWhenIdle = false;
    this.requestController?.abort();
    this.clearTimer();
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private onFocus = () => { if (!document.hidden) void this.poll(); };
  private onVisibility = () => {
    if (document.hidden) this.clearTimer();
    else void this.poll();
  };
  private async poll() {
    if (!this.listeners.size || document.hidden || this.inFlight) return;
    this.clearTimer();
    const generation = this.generation;
    await this.refresh();
    if (generation !== this.generation || !this.listeners.size || document.hidden) return;
    this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, AGENTS_POLL_MS);
  }
}

export function useAgents(filters: AgentsFilters): AgentsClientState {
  const { project, days, scope } = filters;
  const store = useMemo(() => new AgentsStore({ project, days, scope }), [project, days, scope]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
