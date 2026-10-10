"use client";

import { useId, useState } from "react";
import { FeatureFields } from "../tasks/FeatureFields";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { DoneWhenField, RunFields, TaskTextField } from "../tasks/TaskFields";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, NO_MODELS, type DoneWhenDraft } from "../tasks/task-fields";
import { NO_FEATURE_DRAFT, type FeatureDraft } from "../tasks/task-features";
import type { TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_RUNNING, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const RESULTS = new Map([["pr_open", false], ["tree_clean", true]] as const);
const noop = () => undefined;

export function TaskFieldsSection() {
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: "model-large", effort: "high" });
  const [unset, setUnset] = useState<TaskRun>(EMPTY_RUN);
  const [fresh, setFresh] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [startAt, setStartAt] = useState("02:00");
  const [placed, setPlaced] = useState<FeatureDraft>({ featureId: SAMPLE_FEATURE_ID, creating: false, name: "", step: 2 });
  const [created, setCreated] = useState<FeatureDraft>({ ...NO_FEATURE_DRAFT, creating: true, name: "Retry telemetry" });
  const modalTitleId = useId();
  const [modalText, setModalText] = useState("");
  const [modalRun, setModalRun] = useState<TaskRun>(EMPTY_RUN);
  const [modalDoneWhen, setModalDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [reported, setReported] = useState<DoneWhenDraft>({ checks: ["pr_open", "tree_clean"], ownText: "The store rejects a malformed record." });
  return <Section id="task-fields" title="Task fields" lede="The Task field, Run on, Effort, Done when and Feature, shared by the New task and Task modal forms (the modal has two modes, new and edit). Run on is one select that names provider and model, with a Default model entry per provider and Not set. Effort is an optional four-way segmented control: pressing the pressed segment clears it. Done when is five short checks in a wrapping row and one input for an own condition judged by the agent. Feature and Step are two selects over the board's unfinished features, with a folded list of the feature's other tasks.">
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
      <Sample label="Time field" note="A native time or date-and-time input at control height in the data font, for the queue's Schedule panel and a task's own start time.">
        <div className="taskGateField">
          <label className="taskGateFieldLabel" htmlFor="design-system-task-time">Stop starting tasks after</label>
          <input id="design-system-task-time" type="time" className="taskTimeInput" value={startAt} onChange={(event) => setStartAt(event.currentTarget.value)} />
        </div>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Task modal, new" note="The modal frame drawn as static chrome over its scrim: a header with the title and subtitle, the Task field with its counter, Run on and Effort in one row, Done when, and a footer with Cancel and the one primary. The real frame is a modal dialog; this sample has no focus trap and does not make the page inert.">
        <div className="designSystemTaskFrame designSystemTaskModalStage">
          <TaskModalChrome titleId={modalTitleId} title="New task" subtitle="pomegr · in Backlog" onClose={noop}
            footer={<>
              <span className="taskModalSpacer" aria-hidden="true" />
              <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
              <button type="button" className="commandPrimaryAction" onClick={noop}>Create task</button>
            </>}>
            <TaskTextField value={modalText} onChange={setModalText} />
            <RunFields run={modalRun} models={MODELS} onChange={setModalRun} />
            <DoneWhenField draft={modalDoneWhen} onDraftChange={setModalDoneWhen} />
          </TaskModalChrome>
        </div>
      </Sample>
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
    <Sample label="Task modal, edit" note="The header holds the title, the task ID, the state chip and the subtitle. Save is the one primary and stays disabled until the draft differs from the stored task; while it does, Add to queue and Start session are disabled and one quiet line says to save first. Change the text to see it.">
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
          <TaskTextField value={text} onChange={setText} />
          <RunFields run={run} models={MODELS} onChange={setRun} />
          <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
        </TaskModalChrome>
      </div>
    </Sample>
    <Sample label="Task modal, edit, needs review" note="A task that needs the user leads the footer with its resolutions as Secondary actions in a row of their own, so Save stays the one primary. Done when shows each checked condition's outcome from the agent's report.">
      <div className="designSystemTaskFrame designSystemTaskModalStage">
        <TaskModalChrome titleId={reviewId} title="Task" subtitle="pomegr · in Review" onClose={noop}
          titleExtra={<>
            <span className="taskModalId">T-35</span>
            <span className="commandChip taskCardChip warning">Needs review</span>
          </>}
          footer={<>
            <div className="taskModalResolve">
              <button type="button" className="commandSecondaryAction" onClick={noop}>Mark done and resume queue</button>
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
            footnote={<span className="newTaskHelper taskDoneWhenNote">Agent reported complete.</span>} />
        </TaskModalChrome>
      </div>
    </Sample>
  </>;
}
