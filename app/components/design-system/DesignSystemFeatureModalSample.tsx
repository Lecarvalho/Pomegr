"use client";

import { useId, useState } from "react";
import { FeatureEditFooter } from "../tasks/FeatureEditFooter";
import { FeatureFormFields } from "../tasks/FeatureFormFields";
import { FeatureSiblings } from "../tasks/FeatureFields";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { EMPTY_FEATURE_DRAFT, featureBlocker, featureDescriptionOver, featurePatch, type FeatureFailure, type FeatureFormDraft } from "../tasks/feature-form";
import { featureCounts } from "../tasks/task-features";
import { Sample } from "./DesignSystemKit";
import { BOARD_BLOCKED, BOARD_RUNNING, SAMPLE_FEATURE_ID } from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const STORED_NAME = "Upload reliability";
const STORED_DETAILS = {
  description: "Uploads fail silently on a flaky network. Every task here works on the uploader: keep the public API, add a capped backoff, and record each retry as one normalized event.",
  appVersion: "1.4.0",
};
const STORED: FeatureFormDraft = { name: STORED_NAME, description: STORED_DETAILS.description, appVersion: STORED_DETAILS.appVersion };
const COUNTS = featureCounts(BOARD_RUNNING, SAMPLE_FEATURE_ID);

/** The Feature modal drawn as static chrome over its scrim, with live counters and a live primary. The real frame is a modal dialog. */
function FeatureModalChrome({ mode, initial, failure, unread, board = BOARD_RUNNING, confirm = false }: {
  mode: "new" | "edit"; initial: FeatureFormDraft; failure?: FeatureFailure; unread?: boolean; board?: typeof BOARD_RUNNING; confirm?: boolean;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(confirm);
  const edit = mode === "edit";
  const valid = draft.name.trim() !== "" && !featureDescriptionOver(draft);
  const changed = Object.keys(featurePatch({ ...EMPTY_FEATURE_DRAFT, name: STORED_NAME }, draft, unread ? null : STORED_DETAILS)).length > 0;
  return <div className="designSystemTaskFrame designSystemTaskModalStage">
    <TaskModalChrome titleId={titleId} title={edit ? "Feature" : "New feature"} subtitle="pomegr" onClose={noop}
      titleExtra={edit ? <span className="commandChip taskCardChip neutral">{COUNTS.done} of {COUNTS.total} done</span> : undefined}
      footer={edit
        ? <FeatureEditFooter confirming={confirming} deleting={false} busy={false} canSave={valid && changed} taskCount={featureCounts(board, SAMPLE_FEATURE_ID).total}
          blockerId={featureBlocker(board.tasks, SAMPLE_FEATURE_ID)?.id ?? null} onAskDelete={() => setConfirming(true)} onKeep={() => setConfirming(false)} onDelete={noop} onSave={noop} />
        : <>
          <span className="taskModalSpacer" aria-hidden="true" />
          <button type="button" className="commandQuietAction" onClick={noop}>Cancel</button>
          <button type="button" className="commandPrimaryAction" disabled={!valid} onClick={noop}>Create feature</button>
        </>}>
      <FeatureFormFields draft={draft} onChange={setDraft} failure={failure} detailsDisabled={unread} readFailed={unread} />
      {edit && <FeatureSiblings board={board} featureId={SAMPLE_FEATURE_ID} label="Tasks" steps onOpenTask={noop} />}
    </TaskModalChrome>
  </div>;
}

/** The Feature modal in its two modes, with its failure lines and its delete footer. */
export function FeatureModalSamples() {
  return <>
    <Sample label="Feature modal, new feature" note="The task modal's frame with a form of three fields: Title (required, 80 characters), Description (2,000) and App version (40, in the data font, optional). Title and Description each end with a helper and a live counter; past its bound the Description counter takes the error colour and the primary is disabled. Create feature stays disabled until the title holds text; type to see the counters and the primary change.">
      <FeatureModalChrome mode="new" initial={EMPTY_FEATURE_DRAFT} />
    </Sample>
    <Sample label="Feature modal, feature, saved" note="Mode Feature holds the stored values as a local draft. The header carries the feature's progress chip. Save is the one primary and stays disabled until the draft differs. The folded Tasks list is the task modal's In this feature list, and a row opens that task. A Quiet Delete feature stands at the left of the footer.">
      <FeatureModalChrome mode="edit" initial={STORED} />
    </Sample>
    <Sample label="Feature modal, feature, changed" note="A draft that differs from the stored feature enables Save, which sends only what changed.">
      <FeatureModalChrome mode="edit" initial={{ ...STORED, name: `${STORED_NAME} and retries`, appVersion: "1.5.0" }} />
    </Sample>
    <Sample label="Feature modal, delete confirmation" note="Delete feature swaps the footer for the task modal's inline confirmation, with no native dialog: the line says what happens to the tasks, then a Secondary Delete feature and a Quiet Keep feature. Keep feature takes focus when the confirmation opens. With no task the line is shorter. No Save shows while it asks.">
      <FeatureModalChrome mode="edit" initial={STORED} confirm />
    </Sample>
    <Sample label="Feature modal, delete blocked" note="A task of the feature has started and is not done: the footer names the first one, Delete feature is disabled and opens no confirmation, and Save stays as it was.">
      <FeatureModalChrome mode="edit" initial={STORED} board={BOARD_BLOCKED} />
    </Sample>
    <Sample label="Feature modal, could not delete" note="Any failed delete, a task that started in the meantime included, keeps the modal open, returns to the idle footer, and shows one fixed line under the fields.">
      <FeatureModalChrome mode="edit" initial={STORED} failure="delete" />
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
