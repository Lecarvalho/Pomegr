"use client";

import { useId, useState } from "react";
import { FeatureFormFields } from "../tasks/FeatureFormFields";
import { FeatureSiblings } from "../tasks/FeatureFields";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { EMPTY_FEATURE_DRAFT, featureDescriptionOver, featurePatch, type FeatureFailure, type FeatureFormDraft } from "../tasks/feature-form";
import { featureCounts } from "../tasks/task-features";
import { Sample } from "./DesignSystemKit";
import { BOARD_RUNNING, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const STORED_NAME = "Upload reliability";
const STORED_DETAILS = {
  description: "Uploads fail silently on a flaky network. Every task here works on the uploader: keep the public API, add a capped backoff, and record each retry as one normalized event.",
  appVersion: "1.4.0",
};
const STORED: FeatureFormDraft = { name: STORED_NAME, description: STORED_DETAILS.description, appVersion: STORED_DETAILS.appVersion };
const COUNTS = featureCounts(BOARD_RUNNING, SAMPLE_FEATURE_ID);

/** The Feature modal drawn as static chrome over its scrim, with live counters and a live primary. The real frame is a modal dialog. */
function FeatureModalChrome({ mode, initial, failure, unread }: { mode: "new" | "edit"; initial: FeatureFormDraft; failure?: FeatureFailure; unread?: boolean }) {
  const titleId = useId();
  const [draft, setDraft] = useState(initial);
  const edit = mode === "edit";
  const valid = draft.name.trim() !== "" && !featureDescriptionOver(draft);
  const changed = Object.keys(featurePatch({ ...EMPTY_FEATURE_DRAFT, name: STORED_NAME }, draft, unread ? null : STORED_DETAILS)).length > 0;
  return <div className="designSystemTaskFrame designSystemTaskModalStage">
    <TaskModalChrome titleId={titleId} title={edit ? "Feature" : "New feature"} subtitle="pomegr" onClose={noop}
      titleExtra={edit ? <span className="commandChip taskCardChip neutral">{COUNTS.done} of {COUNTS.total} done</span> : undefined}
      footer={<>
        <span className="taskModalSpacer" aria-hidden="true" />
        {!edit && <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>}
        <button type="button" className="commandPrimaryAction" disabled={!valid || (edit && !changed)} onClick={noop}>{edit ? "Save" : "Create feature"}</button>
      </>}>
      <FeatureFormFields draft={draft} onChange={setDraft} failure={failure} detailsDisabled={unread} readFailed={unread} />
      {edit && <FeatureSiblings board={BOARD_RUNNING} featureId={SAMPLE_FEATURE_ID} label="Tasks" steps onOpenTask={noop} />}
    </TaskModalChrome>
  </div>;
}

/** The Feature modal in its two modes, with its three failure lines. */
export function FeatureModalSamples() {
  return <>
    <Sample label="Feature modal, new feature" note="The task modal's frame with a form of three fields: Title (required, 80 characters), Description (2,000) and App version (40, in the data font, optional). Title and Description each end with a helper and a live counter; past its bound the Description counter takes the error colour and the primary is disabled. Create feature stays disabled until the title holds text; type to see the counters and the primary change.">
      <FeatureModalChrome mode="new" initial={EMPTY_FEATURE_DRAFT} />
    </Sample>
    <Sample label="Feature modal, feature, saved" note="Mode Feature holds the stored values as a local draft. The header carries the feature's progress chip. Save is the one primary and stays disabled until the draft differs. The folded Tasks list is the task modal's In this feature list, and a row opens that task. No Delete action is drawn.">
      <FeatureModalChrome mode="edit" initial={STORED} />
    </Sample>
    <Sample label="Feature modal, feature, changed" note="A draft that differs from the stored feature enables Save, which sends only what changed.">
      <FeatureModalChrome mode="edit" initial={{ ...STORED, name: `${STORED_NAME} and retries`, appVersion: "1.5.0" }} />
    </Sample>
    <Sample label="Feature modal, details not read" note="Description and App version stay disabled and empty until the desktop read answers. If it fails, one line says so, the two fields stay disabled, and the title stays editable.">
      <FeatureModalChrome mode="edit" initial={{ ...EMPTY_FEATURE_DRAFT, name: STORED_NAME }} unread />
    </Sample>
    <Sample label="Feature modal, duplicate title" note="Another feature holds the title: one fixed line under the Title input, which names it with aria-describedby. The modal stays open and keeps what was typed.">
      <FeatureModalChrome mode="new" initial={{ ...EMPTY_FEATURE_DRAFT, name: "Client cleanup" }} failure="duplicate" />
    </Sample>
    <Sample label="Feature modal, could not save" note="Any other failure shows one fixed line under the fields. The modal stays open and keeps what was typed.">
      <FeatureModalChrome mode="new" initial={{ ...EMPTY_FEATURE_DRAFT, name: "Retry telemetry" }} failure="failed" />
    </Sample>
    <Sample label="Feature modal, feature limit" note="A board holds 50 features. + New feature is disabled at the limit; a create that still arrives shows one fixed line under the fields.">
      <FeatureModalChrome mode="new" initial={{ ...EMPTY_FEATURE_DRAFT, name: "Retry telemetry" }} failure="limit" />
    </Sample>
  </>;
}
