"use client";

import { useState } from "react";
import { DoneWhenField, RunFields } from "../tasks/TaskFields";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, NO_MODELS, type DoneWhenDraft } from "../tasks/task-fields";
import type { TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const RESULTS = new Map([["pr_open", false], ["tree_clean", true]] as const);

export function TaskFieldsSection() {
  const [run, setRun] = useState<TaskRun>({ provider: "claude", model: "model-large", effort: "high" });
  const [unset, setUnset] = useState<TaskRun>(EMPTY_RUN);
  const [fresh, setFresh] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [reported, setReported] = useState<DoneWhenDraft>({ checks: ["pr_open", "tree_clean"], ownEnabled: true, ownText: "The store rejects a malformed record." });
  return <Section id="task-fields" title="Task fields" lede="Run on, Effort and Done when, shared by the New task and Task panels. Run on is one select that names provider and model, with a Default model entry per provider and Not set. Effort is an optional four-way segmented control: pressing the pressed segment clears it. Done when is five checks and an own condition judged by the agent.">
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
    </div>
  </Section>;
}
