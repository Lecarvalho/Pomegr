import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import type { Task, TaskBoard, TaskCheck, TaskFeature, TaskRun } from "../../../shared/task-contract";
import { CHECK_LABELS, EFFORT_LABELS, PROVIDER_LABELS, REMOTE_CONTROL_LABEL, observedModelDiffers } from "./task-fields";
import { featureCounts, featureSteps } from "./task-features";
import { taskStateLabels } from "./task-presentation";

// Pure rules for the session view's task surfaces (the header meta, the Overview summary and the Task tab).

export type ReducedReason = "loading" | "desktop_only" | "unavailable" | "missing";

const REDUCED_NOTES: Record<ReducedReason, string | null> = {
  loading: null,
  desktop_only: "Task details are shown in the Pomegr desktop app or a browser on the same computer.",
  unavailable: "Pomegr could not read the task board.",
  missing: "This task is not on the board.",
};

export type SessionTaskFull = {
  kind: "full";
  task: Task;
  feature: TaskFeature | null;
  progress: { done: number; total: number } | null;
  nextStep: Task[];
  queue: { blocked: boolean; by: string | null };
};

/** The task's place among its feature's tasks, read from the order of their cards. */
export type SessionTaskStep = { step: number; total: number };

export type SessionTaskModel = { step: SessionTaskStep | null } & ({ kind: "reduced"; reason: ReducedReason; note: string | null } | SessionTaskFull);

export function stepLabel(step: SessionTaskStep): string {
  return `step ${step.step} of ${step.total}`;
}

export function sessionTaskModel(board: TaskBoard, reference: SessionTaskReference): SessionTaskModel {
  if (board.readiness !== "ready") {
    const reason: ReducedReason = board.readiness;
    return { step: null, kind: "reduced", reason, note: REDUCED_NOTES[reason] };
  }
  const task = board.tasks.find((entry) => entry.id === reference.id);
  if (!task) return { step: null, kind: "reduced", reason: "missing", note: REDUCED_NOTES.missing };
  const featureId = task.featureId;
  const steps = featureId === null ? [] : featureSteps(board, featureId);
  const at = steps.findIndex((entry) => entry.id === task.id);
  return {
    step: at < 0 ? null : { step: at + 1, total: steps.length },
    kind: "full",
    task,
    feature: featureId === null ? null : board.features.find((entry) => entry.id === featureId) ?? null,
    progress: featureId === null ? null : featureCounts(board, featureId),
    nextStep: at < 0 ? [] : steps.slice(at + 1, at + 2),
    queue: { blocked: board.queue.status === "blocked", by: board.queue.blockedBy },
  };
}

export function referenceChip(state: SessionTaskReference["state"]): { label: string; tone: "warning" | "neutral" } | null {
  if (state === null) return null;
  return { label: taskStateLabels[state], tone: state === "done" ? "neutral" : "warning" };
}

export function completeWhenParts(completeWhen: Task["completeWhen"]): string {
  const parts = [
    completeWhen.checks.length > 0 && `${completeWhen.checks.length} ${completeWhen.checks.length === 1 ? "check" : "checks"}`,
    completeWhen.own !== null && "own condition",
    "agent report",
  ].filter(Boolean);
  return parts.join(" + ");
}

const OUTCOME_STATES = new Set<Task["state"]>(["needs_review", "stalled", "blocked", "done"]);

function failedCount(task: Task) {
  return (task.report?.results ?? []).filter((result) => !result.passed).length;
}

export function reportOutcome(task: Task): string {
  if (task.state === "done") return "Done";
  if (task.state === "blocked") return "Blocked by agent";
  if (task.state === "needs_review") {
    const failed = failedCount(task);
    if (failed > 0) return `Needs review, ${failed} ${failed === 1 ? "check" : "checks"} did not pass`;
    if (task.report?.attention) return "Needs review, the agent asks for your attention";
    return (task.report?.results ?? []).length > 0 ? "Needs review, every check passed" : "Needs review";
  }
  if (task.state === "stalled") return "Stalled, the session ended with no report";
  return "not yet reported";
}

export function summaryCompleteWhen(task: Task): string {
  return `${completeWhenParts(task.completeWhen)} · ${reportOutcome(task)}`;
}

export function definitionStatus(task: Task): string {
  if (task.report) return task.report.blockReason !== null ? "Agent-reported. The agent reported it cannot continue." : "Agent-reported. The agent reported complete.";
  if (task.state === "stalled") return "Agent-reported. The session ended with no report.";
  return OUTCOME_STATES.has(task.state) ? "Agent-reported. No report was recorded." : "Agent-reported. Not yet reported.";
}

export type CheckRow = { check: TaskCheck; label: string; result: string; tone: "waiting" | "passed" | "failed" };

/** One row per checked condition. */
export function checkRows(task: Task): CheckRow[] {
  return task.completeWhen.checks.map((check) => {
    const label = CHECK_LABELS[check];
    if (!task.report) {
      if (OUTCOME_STATES.has(task.state)) return { check, label, result: "No report", tone: "waiting" };
      const reading = task.session?.checks?.find((entry) => entry.check === check);
      if (!reading) return { check, label, result: "Waiting for report", tone: "waiting" };
      return reading.passed ? { check, label, result: "Holds now", tone: "passed" } : { check, label, result: "Not yet", tone: "waiting" };
    }
    const found = task.report.results.find((entry) => entry.check === check);
    if (!found) return { check, label, result: "Not checked", tone: "waiting" };
    return found.passed ? { check, label, result: "Passed", tone: "passed" } : { check, label, result: "Did not pass", tone: "failed" };
  });
}

export type TextPart = { text: string; code: boolean };

export function plannedParts(run: TaskRun): TextPart[] {
  const parts: TextPart[] = [];
  if (run.provider) parts.push({ text: PROVIDER_LABELS[run.provider], code: false }, run.model ? { text: run.model, code: true } : { text: "Default model", code: false });
  if (run.effort) parts.push({ text: EFFORT_LABELS[run.effort].toLowerCase(), code: true });
  if (run.remoteControl === true) parts.push({ text: REMOTE_CONTROL_LABEL, code: false });
  return parts;
}

export function modelSummary(task: Task): { planned: TextPart; observed: TextPart; differs: boolean } {
  const observed = task.session?.observedModel ?? null;
  return {
    planned: task.run.model ? { text: task.run.model, code: true } : { text: task.run.provider ? "default model" : "not set", code: false },
    observed: observed ? { text: observed, code: true } : { text: "not recorded", code: false },
    differs: observedModelDiffers(task.run.model, observed),
  };
}

export function nextIds(nextStep: readonly Task[]): string {
  const ids = nextStep.map((entry) => entry.id);
  return ids.length > 3 ? `${ids.slice(0, 3).join(", ")} +${ids.length - 3}` : ids.join(", ");
}

export function queueBlockedLine(by: string | null): string {
  return by === null ? "Queue blocked" : `Queue blocked by ${by}`;
}

export function queueBlockedNote(model: Pick<SessionTaskFull, "task" | "nextStep" | "queue">): string {
  const lead = model.queue.by === model.task.id ? "This task blocks the queue." : `${queueBlockedLine(model.queue.by)}.`;
  if (model.nextStep.length === 0) return lead;
  const tail = model.task.state === "done" || model.queue.by === model.task.id ? "until it is resolved" : "when this session completes";
  return `${lead} ${nextIds(model.nextStep)} will not start ${tail}.`;
}

export function startedLine(task: Task): string | null {
  return task.session ? "Started by Pomegr" : null;
}
