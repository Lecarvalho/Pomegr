"use client";

import { useId, useState } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import type { Task, TaskAssignedSession } from "../../../shared/task-contract";
import { SessionTaskCell } from "../tasks/SessionTaskCell";
import { TaskCard } from "../tasks/TaskCard";
import { TaskReadView } from "../tasks/TaskReadView";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { TaskSessionsField, type TaskSessionCandidate } from "../tasks/TaskSessionsField";
import { STARTED_REQUEUE_NOTE } from "../tasks/task-presentation";
import { Sample, Section } from "./DesignSystemKit";
import { SAMPLE_FEATURE_ID, SAMPLE_REPOSITORY_ID, T2_STALLED, T6_WORKING, T8_IDLE } from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const NO_IMAGES = new Map<string, string | null>();
const assignedSession = (id: string, title: string | null, state: string): TaskAssignedSession => ({ id: `claude:design-system-${id}`, title, state, observedModel: "model-large" });
const RESUME = assignedSession("resume", "Resume the retry back-off", "working");
const REVIEWER = assignedSession("review", "Review the upload changes", "idle");
const CANDIDATES: TaskSessionCandidate[] = [
  { id: "claude:design-system-c1", title: "Fix the flaky upload test", state: "working" },
  { id: "codex:design-system-c2", title: null, state: "idle" },
];

const STALLED_RESUMED: Task = { ...T2_STALLED, columnId: "col-progress", assigned: [RESUME] };
const WORKING_SHARED: Task = { ...T6_WORKING, assigned: [RESUME, REVIEWER] };
const BACKLOG_ASSIGNED: Task = { ...T8_IDLE, assigned: [REVIEWER] };

const reference = (id: string, state: SessionTaskReference["state"], feature: string | null = "Upload reliability"): SessionTaskReference => ({
  id, repositoryId: SAMPLE_REPOSITORY_ID, state, featureId: feature === null ? null : SAMPLE_FEATURE_ID, feature, issue: null,
});

function ModalSample({ task, chip, subtitle }: { task: Task; chip: { label: string; tone: string }; subtitle: string }) {
  const titleId = useId();
  const [assigned, setAssigned] = useState(task.assigned ?? []);
  const [candidates, setCandidates] = useState(CANDIDATES);
  const assign = (id: string) => {
    const candidate = candidates.find((entry) => entry.id === id);
    if (!candidate) return;
    setAssigned([...assigned, { ...candidate, observedModel: null }]);
    setCandidates(candidates.filter((entry) => entry.id !== id));
  };
  const unassign = (id: string) => {
    const session = assigned.find((entry) => entry.id === id);
    setAssigned(assigned.filter((entry) => entry.id !== id));
    if (session) setCandidates([...candidates, session]);
  };
  return <div className="designSystemTaskFrame designSystemTaskModalStage">
    <TaskModalChrome titleId={titleId} title="Task" subtitle={subtitle} onClose={noop}
      titleExtra={<>
        <span className="taskModalId">{task.id}</span>
        <span className={`commandChip taskCardChip ${chip.tone}`}>{chip.label}</span>
      </>}
      footer={<>
        <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
        <span className="taskModalSpacer" aria-hidden="true" />
      </>}>
      {task.session !== null && <TaskReadView text={task.text} urls={NO_IMAGES} note={STARTED_REQUEUE_NOTE} />}
      <TaskSessionsField started={task.session} assigned={assigned} candidates={candidates} onAssign={assign} onUnassign={unassign} />
    </TaskModalChrome>
  </div>;
}

export function AssignedSessionsSection() {
  return <Section id="assigned-sessions" title="Assigned sessions" lede="A session can be assigned to any task of its repository's board, and a task can hold many assigned sessions beside the one Pomegr started for it. Assigning changes no state, column, or queue place: it only lets the session report the task and shows it here. The session assigns itself with the assign_task tool, or the owner assigns it in the Task modal.">
    <div className="designSystemGrid">
      <Sample label="Card, stalled and resumed" note="The first session ended with no report, and a session started by hand is assigned. The card keeps its Stalled chip until that session reports; the sessions line opens the started session and counts the other.">
        <div className="designSystemTaskFrame"><ul className="taskColumnList"><TaskCard task={STALLED_RESUMED} lane="in_progress" /></ul></div>
      </Sample>
      <Sample label="Card, started session and two assigned" note="The green border still follows the session Pomegr started, and the lane says In progress, so the card draws no chip. The sessions line stays one line whatever the count.">
        <div className="designSystemTaskFrame"><ul className="taskColumnList"><TaskCard task={WORKING_SHARED} lane="in_progress" /></ul></div>
      </Sample>
      <Sample label="Card, not started, one assigned" note="Assigning is a marker only: the task stays Not queued in its column. The line names the session as Assigned, because Pomegr started none.">
        <div className="designSystemTaskFrame"><ul className="taskColumnList"><TaskCard task={BACKLOG_ASSIGNED} lane="backlog" /></ul></div>
      </Sample>
    </div>
    <div className="designSystemGrid designSystemModalGrid">
      <Sample label="Task modal, Sessions" note="Sessions closes the body: one ruled row per session with its title as a Text link, its role, its own state chip, and a Quiet Unassign for an assigned session. The session Pomegr started has no Unassign. Under the rows, a select of the repository's other sessions and the Secondary Assign session. Try both.">
        <ModalSample task={STALLED_RESUMED} chip={{ label: "Stalled", tone: "warning" }} subtitle="pomegr" />
      </Sample>
      <Sample label="Task modal, Sessions, none yet" note="A task with no session shows only the assign control and its one helper line.">
        <ModalSample task={T8_IDLE} chip={{ label: "Not queued", tone: "neutral" }} subtitle="pomegr" />
      </Sample>
      <Sample label="Sessions, paired phone or browser without assign" note="A client that cannot assign draws the rows only.">
        <div className="designSystemTaskFrame"><TaskSessionsField started={WORKING_SHARED.session} assigned={WORKING_SHARED.assigned ?? []} /></div>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Sessions list, assigned to one task" note="A session started by hand and assigned to one task reads like a started one, with the muted word Assigned."><SessionTaskCell task={null} assigned={[reference("T-12", "needs_review")]} /></Sample>
      <Sample label="Sessions list, assigned to several tasks" note="One muted line of task IDs, each a Text link to its board. No chip and no feature line, so the row keeps its height."><SessionTaskCell task={null} assigned={[reference("T-12", null), reference("T-15", null, null), reference("T-21", "done")]} /></Sample>
      <Sample label="Sessions list, started for one task and assigned to others" note="The started task keeps its full form; the assigned ones follow on one line."><SessionTaskCell task={reference("T-14", null)} assigned={[reference("T-12", "stalled"), reference("T-15", null, null)]} /></Sample>
    </div>
  </Section>;
}
