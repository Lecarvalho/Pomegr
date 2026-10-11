import type { Task, TaskBoard, TaskGateReason, TaskGates, TaskGateUsage, TaskProvider } from "../../../shared/task-contract";
import { scheduleLabel } from "./task-schedule";

export const PROVIDER_NAMES: Record<TaskProvider, string> = { claude: "Claude Code", codex: "Codex" };

export function usageReading(usage: TaskGateUsage): string | null {
  if (usage.fiveHourPercent === null && usage.sevenDayPercent === null) return null;
  const part = (label: string, value: number | null) => `${label} ${value === null ? "–" : `${value}%`}`;
  return `${part("5h", usage.fiveHourPercent)} · ${part("7d", usage.sevenDayPercent)}`;
}

export type GateTone = "ok" | "error" | "muted";

export function previousStepRow(gates: TaskGates): { text: string; tone: GateTone } {
  if (!gates.next) return { text: "No task queued", tone: "muted" };
  if (gates.next.blockedBy) return { text: `Blocked by ${gates.next.blockedBy}`, tone: "error" };
  return { text: "Done", tone: "ok" };
}

export function providerStatusRow(gates: TaskGates): { text: string; tone: GateTone } {
  const incidents = (Object.keys(PROVIDER_NAMES) as TaskProvider[]).filter((provider) => gates.providerStatus[provider] === "incident");
  if (incidents.length > 0) return { text: `Incident: ${incidents.map((provider) => PROVIDER_NAMES[provider]).join(", ")}`, tone: "error" };
  if (gates.providerStatus.claude === "ok" && gates.providerStatus.codex === "ok") return { text: "No incident", tone: "ok" };
  return { text: "Unknown", tone: "muted" };
}

export function workingTreeRow(gates: TaskGates): { text: string; tone: GateTone } {
  if (gates.workingTree === "clean") return { text: "Clean", tone: "ok" };
  if (gates.workingTree === "dirty") return { text: "Uncommitted changes", tone: "error" };
  return { text: "Unknown", tone: "muted" };
}

function reasonText(reason: TaskGateReason, gates: TaskGates, next: NonNullable<TaskGates["next"]>, schedule: TaskBoard["queue"]["schedule"]): string {
  const at = (value: string | null | undefined) => (value ? scheduleLabel(value) : null);
  const provider = PROVIDER_NAMES[next.provider];
  switch (reason) {
    case "previous_step": return next.blockedBy ? `step before it is not done (${next.blockedBy})` : "step before it is not done";
    case "usage_over": return `${provider} is above ${gates.threshold}% of the five-hour window`;
    case "usage_unknown": return `${provider} usage is not known`;
    case "provider_incident": return `${provider} reports an incident`;
    case "provider_status_unknown": return `${provider} status is not known`;
    case "tree_dirty": return "the working tree has uncommitted changes";
    case "tree_unknown": return "the working tree state is not known";
    case "before_queue_start": return at(schedule?.startAt) ? `the queue starts ${at(schedule?.startAt)}` : "the queue's start time has not come";
    case "after_queue_stop": return at(schedule?.stopAfter) ? `the queue stopped starting tasks ${at(schedule?.stopAfter)}` : "the queue's stop time has passed";
  }
}

/** The line for a manual start the monitor held (`gate_held`). */
export function heldStartLine(task: Task, queue: Pick<TaskBoard["queue"], "gates" | "schedule"> | undefined): string | null {
  const gates = queue?.gates;
  if (!gates) return null;
  const provider = task.run.provider ?? "claude";
  const usage = gates.usage[provider].status;
  const status = gates.providerStatus[provider];
  const reasons: TaskGateReason[] = [];
  if (usage !== "ok") reasons.push(usage === "over" ? "usage_over" : "usage_unknown");
  if (status !== "ok") reasons.push(status === "incident" ? "provider_incident" : "provider_status_unknown");
  if (gates.workingTree !== "clean") reasons.push(gates.workingTree === "dirty" ? "tree_dirty" : "tree_unknown");
  if (reasons.length === 0) return null;
  const next = { taskId: task.id, provider, blockedBy: null, reasons };
  return `This task is held: ${reasons.map((reason) => reasonText(reason, gates, next, queue.schedule)).join("; ")}.`;
}

export function waitingLine(queue: TaskBoard["queue"], taskId: string): string | null {
  const gates = queue.gates;
  if (queue.status !== "running" || !gates?.next || gates.next.taskId !== taskId || gates.next.reasons.length === 0) return null;
  const next = gates.next;
  return `Waiting: ${next.reasons.map((reason) => reasonText(reason, gates, next, queue.schedule)).join("; ")}`;
}
