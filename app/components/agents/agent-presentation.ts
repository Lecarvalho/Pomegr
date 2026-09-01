import type { AgentRole, WorkKind } from "../../../shared/monitor-contract";

export const ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: "Coordinate", explore: "Explore", plan: "Plan", builder: "Build", reviewer: "Review", tester: "Test",
  researcher: "Research", "general-purpose": "General", "workflow-worker": "Workflow", fork: "Fork", compaction: "Compaction", unknown: "Unreported",
};

export const WORK_LABELS: Record<WorkKind, string> = {
  shell: "Shell", search: "Searching", read: "Reading", write: "Editing", test: "Running tests", build: "Building", git: "Git", git_push: "Git push", pull_request: "Pull requests", process: "Processes", web: "Web", image: "Images", input: "Input", transfer: "Transfer", skill: "Skills", report: "Reports", agent: "Agents", integration: "Integration", wait: "Waiting",
};

export function modelLabel(model: string | null) { return model || "Unreported"; }
export function contextLabel(value: number | null) { return value === null ? "—" : `${Math.round(value / 1_000)}k`; }
export function statusLabel(status: "active" | "waiting" | "needs_input" | "warm" | "finished" | "stopped" | "idle" | "unknown") { return status === "needs_input" ? "Needs input" : status.replace(/_/g, " ").replace(/^./, (value) => value.toUpperCase()); }
