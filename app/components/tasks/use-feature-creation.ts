"use client";

import { useCallback, useEffect, useRef } from "react";
import type { TaskBoard } from "../../../shared/task-contract";
import { createDesktopFeature, featureFailureMessage } from "./task-desktop";

/** How long a created feature may take to show on the committed board before the creation reads as failed. */
const BOARD_WAIT_MS = 4_000;

export type FeatureCreation = { ok: true; id: string } | { ok: false; message: string };

/**
 * Creates a feature and answers with its ID. The desktop bridge answers only ok or a fixed error, so the new
 * feature is the one on the refreshed committed board that was not there before and carries the requested name.
 */
export function useFeatureCreation(repositoryId: string, board: Pick<TaskBoard, "features">, refresh: () => Promise<void>) {
  const latest = useRef(board.features);
  const waiting = useRef(new Set<() => void>());
  useEffect(() => {
    latest.current = board.features;
    for (const wake of [...waiting.current]) wake();
  }, [board.features]);

  return useCallback(async (name: string): Promise<FeatureCreation> => {
    const known = new Set(latest.current.map((feature) => feature.id));
    const result = await createDesktopFeature(repositoryId, name);
    if (!result.ok) return { ok: false, message: featureFailureMessage(result.error) };
    const created = () => latest.current.find((feature) => !known.has(feature.id) && feature.name === name);
    await refresh();
    const deadline = Date.now() + BOARD_WAIT_MS;
    while (!created() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const wake = () => { waiting.current.delete(wake); window.clearTimeout(timer); resolve(); };
        const timer = window.setTimeout(wake, Math.max(0, deadline - Date.now()));
        waiting.current.add(wake);
      });
    }
    const feature = created();
    return feature ? { ok: true, id: feature.id } : { ok: false, message: featureFailureMessage("unavailable") };
  }, [refresh, repositoryId]);
}
