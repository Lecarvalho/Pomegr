import { useId, type ReactNode } from "react";
import { TASK_CHECKS, type Task, type TaskCheckOutcome } from "../../../shared/task-contract";
import { CheckGlyph, RingGlyph } from "./TaskGlyphs";
import { TaskReportNote } from "./TaskReportNote";
import { AGENT_REPORTED_LABEL, CHECK_OUTCOME_CLASSES, CHECK_OUTCOME_LABELS, CHECK_SHORT_LABELS, checkOutcome, isAgentJudged } from "./task-fields";
import { taskStateLabels } from "./task-presentation";

export const STALLED_NOTE = "The session ended with no report.";

const NEEDS_THE_USER = new Set<Task["state"]>(["needs_review", "stalled", "blocked"]);

/** A task needs the user in the states Needs review, Stalled and Blocked by agent. */
export const taskNeedsUser = (task: Pick<Task, "state">): boolean => NEEDS_THE_USER.has(task.state);

/** The Review panel opens a started task's modal when the task needs the user or the agent reported on it. */
export const taskHasReview = (task: Pick<Task, "state" | "report">): boolean => taskNeedsUser(task) || task.report !== null;

/** Whether the panel lists the Complete when results, so the Run settings do not list the conditions a second time. */
export const reviewListsConditions = (task: Pick<Task, "report" | "completeWhen">): boolean =>
  task.report !== null && (task.completeWhen.checks.length > 0 || task.completeWhen.own !== null);

function reviewHeading(state: Task["state"]): string {
  if (state === "needs_review") return "Ready for your review";
  return state === "stalled" || state === "blocked" ? taskStateLabels[state] : "Agent report";
}

/**
 * What a started task needs from the user: the state in words, the agent's report, and the checked conditions with their results.
 * `session` is the task's session line, which closes the panel.
 */
export function TaskReviewPanel({ task, session }: { task: Pick<Task, "state" | "report" | "completeWhen">; session?: ReactNode }) {
  const headingId = useId();
  const results = new Map<string, TaskCheckOutcome>((task.report?.results ?? []).map((entry) => [entry.check, checkOutcome(entry)]));
  const checks = TASK_CHECKS.filter((check) => task.completeWhen.checks.includes(check));
  const own = task.completeWhen.own;
  const listed = reviewListsConditions(task);
  return <section className="taskReview" aria-labelledby={headingId}>
    <div className="taskReviewHead">
      <h3 id={headingId} className="taskReviewHeading">{reviewHeading(task.state)}</h3>
      {task.report
        ? <TaskReportNote report={task.report} />
        : task.state === "stalled" && <p className="taskReviewLead">{STALLED_NOTE}</p>}
    </div>
    {listed && <ul className="taskReviewChecks" aria-label="Complete when">
      {checks.map((check) => {
        const outcome = results.get(check);
        const word = outcome !== undefined ? CHECK_OUTCOME_LABELS[outcome] : isAgentJudged(check) ? AGENT_REPORTED_LABEL : null;
        return <li key={check} className="taskReviewCheck">
          {outcome === "passed" ? <CheckGlyph /> : <RingGlyph />}
          <span className="taskReviewCheckLabel">{CHECK_SHORT_LABELS[check]}</span>
          {word !== null && <span className={`taskCheckResult${outcome !== undefined ? CHECK_OUTCOME_CLASSES[outcome] : ""}`}>{word}</span>}
        </li>;
      })}
      {own !== null && <li className="taskReviewCheck">
        <RingGlyph />
        <span className="taskReviewCheckLabel">{own}</span>
        <span className="taskCheckResult">{AGENT_REPORTED_LABEL}</span>
      </li>}
    </ul>}
    {session}
  </section>;
}
