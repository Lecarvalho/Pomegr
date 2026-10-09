"use client";

import { useState } from "react";
import { FeatureFields } from "../tasks/FeatureFields";
import { DoneWhenField, RunFields } from "../tasks/TaskFields";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, NO_MODELS, type DoneWhenDraft } from "../tasks/task-fields";
import { NO_FEATURE_DRAFT, type FeatureDraft } from "../tasks/task-features";
import type { TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_RUNNING, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const RESULTS = new Map([["pr_open", false], ["tree_clean", true]] as const);

export function TaskFieldsSection() {
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: "model-large", effort: "high" });
  const [unset, setUnset] = useState<TaskRun>(EMPTY_RUN);
  const [fresh, setFresh] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [startAt, setStartAt] = useState("02:00");
  const [placed, setPlaced] = useState<FeatureDraft>({ featureId: SAMPLE_FEATURE_ID, creating: false, name: "", step: 2 });
  const [created, setCreated] = useState<FeatureDraft>({ ...NO_FEATURE_DRAFT, creating: true, name: "Retry telemetry" });
  const [reported, setReported] = useState<DoneWhenDraft>({ checks: ["pr_open", "tree_clean"], ownEnabled: true, ownText: "The store rejects a malformed record." });
  return <Section id="task-fields" title="Task fields" lede="Run on, Effort, Done when and Feature, shared by the New task and Task panels. Run on is one select that names provider and model, with a Default model entry per provider and Not set. Effort is an optional four-way segmented control: pressing the pressed segment clears it. Done when is five checks and an own condition judged by the agent. Feature and Step in feature are two selects over the board's unfinished features, with a folded list of the feature's other tasks.">
    <div className="designSystemStates">
      <Sample label="Run on and Effort, chosen" note="Models come from the model list the app already serves; the names here are static samples.">
        <RunFields run={run} models={MODELS} onChange={setRun} />
      </Sample>
      <Sample label="Nothing chosen, no model list" note="Nothing selected is valid. A provider with no observed model offers only its Default model.">
        <RunFields run={unset} models={NO_MODELS} onChange={setUnset} />
      </Sample>
      <Sample label="Done when, new task" note="Pull request open and Working tree clean start checked. The own condition counts only while its checkbox is on and its text is not blank.">
        <DoneWhenField draft={fresh} onDraftChange={setFresh} />
      </Sample>
      <Sample label="Done when, reported" note="With an agent report, each checked condition shows Passed or Not passed in one list.">
        <DoneWhenField draft={reported} layout="list" results={RESULTS} ownNote="Agent-reported" onDraftChange={setReported} />
      </Sample>
      <Sample label="Feature and Step" note="Feature lists unfinished features, No feature and New feature…; Step in feature offers Last or an existing step. The folded In this feature list counts the feature's tasks and opens on demand.">
        <FeatureFields draft={placed} board={BOARD_RUNNING} onChange={setPlaced} />
      </Sample>
      <Sample label="Feature and Step, in the Task panel" note="Given the open task, its siblings lead with their step number and the task itself is left out of the list.">
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
  </Section>;
}
