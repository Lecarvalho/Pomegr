"use client";

import { useId, useState } from "react";
import { FeatureFields } from "../tasks/FeatureFields";
import { IssueCreateCheckbox, IssueCreateRowView, type IssueCreateOption } from "../tasks/IssueCreate";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { PromoteIssueSummary, PromoteOutcomeNotice, TaskModalSource } from "../tasks/TaskModalPromote";
import { DoneWhenField, RunFields, TaskTextField } from "../tasks/TaskFields";
import { TASK_IMAGE_TYPE_MESSAGE } from "../tasks/task-images-desktop";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, NO_MODELS, type DoneWhenDraft } from "../tasks/task-fields";
import { NO_FEATURE_DRAFT, type FeatureDraft } from "../tasks/task-features";
import type { TaskIssue } from "../tasks/task-issues-desktop";
import type { TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_RUNNING, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const RESULTS = new Map([["pr_open", false], ["tree_clean", true]] as const);
const noop = () => undefined;
// Static samples: an image that is still being read has no URL, so no image file ships with the page.
const SAMPLE_IMAGE_IDS = ["img-000000000001", "img-000000000002", "img-000000000003", "img-000000000004"];
const SAMPLE_IMAGE_URLS = new Map<string, string | null>(SAMPLE_IMAGE_IDS.map((id) => [id, null]));
const noImages = () => [];
const TEXT_WITH_IMAGE = `Match the settings page to this mock-up:\n[image:${SAMPLE_IMAGE_IDS[0]}]\nKeep the header as it is.`;
const TEXT_FULL = `Compare the four states: ${SAMPLE_IMAGE_IDS.map((id) => `[image:${id}]`).join(" ")}`;

export function TaskFieldsSection() {
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: "model-large", effort: "high" });
  const [unset, setUnset] = useState<TaskRun>(EMPTY_RUN);
  const [fresh, setFresh] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [startAt, setStartAt] = useState("02:00");
  const [placed, setPlaced] = useState<FeatureDraft>({ featureId: SAMPLE_FEATURE_ID, creating: false, name: "", step: 2 });
  const [created, setCreated] = useState<FeatureDraft>({ ...NO_FEATURE_DRAFT, creating: true, name: "Retry telemetry" });
  const modalTitleId = useId();
  const [modalText, setModalText] = useState("");
  const [imageText, setImageText] = useState("");
  const [inlineText, setInlineText] = useState(TEXT_WITH_IMAGE);
  const [fullText, setFullText] = useState(TEXT_FULL);
  const [issueChecked, setIssueChecked] = useState(true);
  const [modalRun, setModalRun] = useState<TaskRun>(EMPTY_RUN);
  const [modalDoneWhen, setModalDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [reported, setReported] = useState<DoneWhenDraft>({ checks: ["pr_open", "tree_clean"], ownText: "The store rejects a malformed record." });
  return <Section id="task-fields" title="Task fields" lede="The Task field, Run on, Effort, Done when and Feature, shared by the New task and Task modal forms (the modal has three modes: new, promote issue and edit). Run on is one select that names provider and model, with a Default model entry per provider and Not set. Effort is an optional four-way segmented control: pressing the pressed segment clears it. Done when is five short checks in a wrapping row and one input for an own condition judged by the agent. Feature and Step are two selects over the board's unfinished features, with a folded list of the feature's other tasks.">
    <div className="designSystemStates">
      <Sample label="Run on and Effort, chosen" note="Models come from the model list the app already serves; the names here are static samples.">
        <RunFields run={run} models={MODELS} onChange={setRun} />
      </Sample>
      <Sample label="Nothing chosen, no model list" note="Nothing selected is valid. A provider with no observed model offers only its Default model.">
        <RunFields run={unset} models={NO_MODELS} onChange={setUnset} />
      </Sample>
      <Sample label="Done when, new task" note="PR open and Tree clean start checked. A non-blank own condition counts; a blank one is none.">
        <DoneWhenField draft={fresh} onDraftChange={setFresh} />
      </Sample>
      <Sample label="Done when, reported" note="With an agent report, each checked condition shows Passed or Not passed in one list.">
        <DoneWhenField draft={reported} results={RESULTS} ownNote="Agent-reported" onDraftChange={setReported} />
      </Sample>
      <Sample label="Feature and Step" note="Feature lists unfinished features, No feature and New feature…; Step offers Last or an existing step. The folded In this feature list counts the feature's tasks and opens on demand.">
        <FeatureFields draft={placed} board={BOARD_RUNNING} onChange={setPlaced} />
      </Sample>
      <Sample label="Feature and Step, in the Task modal" note="Given the open task, its siblings lead with their step number and the task itself is left out of the list.">
        <FeatureFields draft={placed} board={BOARD_RUNNING} selfId="T-3" onChange={setPlaced} />
      </Sample>
      <Sample label="New feature" note="New feature… reveals a one-line name in place; Enter or leaving the field commits it.">
        <FeatureFields draft={created} board={BOARD_RUNNING} onChange={setCreated} />
      </Sample>
      <Sample label="Task field as rich text, no image yet" note="In the desktop app the Task field is rich text in one frame. Text is typed as plain text. Attach image sits at the foot of the frame and opens the file picker; a paste or a drop that holds an image adds it too.">
        <TaskTextField value={imageText} onChange={setImageText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
      </Sample>
      <Sample label="Task field as rich text, image in the text" note="An image shows inline, where it was put, at most 180px tall. Backspace and Delete remove it like a character. It shows a 72px square on the ground fill until it is read; these samples stay there.">
        <TaskTextField value={inlineText} onChange={setInlineText} images={{ urls: SAMPLE_IMAGE_URLS, onAttach: noImages }} />
      </Sample>
      <Sample label="Task field as rich text, full and refused" note="A task holds four images, so Attach image is disabled. A file that cannot be attached is named by one fixed error line under the frame.">
        <TaskTextField value={fullText} onChange={setFullText} images={{ urls: SAMPLE_IMAGE_URLS, error: TASK_IMAGE_TYPE_MESSAGE, onAttach: noImages }} />
      </Sample>
      <Sample label="Time field" note="A native time or date-and-time input at control height in the data font, for the queue's Schedule panel and a task's own start time.">
        <div className="taskGateField">
          <label className="taskGateFieldLabel" htmlFor="design-system-task-time">Stop starting tasks after</label>
          <input id="design-system-task-time" type="time" className="taskTimeInput" value={startAt} onChange={(event) => setStartAt(event.currentTarget.value)} />
        </div>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Task modal, new" note="The modal frame drawn as static chrome over its scrim: a header with the title and subtitle, the Task field with its counter, on the desktop the Also create a GitHub issue checkbox (checked when the account can create issues), Run on and Effort in one row, Done when, and a footer with Cancel and the one primary. The real frame is a modal dialog; this sample has no focus trap and does not make the page inert.">
        <div className="designSystemTaskFrame designSystemTaskModalStage">
          <TaskModalChrome titleId={modalTitleId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
            footer={<>
              <span className="taskModalSpacer" aria-hidden="true" />
              <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
              <button type="button" className="commandPrimaryAction" onClick={noop}>Create task</button>
            </>}>
            <TaskTextField value={modalText} onChange={setModalText} />
            <IssueCreateCheckbox option={{ kind: "can" }} checked={issueChecked} onChange={setIssueChecked} />
            <RunFields run={modalRun} models={MODELS} onChange={setModalRun} />
            <DoneWhenField draft={modalDoneWhen} onDraftChange={setModalDoneWhen} />
          </TaskModalChrome>
        </div>
      </Sample>
      <IssueCreateSamples />
      <TaskModalPromoteSamples />
      <TaskModalEditSamples />
    </div>
  </Section>;
}

const STORED_TEXT = "Retry failed uploads with a capped backoff and cover it with a test.";

/** Mode edit as static chrome: Save sends nothing here. Changing the text shows how an unsaved draft holds the other footer actions. */
function TaskModalEditSamples() {
  const draftId = useId();
  const reviewId = useId();
  const [text, setText] = useState(STORED_TEXT);
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: null, effort: null });
  const [doneWhen, setDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const dirty = text.trim() !== STORED_TEXT;
  const reviewed: DoneWhenDraft = { checks: ["pr_open", "tree_clean"], ownText: "The store rejects a malformed record." };
  return <>
    <Sample label="Task modal, edit" note="The header holds the title, the task ID, the state chip and the subtitle. Save is the one primary and stays disabled until the draft differs from the stored task; while it does, Add to queue and Start session are disabled and one quiet line says to save first. Change the text to see it. A task promoted from a GitHub issue starts the body with its Source block: the label, the issue chip and a caption; the text stays editable.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={draftId} title="Task" subtitle="pomegr · in Backlog" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-34</span>
            <span className="commandChip taskCardChip neutral">Not queued</span>
          </>}
          footer={<>
            {dirty && <div className="taskModalResolve"><span className="taskModalNote" role="status">Save your changes first.</span></div>}
            <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
            <span className="taskModalSpacer" aria-hidden="true" />
            <button type="button" className="commandSecondaryAction" disabled={dirty} onClick={noop}>Add to queue</button>
            <button type="button" className="commandSecondaryAction" disabled={dirty} onClick={noop}>Start session</button>
            <button type="button" className="commandPrimaryAction" disabled={!dirty} onClick={noop}>Save</button>
          </>}>
          <TaskModalSource number={142} caption="GitHub issue" />
          <TaskTextField value={text} onChange={setText} />
          <RunFields run={run} models={MODELS} onChange={setRun} />
          <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, edit, needs review" note="A task that needs the user leads the footer with its resolutions as Secondary actions in a row of their own, so Save stays the one primary. Done when shows each checked condition's outcome from the agent's report, and the agent's own attention line when it gave one.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={reviewId} title="Task" subtitle="pomegr · in Review" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-35</span>
            <span className="commandChip taskCardChip warning">Needs review</span>
          </>}
          footer={<>
            <div className="taskModalResolve">
              <button type="button" className="commandSecondaryAction" onClick={noop}>Mark done</button>
              <button type="button" className="commandSecondaryAction" onClick={noop}>Requeue task</button>
            </div>
            <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
            <span className="taskModalSpacer" aria-hidden="true" />
            <button type="button" className="commandPrimaryAction" disabled onClick={noop}>Save</button>
          </>}>
          <div className="taskModalSession">
            <p className="taskModalSessionTitle">Add a retry budget to the uploader</p>
            <span className="newTaskHelper">Title from the session</span>
          </div>
          <TaskTextField value={STORED_TEXT} onChange={noop} />
          <DoneWhenField draft={reviewed} results={RESULTS} ownNote="Agent-reported" onDraftChange={noop}
            footnote={<span className="newTaskHelper taskDoneWhenNote">Agent reported complete and asks for your attention: The retry budget of five is a guess; confirm it.</span>} />
        </TaskModalChrome>
      </div>
    </Sample>
  </>;
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

/** Mode issue as static chrome: the same pieces as the real form, with nothing sent. The fields keep local state. */
function TaskModalPromoteSamples() {
  const normalId = useId();
  const changedId = useId();
  const unsavedId = useId();
  const [run, setRun] = useState<TaskRun>(EMPTY_RUN);
  const [doneWhen, setDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [changedRun, setChangedRun] = useState<TaskRun>(EMPTY_RUN);
  const [changedDoneWhen, setChangedDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const closes = (number: number) => <span className="taskModalNote taskModalCloses">The pull request will say Closes <span className="taskModalCloseRef">#{number}</span>.</span>;
  return <>
    <Sample label="Task modal, promote issue" note="One GitHub issue becomes a task. The heading is New task; the Source group holds the issue chip, who opened it and the title, and the raw body is read-only: the renderer never sends task text. Feature and Step, Run on and Effort, and Done when are the New task form's (Feature and Step are drawn in their own samples above). Promote issue is the one primary; the footer line says what the pull request will say.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={normalId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
          footer={<>
            {closes(139)}
            <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
            <button type="button" className="commandPrimaryAction" onClick={noop}>Promote issue</button>
          </>}>
          <PromoteIssueSummary issue={sampleIssue({})} />
          <RunFields run={run} models={MODELS} onChange={setRun} />
          <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
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
          <RunFields run={changedRun} models={MODELS} onChange={setChangedRun} />
          <DoneWhenField draft={changedDoneWhen} onDraftChange={setChangedDoneWhen} />
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

/** Create a GitHub issue from a task: the New task checkbox in each state, and the Edit row for a task with no source. */
function IssueCreateSamples() {
  const [checked, setChecked] = useState(true);
  const [off, setOff] = useState(false);
  return <>
    <Sample label="Also create a GitHub issue" note="Under the Task counter. Checked by default when the account can create issues in the repository; the task is created first and a failed issue never costs it. Nothing is drawn in a browser or before the first GitHub read answers.">
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
    <Sample label="Source, not on GitHub" note="Task modal, edit, for a task with no source, on the desktop. Create GitHub issue is disabled while the draft is unsaved or a create runs; a failure shows one fixed line and the action stays offered. On success the board is read again and the Source block with the issue chip replaces this row.">
      <div className="designSystemStates">
        <IssueCreateRowView helperId="design-system-issue-helper-1" creating={false} disabled={false} saveFirst={null} failure={null} onCreate={noop} />
        <IssueCreateRowView helperId="design-system-issue-helper-2" creating disabled saveFirst={null} failure={null} onCreate={noop} />
        <IssueCreateRowView helperId="design-system-issue-helper-3" creating={false} disabled saveFirst="Save your changes first." failure={null} onCreate={noop} />
        <IssueCreateRowView helperId="design-system-issue-helper-4" creating={false} disabled={false} saveFirst={null} failure="not_signed_in" onCreate={noop} />
      </div>
    </Sample>
  </>;
}
