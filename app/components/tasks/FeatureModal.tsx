"use client";

import { useEffect, useRef, useState } from "react";
import type { Task, TaskFeature } from "../../../shared/task-contract";
import { FeatureFormFields } from "./FeatureFormFields";
import { FeatureSiblings } from "./FeatureFields";
import { TaskModalFrame } from "./TaskModalFrame";
import {
  EMPTY_FEATURE_DRAFT, featureCreateDetails, featureDescriptionOver, featureFailure, featurePatch, type FeatureFailure, type FeatureFormDraft,
} from "./feature-form";
import { createDesktopFeature, updateDesktopFeature } from "./task-desktop";
import { featureCounts } from "./task-features";
import type { TaskModalBoard } from "./task-modal-types";
import { useFeatureDetails } from "./use-feature-details";

type Props = {
  repositoryId: string;
  repositoryName: string | null;
  board: TaskModalBoard;
  onClose(): void;
} & (
  | { mode: "new"; onCreated(): void }
  | { mode: "edit"; feature: TaskFeature; onOpenTask?: (task: Task, opener: HTMLElement) => void; onChanged(): void }
);

/** The Feature modal, in the modes New feature and Feature: a title, a description and an app version. */
export function FeatureModal(props: Props) {
  const { repositoryId, repositoryName, board, onClose } = props;
  const feature = props.mode === "edit" ? props.feature : null;
  const title = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const read = useFeatureDetails(repositoryId, feature?.id ?? null);
  const [draft, setDraft] = useState<FeatureFormDraft>(() => feature ? { ...EMPTY_FEATURE_DRAFT, name: feature.name } : EMPTY_FEATURE_DRAFT);
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FeatureFailure | null>(null);

  // The stored details fill the draft the moment the read answers, so Save never sees them as a change.
  if (read.state === "ready" && !synced) {
    setSynced(true);
    setDraft((current) => ({ ...current, description: read.description ?? "", appVersion: read.appVersion ?? "" }));
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const trimmed = draft.name.trim();
  const valid = trimmed !== "" && !featureDescriptionOver(draft);
  const patch = feature ? featurePatch({ ...EMPTY_FEATURE_DRAFT, name: feature.name }, draft, read.state === "ready" && synced ? read : null) : null;
  const dirty = patch !== null && Object.keys(patch).length > 0;
  const holdsText = patch === null ? trimmed !== "" || draft.description.trim() !== "" || draft.appVersion.trim() !== "" : dirty;
  const canSubmit = valid && !busy && (patch === null || dirty);
  const counts = feature ? featureCounts(board, feature.id) : null;

  const submit = async () => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = props.mode === "edit" && patch
      ? await updateDesktopFeature(repositoryId, props.feature.id, patch)
      : await createDesktopFeature(repositoryId, trimmed, featureCreateDetails(draft));
    inFlight.current = false;
    // The change is stored once the monitor says so, even if the modal was closed in the meantime.
    if (result.ok) { if (props.mode === "edit") props.onChanged(); else props.onCreated(); }
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) { onClose(); return; }
    const next = featureFailure(result.error);
    setFailure(next);
    if (next === "duplicate") title.current?.focus({ preventScroll: true });
  };

  return <TaskModalFrame title={feature ? "Feature" : "New feature"} subtitle={repositoryName} initialFocus={title} closeOnScrim={!holdsText && !busy} onClose={onClose}
    titleExtra={counts && counts.total > 0 ? <span className="commandChip taskCardChip neutral">{counts.done} of {counts.total} done</span> : undefined}
    footer={<>
      <span className="taskModalSpacer" aria-hidden="true" />
      {!feature && <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>}
      <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit()}>{feature ? "Save" : busy ? "Creating…" : "Create feature"}</button>
    </>}>
    <FeatureFormFields ref={title} draft={draft} failure={failure} readOnly={busy}
      detailsDisabled={feature !== null && !(read.state === "ready" && synced)} readFailed={read.state === "failed"}
      onChange={(next) => { setDraft(next); if (failure === "duplicate") setFailure(null); }} />
    {feature && counts && counts.total > 0 && <FeatureSiblings key={feature.id} board={board} featureId={feature.id} label="Tasks" steps
      onOpenTask={props.mode === "edit" ? props.onOpenTask : undefined} />}
  </TaskModalFrame>;
}
