"use client";

import { TASK_BOUNDS, type TaskBoard } from "../../../shared/task-contract";

/** What the desktop app opens from the Board: the Feature modal in its two modes. A paired device has neither. */
export type FeatureEntry = {
  onNew(opener: HTMLElement): void;
  onEdit(featureId: string, opener: HTMLElement): void;
};

/** The Quiet **+ New feature**, in the filter row once a feature exists and in the page header before. Disabled at the board's feature limit. */
export function NewFeatureAction({ board, entry }: { board: Pick<TaskBoard, "features">; entry: FeatureEntry }) {
  return <button type="button" className="commandQuietAction" aria-haspopup="dialog" disabled={board.features.length >= TASK_BOUNDS.featuresPerRepository}
    onClick={(event) => entry.onNew(event.currentTarget)}>+ New feature</button>;
}
