import { TASK_GATE_REASONS, type Task, type TaskBoard, type TaskGateReason, type TaskGates, type TaskGateUsage, type TaskProvider } from "../../../shared/task-contract";
import { scheduleLabel } from "./task-schedule";

export const PROVIDER_NAMES: Record<TaskProvider, string> = { claude: "Claude Code", codex: "Codex" };

/** Show capacity only when the monitor qualifies the reading, including weekly-only accounts. */
export function usageReading(usage: TaskGateUsage): string | null {
  if (usage.status === "unknown" || (usage.fiveHourPercent === null && usage.sevenDayPercent === null)) return null;
  const part = (label: string, value: number | null) => `${label} ${value === null ? "–" : `${value}%`}`;
  if (usage.fiveHourPercent === null) return part("7d", usage.sevenDayPercent);
  return `${part("5h", usage.fiveHourPercent)} · ${part("7d", usage.sevenDayPercent)}`;
}

export type GateTone = "ok" | "error" | "muted";

export function earlierTaskRow(gates: TaskGates): { text: string; tone: GateTone } {
  if (!gates.next) return { text: "No task queued", tone: "muted" };
  if (gates.next.blockedBy) return { text: `Blocked by ${gates.next.blockedBy}`, tone: "error" };
  return { text: "Finished", tone: "ok" };
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
    case "earlier_task": return next.blockedBy ? `${next.blockedBy} has not finished` : "an earlier task has not finished";
    case "usage_over": return `${provider} is above ${gates.threshold}% of the ${gates.usage[next.provider].fiveHourPercent === null ? "seven-day" : "five-hour"} window`;
    case "usage_unknown": return `${provider} usage is not known yet`;
    case "provider_incident": return `${provider} reports an incident`;
    case "provider_status_unknown": return `${provider} status is not known yet`;
    case "tree_dirty": return "the working tree has uncommitted changes";
    case "tree_unknown": return "the working tree state is not known yet";
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

/** The reasons that hold a provider's start, read from the gates the board serves. */
function providerHolds(gates: TaskGates, provider: TaskProvider): TaskGateReason[] {
  const usage = gates.usage[provider].status;
  const status = gates.providerStatus[provider];
  return [
    ...(usage === "ok" ? [] : [usage === "over" ? "usage_over" as const : "usage_unknown" as const]),
    ...(status === "ok" ? [] : [status === "incident" ? "provider_incident" as const : "provider_status_unknown" as const]),
  ];
}

/**
 * The Waiting line of a card. The task the monitor lists first reads the reasons the monitor gave. A waiting card of
 * that task's parallel group starts with it, so it reads the same reasons with its own provider's capacity and
 * status. `started` names the members of the group that already run, so a held member says that its siblings went on.
 */
export function waitingLine(queue: TaskBoard["queue"], task: Pick<Task, "id" | "run" | "group">, tasks: readonly Pick<Task, "id" | "group">[] = [], started: readonly string[] = []): string | null {
  const gates = queue.gates;
  if (queue.status !== "running" || !gates?.next) return null;
  const first = gates.next;
  const sibling = first.taskId !== task.id && task.group !== null && tasks.some((other) => other.id === first.taskId && other.group === task.group);
  if (first.taskId !== task.id && !sibling) return null;
  const provider = task.run.provider ?? "claude";
  const own = new Set<TaskGateReason>(["usage_over", "usage_unknown", "provider_incident", "provider_status_unknown"]);
  const next = sibling ? { ...first, taskId: task.id, provider, reasons: [...first.reasons.filter((reason) => !own.has(reason)), ...providerHolds(gates, provider)] } : first;
  if (next.reasons.length === 0) return null;
  const order = TASK_GATE_REASONS.filter((reason) => next.reasons.includes(reason));
  const siblings = started.length > 0 ? ` · ${started.join(", ")} started` : "";
  return `Waiting: ${order.map((reason) => reasonText(reason, gates, next, queue.schedule)).join("; ")}${siblings}`;
}
