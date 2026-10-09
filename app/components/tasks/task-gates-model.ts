import type { TaskBoard, TaskGateReason, TaskGates, TaskGateUsage, TaskProvider } from "../../../shared/task-contract";

export const PROVIDER_NAMES: Record<TaskProvider, string> = { claude: "Claude Code", codex: "Codex" };

/** "5h 62% · 7d 31%", with "–" for a window the board did not send, or null when it sent neither. */
export function usageReading(usage: TaskGateUsage): string | null {
  if (usage.fiveHourPercent === null && usage.sevenDayPercent === null) return null;
  const part = (label: string, value: number | null) => `${label} ${value === null ? "–" : `${value}%`}`;
  return `${part("5h", usage.fiveHourPercent)} · ${part("7d", usage.sevenDayPercent)}`;
}

export type GateTone = "ok" | "error" | "muted";

/** The Previous step done row: what the next queued task waits on. */
export function previousStepRow(gates: TaskGates): { text: string; tone: GateTone } {
  if (!gates.next) return { text: "No task queued", tone: "muted" };
  if (gates.next.blockedBy) return { text: `Blocked by ${gates.next.blockedBy}`, tone: "error" };
  return { text: "Done", tone: "ok" };
}

/** The Provider status row. */
export function providerStatusRow(gates: TaskGates): { text: string; tone: GateTone } {
  const incidents = (Object.keys(PROVIDER_NAMES) as TaskProvider[]).filter((provider) => gates.providerStatus[provider] === "incident");
  if (incidents.length > 0) return { text: `Incident: ${incidents.map((provider) => PROVIDER_NAMES[provider]).join(", ")}`, tone: "error" };
  if (gates.providerStatus.claude === "ok" && gates.providerStatus.codex === "ok") return { text: "No incident", tone: "ok" };
  return { text: "Unknown", tone: "muted" };
}

/** The Working tree row. */
export function workingTreeRow(gates: TaskGates): { text: string; tone: GateTone } {
  if (gates.workingTree === "clean") return { text: "Clean", tone: "ok" };
  if (gates.workingTree === "dirty") return { text: "Uncommitted changes", tone: "error" };
  return { text: "Unknown", tone: "muted" };
}

function reasonText(reason: TaskGateReason, gates: TaskGates, next: NonNullable<TaskGates["next"]>): string {
  const provider = PROVIDER_NAMES[next.provider];
  switch (reason) {
    case "previous_step": return next.blockedBy ? `step before it is not done (${next.blockedBy})` : "step before it is not done";
    case "usage_over": return `${provider} is above ${gates.threshold}% of the five-hour window`;
    case "usage_unknown": return `${provider} usage is not known`;
    case "provider_incident": return `${provider} reports an incident`;
    case "provider_status_unknown": return `${provider} status is not known`;
    case "tree_dirty": return "the working tree has uncommitted changes";
    case "tree_unknown": return "the working tree state is not known";
  }
}

/** The one muted line on the held next task, or null when nothing holds it or the queue is not running. */
export function waitingLine(queue: TaskBoard["queue"], taskId: string): string | null {
  const gates = queue.gates;
  if (queue.status !== "running" || !gates?.next || gates.next.taskId !== taskId || gates.next.reasons.length === 0) return null;
  const next = gates.next;
  return `Waiting: ${next.reasons.map((reason) => reasonText(reason, gates, next)).join("; ")}`;
}
