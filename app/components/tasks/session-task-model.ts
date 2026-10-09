import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import type { Task, TaskBoard, TaskCheck, TaskFeature, TaskRun } from "../../../shared/task-contract";
import { CHECK_LABELS, EFFORT_LABELS, PROVIDER_LABELS, observedModelDiffers } from "./task-fields";
import { highestStep, featureCounts } from "./task-features";
import { taskStateLabels } from "./task-presentation";

// Pure rules for the session view's task surfaces (the header meta, the Overview summary and the Task tab). They take the
// session's task reference and the committed board and return plain values. Nothing here reads task text unless the board
// is ready and holds the task, so a reduced form can never show a value that a later board would retract.

/** Why only the reference's own fields can be shown. `missing` is a ready board that does not hold the task. */
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
  /** Done and total over every task of the feature, or null for a task without one. */
  progress: { done: number; total: number } | null;
  /** The other tasks in this task's step, then the tasks of the next step, each in task-number order. */
  sameStep: Task[];
  nextStep: Task[];
  /** The queue holds everything while it is blocked; `by` is the task it names. */
  queue: { blocked: boolean; by: string | null };
};

export type SessionTaskModel = { stepTotal: number | null } & ({ kind: "reduced"; reason: ReducedReason; note: string | null } | SessionTaskFull);

function idNumber(id: string) {
  return Number(id.slice(2));
}
const byTaskNumber = (left: Task, right: Task) => idNumber(left.id) - idNumber(right.id);

/** The highest step among the board's tasks of the same feature. Null while the board is not ready or has none. */
export function stepTotal(board: Pick<TaskBoard, "readiness" | "tasks">, featureId: string | null): number | null {
  if (featureId === null || board.readiness !== "ready") return null;
  return highestStep(board.tasks, featureId) || null;
}

/** "step 2 of 4", or "step 2" while the total is not known. */
export function stepLabel(step: number, total: number | null): string {
  return total === null ? `step ${step}` : `step ${step} of ${Math.max(step, total)}`;
}

export function sessionTaskModel(board: TaskBoard, reference: SessionTaskReference): SessionTaskModel {
  const total = stepTotal(board, reference.featureId);
  if (board.readiness !== "ready") {
    const reason: ReducedReason = board.readiness;
    return { stepTotal: total, kind: "reduced", reason, note: REDUCED_NOTES[reason] };
  }
  const task = board.tasks.find((entry) => entry.id === reference.id);
  if (!task) return { stepTotal: total, kind: "reduced", reason: "missing", note: REDUCED_NOTES.missing };
  const featureId = task.featureId;
  const inFeature = featureId === null ? [] : board.tasks.filter((entry) => entry.featureId === featureId);
  const step = task.step;
  return {
    stepTotal: total,
    kind: "full",
    task,
    feature: featureId === null ? null : board.features.find((entry) => entry.id === featureId) ?? null,
    progress: featureId === null ? null : featureCounts(board, featureId),
    sameStep: step === null ? [] : inFeature.filter((entry) => entry.step === step && entry.id !== task.id).sort(byTaskNumber),
    nextStep: step === null ? [] : inFeature.filter((entry) => entry.step === step + 1).sort(byTaskNumber),
    queue: { blocked: board.queue.status === "blocked", by: board.queue.blockedBy },
  };
}

/** The chip of a reduced form: every outcome the reference can carry, since the board's own chip is not available. */
export function referenceChip(state: SessionTaskReference["state"]): { label: string; tone: "warning" | "neutral" } | null {
  if (state === null) return null;
  return { label: taskStateLabels[state], tone: state === "done" ? "neutral" : "warning" };
}

/** "2 checks + agent report"; the agent's report always counts. */
export function doneWhenParts(doneWhen: Task["doneWhen"]): string {
  const parts = [
    doneWhen.checks.length > 0 && `${doneWhen.checks.length} ${doneWhen.checks.length === 1 ? "check" : "checks"}`,
    doneWhen.own !== null && "own condition",
    "agent report",
  ].filter(Boolean);
  return parts.join(" + ");
}

const OUTCOME_STATES = new Set<Task["state"]>(["needs_review", "stalled", "blocked", "done"]);

function failedCount(task: Task) {
  return (task.report?.results ?? []).filter((result) => !result.passed).length;
}

/**
 * Where the task stands against its Done when, in words. A task has no Running state: until it has a report or an outcome
 * it is simply not yet reported.
 */
export function reportOutcome(task: Task): string {
  if (task.state === "done") return "Done";
  if (task.state === "blocked") return "Blocked by agent";
  if (task.state === "needs_review") {
    const failed = failedCount(task);
    return failed > 0 ? `Needs review, ${failed} ${failed === 1 ? "check" : "checks"} did not pass` : "Needs review";
  }
  if (task.state === "stalled") return "Stalled, the session ended with no report";
  return "not yet reported";
}

/** The Overview cell: "2 checks + agent report · not yet reported". */
export function summaryDoneWhen(task: Task): string {
  return `${doneWhenParts(task.doneWhen)} · ${reportOutcome(task)}`;
}

/** The line under the Definition of done: the condition is the agent's to judge, and the report is what settles it. */
export function definitionStatus(task: Task): string {
  if (task.report) return task.report.blockReason !== null ? "Agent-reported. The agent reported it cannot continue." : "Agent-reported. The agent reported complete.";
  if (task.state === "stalled") return "Agent-reported. The session ended with no report.";
  return OUTCOME_STATES.has(task.state) ? "Agent-reported. No report was recorded." : "Agent-reported. Not yet reported.";
}

export type CheckRow = { check: TaskCheck; label: string; result: string; tone: "waiting" | "passed" | "failed" };

/**
 * One row per checked condition: the result the report recorded, or, while the task waits for its report, the monitor's
 * reading of the condition (`session.checks`, the rule and the facts that will judge the report). The reading is worded
 * as of now, never as a result, because the report's verification decides.
 */
export function checkRows(task: Task): CheckRow[] {
  return task.doneWhen.checks.map((check) => {
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

/** "Claude Code · opus · high": the provider plain, a named model and the effort as identifiers. Empty when nothing is planned. */
export function plannedParts(run: TaskRun): TextPart[] {
  const parts: TextPart[] = [];
  if (run.provider) parts.push({ text: PROVIDER_LABELS[run.provider], code: false }, run.model ? { text: run.model, code: true } : { text: "Default model", code: false });
  if (run.effort) parts.push({ text: EFFORT_LABELS[run.effort].toLowerCase(), code: true });
  return parts;
}

/** The Overview Model cell, "Planned opus · observed opus". The observed model is the session's latest reported one. */
export function modelSummary(task: Task): { planned: TextPart; observed: TextPart; differs: boolean } {
  const observed = task.session?.observedModel ?? null;
  return {
    planned: task.run.model ? { text: task.run.model, code: true } : { text: task.run.provider ? "default model" : "not set", code: false },
    observed: observed ? { text: observed, code: true } : { text: "not recorded", code: false },
    differs: observedModelDiffers(task.run.model, observed),
  };
}

/** The Next cell and the note under the Next rows: the task numbers of the following step. */
export function nextIds(nextStep: readonly Task[]): string {
  const ids = nextStep.map((entry) => entry.id);
  return ids.length > 3 ? `${ids.slice(0, 3).join(", ")} +${ids.length - 3}` : ids.join(", ");
}

/** "Queue blocked by T-12", or just "Queue blocked" when the blocker is not named. */
export function queueBlockedLine(by: string | null): string {
  return by === null ? "Queue blocked" : `Queue blocked by ${by}`;
}

/** The Task tab's note under the Next rows while the queue is blocked. */
export function queueBlockedNote(model: Pick<SessionTaskFull, "task" | "nextStep" | "queue">): string {
  const lead = model.queue.by === model.task.id ? "This task blocks the queue." : `${queueBlockedLine(model.queue.by)}.`;
  if (model.nextStep.length === 0) return lead;
  const tail = model.task.state === "done" || model.queue.by === model.task.id ? "until it is resolved" : "when this session completes";
  return `${lead} ${nextIds(model.nextStep)} will not start ${tail}.`;
}

/** Where the session started for a task came from: Pomegr started it once a session is linked. No start time is stored. */
export function startedLine(task: Task): string | null {
  return task.session ? "Started by Pomegr" : null;
}
