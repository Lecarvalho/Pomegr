"use client";

import { useId, useState } from "react";
import { CommandSplitAction } from "../command-center/CommandSplitAction";
import { FeatureFields } from "../tasks/FeatureFields";
import { FeatureModalSamples } from "./DesignSystemFeatureModalSample";
import { ISSUE_CONFIRM_FACTS, IssueCreateCheckbox, IssueCreateRowView, TaskIssueRow, type IssueCreateOption } from "../tasks/IssueCreate";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { TaskQueueWait } from "../tasks/TaskQueueWait";
import { PromoteIssueSummary, PromoteOutcomeNotice } from "../tasks/TaskModalPromote";
import { TaskAfterField } from "../tasks/TaskAfterField";
import { TaskReadView } from "../tasks/TaskReadView";
import { TaskReviewPanel } from "../tasks/TaskReviewPanel";
import { RunSettings } from "../tasks/TaskRows";
import { ModelDiffersNotice, TaskRunSettingsRead } from "../tasks/TaskRunSettingsRead";
import { TaskSessionLine } from "../tasks/TaskSessionLine";
import { TaskSessionsField, type TaskSessionCandidate } from "../tasks/TaskSessionsField";
import { StartAtRowView } from "../tasks/TaskStartTimeField";
import { CompleteWhenField, RunFields, TaskTextField } from "../tasks/TaskFields";
import { TASK_SCHEDULE_FAILURE_MESSAGE } from "../tasks/task-desktop";
import { TASK_IMAGE_TYPE_MESSAGE } from "../tasks/task-images-desktop";
import { DEFAULT_COMPLETE_WHEN, DEFAULT_RUN, EMPTY_RUN, NO_MODELS, type CompleteWhenDraft } from "../tasks/task-fields";
import { NO_FEATURE_DRAFT, type FeatureDraft } from "../tasks/task-features";
import type { TaskIssue, TaskIssueCreateError } from "../tasks/task-issues-desktop";
import { AWAITING_REPORT_NOTE, STARTED_REQUEUE_NOTE } from "../tasks/task-presentation";
import { NO_KNOWN_HOLD } from "../tasks/task-wait-model";
import { SAVE_FIRST_LINE } from "../tasks/use-task-draft";
import type { Task, TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_PLAN, BOARD_RUNNING, P15_AFTER, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const noop = () => undefined;
const CREATE_FOLLOW_UPS = [
  { value: "queue", label: "Create and queue", detail: "Goes to the end of Ready." },
  { value: "start", label: "Create and start session", detail: "Opens the session's terminal in Pomegr." },
];
const SAMPLE_IMAGE_IDS = ["img-000000000001", "img-000000000002", "img-000000000003", "img-000000000004"];
const SAMPLE_IMAGE_URLS = new Map<string, string | null>(SAMPLE_IMAGE_IDS.map((id) => [id, null]));
const noImages = () => [];
const TEXT_WITH_IMAGE = `Match the settings page to this mock-up:\n[image:${SAMPLE_IMAGE_IDS[0]}]\nKeep the header as it is.`;
const TEXT_WITH_TAGS = "[ backend ] [ recce ] [bug] Coverage opens a shot only on an action or b-roll line; every other line rides.\nA scene with no action or b-roll has no shots, so the coverage job returns nothing to picture and never calls the model for it.";
const TEXT_FULL =`Compare the four states: ${SAMPLE_IMAGE_IDS.map((id) => `[image:${id}]`).join(" ")}`;
// A started task's text as the read view draws it: paragraphs, a numbered list, code, a UUID, and a date and time.
const DOCUMENT_TEXT = `[ backend ] [ recce ] [bug] Coverage opens a shot only on an action or b-roll line; every other line rides.
Prod production b44302e6-ca10-494a-9bde-b5ccbe190dcb, 2026-10-20 20:59-21:01 UTC. The coverage job cut \`L04\` into its own shot and the model invented a frame prompt for it.

Ruling (maintainer, 2026-10-20): a Shot is a stretch of picture opened by an action or b_roll_note line. Everything else rides the shot whose picture plays under it.
Fix:
1. One picture-line list in \`CoveragePlan\`; merge any group with no picture line.
2. Coverage on a scene with no picture line returns nothing to picture without calling the model.
3. Name the rule in the coverage guide.
- Follow-up, not here: a monotone-screen action gets the set composed into its frame prompt.`;
const STORED_TEXT = "Retry failed uploads with a capped backoff and cover it with a test.";
const LONG_TASK_TEXT = `${STORED_TEXT}\n\n${"Keep a retry budget for each upload. Cover a temporary failure, an exhausted budget, and a successful retry.\n\n".repeat(12)}${TEXT_WITH_IMAGE}`;
const STARTED_RUN: TaskRun = { provider: "claude", model: "model-large", effort: "high" };
const REVIEWED_WHEN: Task["completeWhen"] = { checks: ["pr_open", "tree_clean", "ci_passed", "user_validated"], own: "The store rejects a malformed record." };
const REVIEWED_REPORT = {
  at: "", blockReason: null, attention: "The retry budget of **five** is a guess; confirm `RETRY_BUDGET` before merging.",
  results: [{ check: "pr_open" as const, passed: false }, { check: "tree_clean" as const, passed: true }, { check: "ci_passed" as const, passed: false, unavailable: true }],
};
const DONE_REPORT = { at: "", blockReason: null, results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: true }, { check: "ci_passed" as const, passed: true }] };
const SAMPLE_SESSION = <TaskSessionLine title="Add a retry budget to the uploader" sessionId="claude:design-system-review" />;
const columnName = (id: string) => BOARD_PLAN.columns.find((column) => column.id === id)?.name ?? null;
const CANDIDATES: TaskSessionCandidate[] = [{ id: "claude:design-system-c1", title: "Fix the flaky upload test", state: "working" }];
const ASSIGNED = [{ id: "claude:design-system-resume", title: "Resume the retry back-off", state: "working", observedModel: "model-large", observedEffort: null }];
const STARTED_SESSION = { id: "claude:design-system-review", title: "Add a retry budget to the uploader", state: "idle", observedModel: "model-large", observedEffort: null };

/** The Start at row with a field of its own state. It sends nothing here. */
function StartAtDemo({ initial = "", failure = null }: { initial?: string; failure?: string | null }) {
  const [value, setValue] = useState(initial);
  return <StartAtRowView value={value} failure={failure} onChange={setValue} onCommit={noop} />;
}

export function TaskFieldsSection() {
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: "model-large", effort: "high" });
  const [unset, setUnset] = useState<TaskRun>(EMPTY_RUN);
  const [fresh, setFresh] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const [startAt, setStartAt] = useState("02:00");
  const [placed, setPlaced] = useState<FeatureDraft>({ featureId: SAMPLE_FEATURE_ID, creating: false, name: "" });
  const [created, setCreated] = useState<FeatureDraft>({ ...NO_FEATURE_DRAFT, creating: true, name: "Retry telemetry" });
  const modalTitleId = useId();
  const [modalText, setModalText] = useState("");
  const [imageText, setImageText] = useState("");
  const [tagsText, setTagsText] = useState(TEXT_WITH_TAGS);
  const [inlineText, setInlineText] = useState(TEXT_WITH_IMAGE);
  const [fullText, setFullText] = useState(TEXT_FULL);
  const [issueChecked, setIssueChecked] = useState(true);
  const [modalRun, setModalRun] = useState<TaskRun>(DEFAULT_RUN);
  const [remote, setRemote] = useState<TaskRun>({ ...DEFAULT_RUN, remoteControl: true });
  const [codexRun, setCodexRun] = useState<TaskRun>({ ...DEFAULT_RUN, provider: "codex" });
  const [modalCompleteWhen, setModalCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  return <Section id="task-fields" title="Task fields" lede="The Task field, Run on, Effort, Remote Control, When done, Complete when and Feature, shared by the New task and Task modal forms (the modal has three modes: new, promote issue and edit). They are the rows of one Run settings list: a muted label over a ruled value. Run on is one select that names provider and model, with a Default model entry per provider. Remote Control is one checkbox under both, for a Claude Code session only. Effort is a four-way segmented control. Run on and Effort are required: a new task opens with both chosen, and neither can be cleared. Complete when is five short checks in a wrapping row and one input for an own condition judged by the agent. Feature is one select over the board's features that are not done, with a folded list of the feature's other tasks. A started task draws the same rows as plain values.">
    <div className="designSystemStates designSystemRowGrid">
      <Sample label="Run on and Effort, chosen" note="Models come from the model list the app already serves; the names here are static samples. The select is the shared CommandSelect drawn as the value: no border, a muted chevron, a 6% ink fill on hover.">
        <RunSettings><RunFields run={run} models={MODELS} onChange={setRun} /></RunSettings>
      </Sample>
      <Sample label="Stored task with nothing chosen, no model list" note="Only a task stored without them shows Not set and no pressed Effort. Once chosen, neither can be cleared. A provider with no observed model offers only its Default model.">
        <RunSettings><RunFields run={unset} models={NO_MODELS} onChange={setUnset} /></RunSettings>
      </Sample>
      <Sample label="Remote Control, on" note="Checked for a task that starts Claude Code, named or by default. The hint says the started session can also be opened on a phone.">
        <RunSettings><RunFields run={remote} models={MODELS} onChange={setRemote} /></RunSettings>
      </Sample>
      <Sample label="Codex run" note="Pomegr does not enable Remote Control for Codex tasks, so its row is absent.">
        <RunSettings><RunFields run={codexRun} models={MODELS} onChange={setCodexRun} /></RunSettings>
      </Sample>
      <Sample label="Complete when, new task" note="PR open and Tree clean start checked. A non-blank own condition counts; a blank one is none.">
        <RunSettings><CompleteWhenField draft={fresh} onDraftChange={setFresh} /></RunSettings>
      </Sample>
      <Sample label="Start at, in the Task modal" note="A task that still waits for a session ends the list with Start at: a compact date-and-time field (32px high, about 220px wide, left-aligned) with the hint under it. The field saves by itself when it loses focus. A refused time shows one fixed line under it.">
        <RunSettings><StartAtDemo /></RunSettings>
        <RunSettings><StartAtDemo initial="2026-10-22T02:00" failure={TASK_SCHEDULE_FAILURE_MESSAGE} /></RunSettings>
      </Sample>
      <Sample label="Review panel, needs review" note="A started task that needs the user opens with this panel on the raised fill: the state in words, the agent's report line, the agent's own words in an amber notice when it gave any, and each checked condition with its result. Passed is green with a check glyph. Not verified is muted: Pomegr had no current evidence, so the condition is neither passed nor failed. Validated with the user and the own condition are judged by the agent, so they show Agent-reported. The session closes the panel.">
        <TaskReviewPanel task={{ review: null, state: "needs_review", completeWhen: REVIEWED_WHEN, report: REVIEWED_REPORT }} session={SAMPLE_SESSION} />
      </Sample>
      <Sample label="Review verdict, running" note="The reviewer is bound and has not reported a verdict.">
        <TaskReviewPanel task={{ state: "needs_review", completeWhen: REVIEWED_WHEN, report: REVIEWED_REPORT, review: { state: "running" } }} />
      </Sample>
      <Sample label="Review verdict, passed" note="The latest verdict in this Review, with its time in neutral ink.">
        <TaskReviewPanel task={{ state: "needs_review", completeWhen: REVIEWED_WHEN, report: REVIEWED_REPORT, review: { state: "passed", at: "2026-10-25T12:00:00.000Z", reasons: [] } }} />
      </Sample>
      <Sample label="Review verdict, failed" note="The reviewer's one-line reasons are a plain list in neutral ink.">
        <TaskReviewPanel task={{ state: "needs_review", completeWhen: REVIEWED_WHEN, report: REVIEWED_REPORT, review: { state: "failed", at: "2026-10-25T12:00:00.000Z", reasons: ["The focused checks failed.", "The required documentation is missing."] } }} />
      </Sample>
      <Sample label="Review panel, stalled and blocked" note="A stalled task has no report, so the panel says the session ended with none and lists no results. A blocked task shows the agent's reason in the same amber notice.">
        <TaskReviewPanel task={{ review: null, state: "stalled", completeWhen: { checks: ["pr_open"], own: null }, report: null }} />
        <TaskReviewPanel task={{ review: null, state: "blocked", completeWhen: { checks: ["pr_open"], own: null }, report: { at: "", blockReason: "The upload service rejects every retry in the test environment.", results: [] } }} />
      </Sample>
      <Sample label="Review panel, done with a report" note="A done task that has an agent report keeps the panel, headed Agent report instead of a state. The report line and each checked condition with its result follow, and the session closes the panel. A done task offers no Mark done and no Requeue.">
        <TaskReviewPanel task={{ review: null, state: "done", completeWhen: REVIEWED_WHEN, report: DONE_REPORT }} session={SAMPLE_SESSION} />
      </Sample>
      <Sample label="Task, read view" note="A started task's text is read-only: the lock line, the tag chips, the 16px/650 title, then the rest as a document. Paragraphs split on blank lines, numbered and bulleted lists are lists, other line breaks stay, `code` is the data font, and a UUID or an ISO date and time is muted data-font text. This is a display heuristic, not Markdown. The text is drawn as React text, never as HTML.">
        <TaskReadView text={DOCUMENT_TEXT} urls={SAMPLE_IMAGE_URLS} note={STARTED_REQUEUE_NOTE} />
      </Sample>
      <Sample label="Task, read view, inline image" note="An image shows in the read view where the text names it, at the sizes of the Task field's inline images, and reads Image n to assistive technology. It shows a 72px square on the ground fill until its bytes are read; this sample stays there.">
        <TaskReadView text={TEXT_WITH_IMAGE} urls={SAMPLE_IMAGE_URLS} note={STARTED_REQUEUE_NOTE} />
      </Sample>
      <Sample label="Run settings, started task" note="The same rows as plain values. Unset values are muted. Remote Control is a Claude Code row only. Complete when is left out when the Review panel lists the results, and the GitHub issue row keeps its place.">
        <TaskRunSettingsRead task={{ id: "T-3", featureId: SAMPLE_FEATURE_ID, run: STARTED_RUN, completeWhen: REVIEWED_WHEN }} board={BOARD_RUNNING} models={MODELS} conditionsListed={false}
          issue={<TaskIssueRow number={142} offered={false} repositoryId="design-system" repositoryName="pomegr" taskId="T-3" unsaved={false} saveFirst={null} onChanged={noop} />} />
        <TaskRunSettingsRead task={{ id: "T-4", featureId: null, run: { provider: "codex", model: null, effort: null }, completeWhen: { checks: [], own: null } }} board={BOARD_RUNNING} models={MODELS} conditionsListed={false}
          issue={<TaskIssueRow number={null} offered={false} repositoryId="design-system" repositoryName="pomegr" taskId="T-4" unsaved={false} saveFirst={null} onChanged={noop} />} />
      </Sample>
      <Sample label="Run settings, observed model differs" note="When the session used another model than the one planned, the amber notice follows the Run on value inside its row, with the amber line, the amber-soft fill and the words Observed model differs. The row aligns the label with the value's first line.">
        <TaskRunSettingsRead task={{ id: "T-3", featureId: SAMPLE_FEATURE_ID, run: STARTED_RUN, completeWhen: REVIEWED_WHEN }} board={BOARD_RUNNING} models={MODELS} conditionsListed
          notice={<ModelDiffersNotice planned="model-large" observed="model-small" />}
          issue={<TaskIssueRow number={null} offered={false} repositoryId="design-system" repositoryName="pomegr" taskId="T-3" unsaved={false} saveFirst={null} onChanged={noop} />} />
      </Sample>
      <Sample label="Feature" note="Feature lists the features that are not done, No feature and New feature…. A feature gives a task context only, not an order. The folded In this feature list counts the feature's tasks and opens on demand.">
        <RunSettings><FeatureFields draft={placed} board={BOARD_RUNNING} onChange={setPlaced} /></RunSettings>
      </Sample>
      <Sample label="Feature, in the Task modal" note="Given the open task, its siblings are listed in board order and the task itself is left out of the list.">
        <RunSettings><FeatureFields draft={placed} board={BOARD_RUNNING} selfId="T-3" onChange={setPlaced} /></RunSettings>
      </Sample>
      <Sample label="New feature" note="New feature… reveals a one-line name in place; Enter or leaving the field commits it.">
        <RunSettings><FeatureFields draft={created} board={BOARD_RUNNING} onChange={setCreated} /></RunSettings>
      </Sample>
    </div>
    <div className="designSystemStates">
      <Sample label="Task field as rich text, no image yet" note="In the desktop app the Task field is rich text in one frame. Text is typed as plain text. One foot strip closes the frame: Attach image with its glyph, the muted hint, and the counter at the end. A paste or a drop that holds an image adds one too.">
        <TaskTextField value={imageText} onChange={setImageText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
      </Sample>
      <Sample label="Task field as rich text, tags and a title line" note="The first line is the 16px/650 title line and the rest is 14px/1.6. A leading run of [ word ] tokens followed by a space becomes the chips row above the title line while typing, and the caret stays at the start of the title. Backspace at the very start of the title removes the last tag. The stored text keeps its brackets, so the counter and every saved value are the same as if they had been typed.">
        <TaskTextField value={tagsText} onChange={setTagsText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
      </Sample>
      <Sample label="Task field as rich text, image in the text"note="An image shows inline, where it was put, at most 180px tall. Backspace and Delete remove it like a character. It shows a 72px square on the ground fill until it is read; these samples stay there.">
        <TaskTextField value={inlineText} onChange={setInlineText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
      </Sample>
      <Sample label="Task field as rich text, full and refused" note="A task holds four images, so Attach image is disabled. A file that cannot be attached is named by one fixed error line under the frame.">
        <TaskTextField value={fullText} onChange={setFullText} images={{ urls: SAMPLE_IMAGE_URLS, error: TASK_IMAGE_TYPE_MESSAGE, onAttach: noImages }} />
      </Sample>
      <Sample label="Queue block, task behind earlier cards" note="The Task modal of a task that waits in the queue starts its body with the Queue block: the label, the task's place in the start order in ink, then one muted line for each reason it has not started. Task IDs name the work that starts first.">
        <TaskQueueWait detail={{ place: "5th to start", lines: ["These are above it in Ready and start first: T-66, T-67, T-68, T-69."] }} />
      </Sample>
      <Sample label="Queue block, queue off and a held start" note="A queue that is off is named first and is not a blocker. A start gate that holds is one line each; a reading that is missing says it is not known yet, never that it passed.">
        <TaskQueueWait detail={{ place: "Next to start", lines: ["The queue is off, so Pomegr starts no task by itself."] }} />
        <TaskQueueWait detail={{ place: "Next to start", lines: ["Start gate: Claude Code is above 85% of the five-hour window.", "Start gate: the working tree state is not known yet."] }} />
      </Sample>
      <Sample label="Queue block, scheduled and no known hold" note="A scheduled task before its own time has no place in the start order yet. A task with no known hold says so and claims nothing more.">
        <TaskQueueWait detail={{ place: "Not in the start order yet", lines: ["Its own start time has not come."] }} />
        <TaskQueueWait detail={{ place: "Next to start", lines: [NO_KNOWN_HOLD] }} />
      </Sample>
      <Sample label="Time field" note="A native time or date-and-time input at control height in the data font, for the queue's Schedule panel. The task modal's Start at row draws it compact: 32px, about 220px wide, with its hint under it.">
        <div className="taskGateField">
          <label className="taskGateFieldLabel" htmlFor="design-system-task-time">Stop starting tasks after</label>
          <input id="design-system-task-time" type="time" className="taskTimeInput" value={startAt} onChange={(event) => setStartAt(event.currentTarget.value)} />
        </div>
      </Sample>
    </div>
    <div className="designSystemGrid designSystemModalGrid">
      <Sample label="Task modal, new" note="The modal frame drawn as static chrome over its scrim: a header with the title and subtitle, the Task field with its counter, on the desktop the Also create a GitHub issue checkbox (checked when the account can create issues), the Run settings rows, and a footer with Cancel and the one primary, a split action whose caret opens Create and queue and Create and start session. The real frame is a modal dialog; this sample has no focus trap and does not make the page inert.">
        <div className="designSystemTaskFrame designSystemTaskModalStage">
          <TaskModalChrome titleId={modalTitleId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
            footer={<>
              <span className="taskModalSpacer" aria-hidden="true" />
              <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
              <CommandSplitAction label="Create task" menuLabel="More ways to create" items={CREATE_FOLLOW_UPS} onAction={noop} onSelect={noop} />
            </>}>
            <TaskTextField value={modalText} onChange={setModalText} />
            <IssueCreateCheckbox option={{ kind: "can" }} checked={issueChecked} onChange={setIssueChecked} />
            <RunSettings>
              <RunFields run={modalRun} models={MODELS} onChange={setModalRun} />
              <CompleteWhenField draft={modalCompleteWhen} onDraftChange={setModalCompleteWhen} />
            </RunSettings>
          </TaskModalChrome>
        </div>
      </Sample>
      <IssueCreateSamples />
      <TaskModalPromoteSamples />
      <TaskModalEditSamples />
      <FeatureModalSamples />
    </div>
  </Section>;
}

const REVIEWED_TASK = { id: "T-35", featureId: SAMPLE_FEATURE_ID, run: STARTED_RUN, completeWhen: REVIEWED_WHEN };

/** Mode edit as static chrome: a task that has not started, one that needs review, one that runs, and the issue confirmation. */
function TaskModalEditSamples() {
  const draftId = useId();
  const reviewId = useId();
  const runningId = useId();
  const [text, setText] = useState(LONG_TASK_TEXT);
  const [feature, setFeature] = useState<FeatureDraft>(NO_FEATURE_DRAFT);
  const [run, setRun] = useState<TaskRun>(DEFAULT_RUN);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const dirty = text.trim() !== LONG_TASK_TEXT;
  return <>
    <Sample label="Task modal, edit" note="A task that has not started. The header holds the title, the task ID, the state chip and the repository. The Task field and every Run settings row hold controls in place. Save is the one primary and stays disabled until the draft differs from the stored task; while it does, Add to queue and Start session are disabled and one quiet line says to save first. Change the text to see it. The GitHub issue row offers Create issue…, and a task promoted from an issue shows its chip there.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={draftId} title="Task" subtitle="pomegr" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-34</span>
            <span className="commandChip taskCardChip neutral">Not queued</span>
          </>}
          footer={<>
            <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
            {dirty
              ? <div className="taskModalNotes"><span className="taskModalNote" role="status">{SAVE_FIRST_LINE}</span></div>
              : <span className="taskModalSpacer" aria-hidden="true" />}
            <button type="button" className="commandSecondaryAction" disabled={dirty} onClick={noop}>Add to queue</button>
            <button type="button" className="commandSecondaryAction" disabled={dirty} onClick={noop}>Start session</button>
            <button type="button" className="commandPrimaryAction" disabled={!dirty} onClick={noop}>Save</button>
          </>}>
          <TaskTextField value={text} onChange={setText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
          <RunSettings>
            <FeatureFields draft={feature} board={BOARD_RUNNING} selfId="T-34" onChange={setFeature} />
            <RunFields run={run} models={MODELS} onChange={setRun} />
            <CompleteWhenField draft={completeWhen} onDraftChange={setCompleteWhen} />
            <IssueRowDemo disabled={dirty} />
            <TaskAfterField task={P15_AFTER} tasks={BOARD_PLAN.tasks} columnName={columnName} editable onChange={noop} />
            <TaskSessionsField started={null} assigned={ASSIGNED} candidates={CANDIDATES} onAssign={noop} onUnassign={noop} />
            <StartAtDemo initial="2026-10-22T02:00" />
          </RunSettings>
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, edit, needs review" note="A started task that needs the user. The Review panel comes first, then the read-only Task with its lock line, then the Run settings as values. The footer is one row: Quiet Delete task, Secondary Start review before Requeue task, then Mark done as the one primary. A started task has no Save, Add to queue or Start session.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={reviewId} title="Task" subtitle="pomegr" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-35</span>
            <span className="commandChip taskCardChip warning">Needs review</span>
          </>}
          footer={<>
            <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
            <span className="taskModalSpacer" aria-hidden="true" />
            <button type="button" className="commandSecondaryAction" onClick={noop}>Start review</button>
            <button type="button" className="commandSecondaryAction" onClick={noop}>Requeue task</button>
            <button type="button" className="commandPrimaryAction" onClick={noop}>Mark done</button>
          </>}>
          <TaskReviewPanel task={{ review: null, state: "needs_review", completeWhen: REVIEWED_WHEN, report: REVIEWED_REPORT }} session={SAMPLE_SESSION} />
          <TaskReadView text={DOCUMENT_TEXT} urls={SAMPLE_IMAGE_URLS} note={STARTED_REQUEUE_NOTE} />
          <TaskRunSettingsRead task={REVIEWED_TASK} board={BOARD_RUNNING} models={MODELS} conditionsListed
            issue={<IssueRowDemo disabled={false} />}
            extra={<>
              <TaskAfterField task={P15_AFTER} tasks={BOARD_PLAN.tasks} columnName={columnName} editable={false} />
              <TaskSessionsField started={STARTED_SESSION} assigned={ASSIGNED} candidates={CANDIDATES} onAssign={noop} onUnassign={noop} />
            </>} />
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, edit, running" note="A started task whose session has not reported. There is no Review panel, so the session line leads. The footer note says that neither Mark done nor Requeue stops the session; both are Secondary, so the view has no primary. A requeue turns the same modal into the editable form.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={runningId} title="Task" subtitle="pomegr" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-36</span>
            <span className="commandChip taskCardChip positive">In progress</span>
          </>}
          footer={<>
            <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
            <div className="taskModalNotes">
              <span className="taskModalNote" role="status">A session is already linked to this task.</span>
              <span className="taskModalNote">{AWAITING_REPORT_NOTE}</span>
            </div>
            <button type="button" className="commandSecondaryAction" onClick={noop}>Requeue task</button>
            <button type="button" className="commandSecondaryAction" onClick={noop}>Mark done</button>
          </>}>
          <TaskSessionLine title="Add a retry budget to the uploader" sessionId="claude:design-system-running" />
          <TaskReadView text={STORED_TEXT} urls={SAMPLE_IMAGE_URLS} note={STARTED_REQUEUE_NOTE} />
          <TaskRunSettingsRead task={{ id: "T-36", featureId: null, run: { ...STARTED_RUN, remoteControl: true, keepWorktree: true }, completeWhen: { checks: ["pr_open"], own: null } }}
            board={BOARD_RUNNING} models={MODELS} conditionsListed={false}
            issue={<TaskIssueRow number={142} offered={false} repositoryId="design-system" repositoryName="pomegr" taskId="T-36" unsaved={false} saveFirst={null} onChanged={noop} />} />
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, edit, create issue" note="Create issue… opens the confirmation in the GitHub issue row. It states what is sent and who can read it before anything is sent: nothing leaves the computer until Create issue. Cancel closes the group and sends nothing.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <IssueConfirmStage />
      </div>
    </Sample>
  </>;
}

/** The GitHub issue row with its confirmation open, over the Run settings of a started task. */
function IssueConfirmStage() {
  const titleId = useId();
  const [confirming, setConfirming] = useState(true);
  return <TaskModalChrome titleId={titleId} title="Task" subtitle="pomegr" onClose={noop}
    titleExtra={<>
      <span className="taskModalId">T-37</span>
      <span className="commandChip taskCardChip neutral">Done</span>
    </>}
    footer={<>
      <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
      <span className="taskModalSpacer" aria-hidden="true" />
    </>}>
    <TaskRunSettingsRead task={{ id: "T-37", featureId: null, run: STARTED_RUN, completeWhen: { checks: ["pr_open"], own: null } }} board={BOARD_RUNNING} models={MODELS} conditionsListed={false}
      issue={<IssueCreateRowView factsId={`${titleId}-facts`} repositoryName="pomegr" confirming={confirming} creating={false} disabled={false} saveFirst={null} failure={null}
        onOpen={() => setConfirming(true)} onCancel={() => setConfirming(false)} onCreate={noop} />} />
  </TaskModalChrome>;
}

function sampleIssue(overrides: Partial<TaskIssue>): TaskIssue {
  const body = "The queue pauses when the data folder is on D: and the repository is on C:.\n\nThe manual start of the same task works.";
  return {
    number: 139, title: "Queue pauses when the worktree is on another drive", body, bodyTruncated: false, hiddenComments: { count: 0, ranges: [] }, characters: 142, tooLong: false,
    authorAssociation: "collaborator", updatedAt: "2026-10-08T12:00:00.000Z", digest: "0".repeat(64), taskId: null, ...overrides,
  };
}

const HIDDEN_BODY = "The queue pauses when the data folder is on D: and the repository is on C:.\n\n<!-- internal note: reproduction steps are in the wiki -->\n\nThe manual start of the same task works.";
const HIDDEN_START = HIDDEN_BODY.indexOf("<!--");
const HIDDEN_END = HIDDEN_BODY.indexOf("-->") + 3;
const CHANGED = sampleIssue({ authorAssociation: "outsider", body: HIDDEN_BODY, hiddenComments: { count: 1, ranges: [{ start: HIDDEN_START, end: HIDDEN_END }] }, characters: 151, digest: "1".repeat(64) });

/** Mode issue as static chrome. */
function TaskModalPromoteSamples() {
  const normalId = useId();
  const changedId = useId();
  const unsavedId = useId();
  const [run, setRun] = useState<TaskRun>(DEFAULT_RUN);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const [changedRun, setChangedRun] = useState<TaskRun>(DEFAULT_RUN);
  const [changedCompleteWhen, setChangedCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const closes = (number: number) => <span className="taskModalNote taskModalCloses">The pull request will say Closes <span className="taskModalCloseRef">#{number}</span>.</span>;
  return <>
    <Sample label="Task modal, promote issue" note="One GitHub issue becomes a task. The heading is New task; the Source group holds the issue chip, who opened it and the title, and the raw body is read-only: the renderer never sends task text. Feature, Run on and Effort, and Complete when are the New task form's rows (Feature is drawn in its own samples above). Promote issue is the one primary; the footer line says what the pull request will say.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={normalId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
          footer={<>
            {closes(139)}
            <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
            <button type="button" className="commandPrimaryAction" onClick={noop}>Promote issue</button>
          </>}>
          <PromoteIssueSummary issue={sampleIssue({})} />
          <RunSettings>
            <RunFields run={run} models={MODELS} onChange={setRun} />
            <CompleteWhenField draft={completeWhen} onDraftChange={setCompleteWhen} />
          </RunSettings>
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, promote issue, outside contributor and changed" note="An outside contributor and a hidden comment each get a notice, in that order, over the raw body with the comment struck through. After a promote answers conflict, the warning notice offers Show new version, which reads the issues once more; Promote issue stays disabled until the new version arrives, and the chosen fields are kept.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={changedId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
          footer={<>
            {closes(139)}
            <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
            <button type="button" className="commandPrimaryAction" disabled onClick={noop}>Promote issue</button>
          </>}>
          <PromoteIssueSummary issue={CHANGED} notices={<PromoteOutcomeNotice outcome={{ kind: "conflict", digest: CHANGED.digest }} onShowNewVersion={noop} />} />
          <RunSettings>
            <RunFields run={changedRun} models={MODELS} onChange={setChangedRun} />
            <CompleteWhenField draft={changedCompleteWhen} onDraftChange={setChangedCompleteWhen} />
          </RunSettings>
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, promote issue, run settings not saved" note="The task exists once the monitor says so. When the follow-up update fails, the modal says so in a fixed notice, drops the fields that no longer apply and offers only Close, so an issue is never promoted twice.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={unsavedId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
          footer={<>
            <span className="taskModalSpacer" aria-hidden="true" />
            <button type="button" className="commandSecondaryAction" onClick={noop}>Close</button>
          </>}>
          <PromoteIssueSummary issue={sampleIssue({ taskId: "T-40" })} notices={<PromoteOutcomeNotice outcome={{ kind: "unsaved", taskId: "T-40" }} />} />
        </TaskModalChrome>
      </div>
    </Sample>
  </>;
}

const CANNOT: { label: string; option: IssueCreateOption }[] = [
  { label: "Not signed in", option: { kind: "cannot", reason: "not_signed_in" } },
  { label: "GitHub CLI not installed", option: { kind: "cannot", reason: "cli_missing" } },
  { label: "Issues turned off", option: { kind: "cannot", reason: "issues_disabled" } },
  { label: "No access", option: { kind: "cannot", reason: "no_access" } },
  { label: "GitHub could not be read", option: { kind: "cannot", reason: "unreadable" } },
];

/** The GitHub issue row of a task that is not on GitHub, with its own open state. Create issue sends nothing here. */
function IssueRowDemo({ disabled }: { disabled: boolean }) {
  const factsId = useId();
  const [confirming, setConfirming] = useState(false);
  return <IssueCreateRowView factsId={factsId} repositoryName="pomegr" confirming={confirming} creating={false} disabled={disabled} saveFirst={null} failure={null}
    onOpen={() => setConfirming(true)} onCancel={() => setConfirming(false)} onCreate={noop} />;
}

function IssueRowSample({ id, ...state }: { id: string; confirming: boolean; creating: boolean; disabled: boolean; saveFirst: string | null; failure: TaskIssueCreateError | null }) {
  return <RunSettings>
    <IssueCreateRowView factsId={id} repositoryName="pomegr" {...state} onOpen={noop} onCancel={noop} onCreate={noop} />
  </RunSettings>;
}

function IssueCreateSamples() {
  const [checked, setChecked] = useState(true);
  const [off, setOff] = useState(false);
  return <>
    <Sample label="Also create a GitHub issue" note="Under the Task counter. Unchecked by default; available when the account can create issues in the repository; the task is created first and a failed issue never costs it. Nothing is drawn in a browser or before the first GitHub read answers.">
      <div className="designSystemStates">
        <IssueCreateCheckbox option={{ kind: "can" }} checked={checked} onChange={setChecked} />
        <IssueCreateCheckbox option={{ kind: "can" }} checked={off} onChange={setOff} />
      </div>
    </Sample>
    <Sample label="Also create a GitHub issue, unavailable" note="Unchecked and disabled, with the one reason as its helper.">
      <div className="designSystemStates">
        {CANNOT.map(({ label, option }) => <div key={label}>
          <p className="newTaskHelper">{label}</p>
          <IssueCreateCheckbox option={option} checked onChange={noop} />
        </div>)}
      </div>
    </Sample>
    <Sample label="GitHub issue, not on GitHub" note="Task modal, edit, for a task with no source, on the desktop. The row reads None and offers the Quiet Create issue…, which is disabled while the draft is unsaved or a create runs. A failure shows one fixed line and the action stays offered.">
      <div className="designSystemRows">
        <IssueRowSample id="design-system-issue-facts-1" confirming={false} creating={false} disabled={false} saveFirst={null} failure={null} />
        <IssueRowSample id="design-system-issue-facts-2" confirming={false} creating={false} disabled saveFirst={SAVE_FIRST_LINE} failure={null} />
        <IssueRowSample id="design-system-issue-facts-3" confirming={false} creating={false} disabled={false} saveFirst={null} failure="not_signed_in" />
      </div>
    </Sample>
    <Sample label="GitHub issue, confirmation" note={`Create issue… reveals this group inside the row: ${ISSUE_CONFIRM_FACTS.join(" ")} Create issue sends the task once and Cancel closes the group; nothing is sent before Create issue. On success the board is read again and the row shows the issue chip.`}>
      <div className="designSystemRows">
        <IssueRowSample id="design-system-issue-facts-4" confirming creating={false} disabled={false} saveFirst={null} failure={null} />
        <IssueRowSample id="design-system-issue-facts-5" confirming creating disabled={false} saveFirst={null} failure={null} />
        <IssueRowSample id="design-system-issue-facts-6" confirming creating={false} disabled saveFirst={SAVE_FIRST_LINE} failure={null} />
      </div>
    </Sample>
  </>;
}
