"use client";

import type { Ref } from "react";
import { featureDeleteLine, featureRunningLine } from "./feature-form";

/** The footer of the Feature modal in mode Feature: Delete feature, Mark done or Reopen, and Save, or the inline delete confirmation that replaces them. */
export function FeatureEditFooter({ confirming, deleting, busy, canSave, taskCount, blockerId, done, keepRef, onAskDelete, onKeep, onDelete, onToggleDone, onSave }: {
  confirming: boolean;
  deleting: boolean;
  /** A save is in flight. */
  busy: boolean;
  canSave: boolean;
  /** Every task of the feature, done ones included. */
  taskCount: number;
  /** The first task of the feature that has started and is not done; Delete feature is disabled while there is one. */
  blockerId: string | null;
  /** Whether the owner marked the feature done; it then takes no new task. */
  done: boolean;
  keepRef?: Ref<HTMLButtonElement>;
  onAskDelete(): void;
  onKeep(): void;
  onDelete(): void;
  onToggleDone(): void;
  onSave(): void;
}) {
  if (confirming) {
    return <div className="taskModalConfirm" role="group" aria-label="Confirm delete">
      <span className="taskModalNote">{featureDeleteLine(taskCount)}</span>
      <span className="taskModalSpacer" aria-hidden="true" />
      <button type="button" className="commandSecondaryAction" disabled={deleting} onClick={onDelete}>Delete feature</button>
      <button ref={keepRef} type="button" className="commandQuietAction" disabled={deleting} onClick={onKeep}>Keep feature</button>
    </div>;
  }
  return <>
    {blockerId !== null && <div className="taskModalResolve"><span className="taskModalNote">{featureRunningLine(blockerId)}</span></div>}
    <button type="button" className="commandQuietAction" disabled={blockerId !== null || busy} onClick={onAskDelete}>Delete feature</button>
    <span className="taskModalSpacer" aria-hidden="true" />
    <button type="button" className="commandSecondaryAction" disabled={busy || deleting} onClick={onToggleDone}>{done ? "Reopen" : "Mark done"}</button>
    <button type="button" className="commandPrimaryAction" disabled={!canSave} onClick={onSave}>Save</button>
  </>;
}
