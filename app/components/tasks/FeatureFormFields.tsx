"use client";

import { useId, type Ref } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import {
  FEATURE_DUPLICATE_MESSAGE, FEATURE_LIMIT_MESSAGE, FEATURE_READ_FAILURE_MESSAGE, FEATURE_SAVE_FAILURE_MESSAGE, featureCount, featureDescriptionOver,
  type FeatureFailure, type FeatureFormDraft,
} from "./feature-form";

/** The three fields of the Feature modal in both modes, and the fixed lines a failure or a failed read adds under them. */
export function FeatureFormFields({ draft, onChange, failure, detailsDisabled, readFailed, readOnly, ref }: {
  draft: FeatureFormDraft;
  onChange(next: FeatureFormDraft): void;
  failure?: FeatureFailure | null;
  /** Edit mode before the read answers, or after it failed: Description and App version cannot be edited. */
  detailsDisabled?: boolean;
  readFailed?: boolean;
  readOnly?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  const ids = { title: useId(), titleHelper: useId(), titleError: useId(), description: useId(), descriptionHelper: useId(), version: useId(), versionHelper: useId() };
  const over = featureDescriptionOver(draft);
  return <>
    <div className="newTaskField featureField">
      <label htmlFor={ids.title}>Title</label>
      <input ref={ref} id={ids.title} className="taskOwnInput" type="text" maxLength={TASK_BOUNDS.featureNameLength} placeholder="What is this feature?"
        value={draft.name} readOnly={readOnly} aria-describedby={failure === "duplicate" ? `${ids.titleHelper} ${ids.titleError}` : ids.titleHelper}
        onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })} />
      <div className="featureFieldFoot">
        <span id={ids.titleHelper} className="newTaskHelper">One line. It names the feature on the board and in the session&apos;s prompt.</span>
        <span className="featureCounter">{featureCount(draft.name.length, TASK_BOUNDS.featureNameLength)}</span>
      </div>
      {failure === "duplicate" && <p id={ids.titleError} className="newTaskError" role="alert">{FEATURE_DUPLICATE_MESSAGE}</p>}
    </div>
    <div className="newTaskField featureField">
      <label htmlFor={ids.description}>Description</label>
      <textarea id={ids.description} rows={6} placeholder="What should every task of this feature know?" value={draft.description}
        disabled={detailsDisabled} readOnly={readOnly} aria-describedby={ids.descriptionHelper} aria-invalid={over || undefined}
        onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })} />
      <div className="featureFieldFoot">
        <span id={ids.descriptionHelper} className="newTaskHelper">The context its tasks share, so each task&apos;s own text stays short. An agent reads it when its task needs it.</span>
        <span className={`featureCounter${over ? " isOver" : ""}`}>{featureCount(draft.description.length, TASK_BOUNDS.featureDescriptionLength)}</span>
      </div>
    </div>
    <div className="newTaskField featureField">
      <label htmlFor={ids.version}>App version</label>
      <input id={ids.version} className="taskOwnInput featureVersion" type="text" maxLength={TASK_BOUNDS.featureAppVersionLength} placeholder="1.4.0"
        value={draft.appVersion} disabled={detailsDisabled} readOnly={readOnly} aria-describedby={ids.versionHelper}
        onChange={(event) => onChange({ ...draft, appVersion: event.currentTarget.value })} />
      <span id={ids.versionHelper} className="newTaskHelper">The version the feature is planned for. Optional, and it gates nothing.</span>
    </div>
    {readFailed && <p className="newTaskError" role="alert">{FEATURE_READ_FAILURE_MESSAGE}</p>}
    {failure === "limit" && <p className="newTaskError" role="alert">{FEATURE_LIMIT_MESSAGE}</p>}
    {failure === "failed" && <p className="newTaskError" role="alert">{FEATURE_SAVE_FAILURE_MESSAGE}</p>}
  </>;
}
