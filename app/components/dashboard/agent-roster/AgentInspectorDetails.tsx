"use client";

import { useMemo, useState } from "react";
import type { Agent, ExecutionTask, PlanTask, ReviewDecision } from "../../../../shared/monitor-contract";
import { agentDisplayLabel } from "../../../dashboard-utils";
import { ExecutionTaskRow } from "../../ExecutionTaskRow";
import { RelativeTimeText } from "../../LiveTime";

const REVIEW_ACTION_LABELS: Record<ReviewDecision["action"], string> = {
  build_or_test: "Build or test",
  browser_interaction: "Browser interaction",
  dependency_change: "Dependency change",
  file_change: "File change",
  filesystem_action: "Filesystem action",
  local_process: "Local process or server",
  network_access: "Network access",
  version_control: "Version-control action",
  shell_command: "Shell command",
  privileged_action: "Privileged action",
};

function activityIsCurrent(agent: Agent) {
  return agent.status !== "unknown"
    && agent.liveness?.freshness !== "stale"
    && agent.liveness?.evidence !== "unavailable";
}

function taskTimestamp(task: ExecutionTask) {
  const value = Date.parse(task.finishedAt || task.startedAt);
  return Number.isFinite(value) ? value : 0;
}

function reviewDurationLabel(durationMs: number | null) {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return "under 1s";
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.round(durationMs / 1_000)}s`;
}

/**
 * Retained, bounded agent evidence for the roster inspector. The wrapper owns
 * selection, lineage, facts, signals, and actions; these sections stay usable
 * by both the desktop inspector and the phone sheet.
 */
export function AgentInspectorDetails({
  agent,
  planTasks = [],
  historical = false,
  presentation = "inline",
  section = "all",
}: {
  agent: Agent;
  planTasks?: PlanTask[];
  historical?: boolean;
  presentation?: "inline" | "sheet";
  /** Lets the inspector place skills in Facts while retaining shared detail markup. */
  section?: "all" | "skills" | "activity";
}) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const displayLabel = agentDisplayLabel(agent) || "Agent";
  const skillLimit = 6;
  const taskLimit = presentation === "sheet" ? 3 : 4;
  const visibleSkills = skillsExpanded ? agent.skills : agent.skills.slice(0, skillLimit);
  const reviewDecisions = agent.reviewDecisions || { total: 0, allowed: 0, denied: 0, items: [], truncated: false };
  const visibleReviewDecisions = [...reviewDecisions.items].reverse();
  const currentActivity = historical ? null : agent.currentActivity;
  const currentActivityIsCurrent = currentActivity ? activityIsCurrent(agent) : false;
  const tasks = useMemo(() => [...(agent.executionTasks || [])].sort((left, right) => {
    const running = Number(right.status === "running") - Number(left.status === "running");
    return running || taskTimestamp(right) - taskTimestamp(left) || left.id.localeCompare(right.id);
  }), [agent.executionTasks]);
  const visibleTasks = tasksExpanded ? tasks : tasks.slice(0, taskLimit);
  const completedPlanTasks = planTasks.filter((task) => task.status === "completed").length;
  const activePlanTasks = planTasks.filter((task) => task.status === "in_progress").length;
  const openPlanTasks = planTasks.length - completedPlanTasks - activePlanTasks;

  const showSkills = section !== "activity";
  const showActivity = section !== "skills";
  return <div className={`agentInspectorDetails agentInspectorDetails-${presentation}`} aria-label={`Details for ${displayLabel}`}>
    {showSkills && agent.skills.length > 0 && <section className="agentInspectorSection agentInspectorSkills" aria-label="Skills used">
      <div className="agentInspectorSectionHeading"><h3>Skills · {agent.skills.length}</h3>{agent.skills.length > skillLimit && <button type="button" onClick={() => setSkillsExpanded((expanded) => !expanded)}>{skillsExpanded ? "Show less" : "All"}</button>}</div>
      <div className="skillPopoverList">{visibleSkills.map((skill) => <div className="skillPopoverRow" key={skill.name}><div><strong>{skill.name}</strong><small>{skill.lastUsed ? <>Last used <RelativeTimeText value={skill.lastUsed} /></> : "Use time unavailable"}</small></div><div><strong>{skill.calls}</strong><small>{skill.calls === 1 ? "use" : "uses"}</small></div></div>)}</div>
    </section>}

    {showActivity && <>
    {currentActivity && <section className="agentInspectorSection executionTaskSection currentActivitySection" aria-label={currentActivityIsCurrent ? "Current provider-reported activity" : "Last observed provider-reported activity"}><h3>{currentActivityIsCurrent ? "Current activity" : "Last observed activity"}</h3><div className={`currentActivityRow ${currentActivityIsCurrent ? "" : "staleActivity"}`}><span className="currentActivityMark" aria-hidden="true" /><div><strong>{currentActivity.label}</strong><small>Provider-reported · observed <RelativeTimeText value={currentActivity.observedAt} /></small></div></div></section>}

    {visibleReviewDecisions.length > 0 && <section className="agentInspectorSection executionTaskSection reviewDecisionSection" aria-label="Completed approval reviews"><h3>Review decisions ({reviewDecisions.total})</h3>{visibleReviewDecisions.map((decision, index) => {
      const actionLabel = REVIEW_ACTION_LABELS[decision.action] || REVIEW_ACTION_LABELS.privileged_action;
      const riskLabel = decision.risk === "unknown" ? "risk unavailable" : `${decision.risk} risk`;
      const durationLabel = reviewDurationLabel(decision.durationMs);
      return <div className={`reviewDecisionRow ${decision.outcome}`} key={`${decision.reviewedAt}-${decision.outcome}-${index}`}><span className="reviewDecisionMark" aria-hidden="true" /><div><div className="reviewDecisionHeading"><strong>{actionLabel}</strong><span className="reviewDecisionOutcome">{decision.outcome === "allowed" ? "Allowed" : "Denied"}</span></div><small>Pomegr category · provider-assessed {riskLabel} · completed <RelativeTimeText value={decision.reviewedAt} />{durationLabel ? ` · reviewed in ${durationLabel}` : ""}</small></div></div>;
    })}{reviewDecisions.truncated && <p className="reviewDecisionLimit">Showing the latest {visibleReviewDecisions.length} decisions.</p>}</section>}

    {tasks.length > 0 && <section className="agentInspectorSection executionTaskSection" aria-label="Shell tasks"><div className="agentInspectorSectionHeading"><h3>Shell tasks · {tasks.length === 30 ? "latest 30" : tasks.length}</h3>{tasks.length > taskLimit && <button type="button" onClick={() => setTasksExpanded((expanded) => !expanded)}>{tasksExpanded ? "Show less" : "All"}</button>}</div>{visibleTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} compact />)}</section>}

    {agent.id === "primary" && planTasks.length > 0 && <section className="agentInspectorSection agentInspectorPlan" aria-label="Agent plan checklist"><div className="agentInspectorSectionHeading"><h3>Plan checklist</h3><small>{completedPlanTasks} done · {activePlanTasks} in progress · {openPlanTasks} open</small></div><div className="planTaskList">{planTasks.map((task) => <div className={`planTaskRow ${task.status}`} key={task.id}><span className="planTaskState" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "■" : "□"}</span><div><strong>{task.subject}</strong>{task.blockedBy.length > 0 && <small>Blocked by {task.blockedBy.join(", ")}</small>}</div></div>)}</div><div className="planTaskCaution"><strong>Agent-maintained checklist</strong><span>Updates only when the agent changes it. It may be stale and does not represent live execution.</span></div></section>}
    </>}
  </div>;
}
