"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskBoard } from "../../../shared/task-contract";
import { applyMove, placementOf, samePlacement } from "./task-board-model";
import {
  MOVE_FAILURE_MESSAGE, columnFailureMessage, createDesktopColumn, createDesktopFeature, deleteDesktopColumn, featureFailureMessage,
  moveDesktopTask, renameDesktopColumn, reorderDesktopColumn, type ColumnAction, type TaskActionResult, type TaskMove,
} from "./task-desktop";

// Board edits made in the desktop app. A card move is optimistic: it is drawn in its new place at once and rolled
// back, with one fixed message, only if the monitor refuses it. Column and feature actions are not optimistic; they
// wait for the committed board before the control returns. Actions run one at a time, in the order they were made.

/** An acknowledged move that the committed board has not shown yet is dropped after this long, the polling interval. */
const CONFIRM_FALLBACK_MS = 10_000;

/** `epoch` groups the moves queued since the last failure: a failure takes the whole group back with it. */
type PendingMove = { key: number; epoch: number; move: TaskMove; acknowledged: boolean };

export type TaskBoardEdits = {
  /** The committed board with every move the monitor has not yet shown applied. */
  board: TaskBoard;
  /** A fixed message for the last failed action, until the next action starts. */
  failure: string | null;
  /** A column action is waiting for the monitor. */
  busy: boolean;
  /** Counts finished actions, so a view can restore focus once an action settled or was rolled back. */
  settled: number;
  moveTask(move: TaskMove): Promise<boolean>;
  addColumn(name: string): Promise<boolean>;
  renameColumn(id: string, name: string): Promise<boolean>;
  moveColumn(id: string, position: number): Promise<boolean>;
  deleteColumn(id: string): Promise<boolean>;
  /** Creates a feature from the board's filter row; the committed board then lists it. */
  addFeature(name: string): Promise<boolean>;
  /** Shows a fixed message for an input the board refused before sending anything. */
  reject(message: string): void;
};

function withMoves(board: TaskBoard, pending: PendingMove[]) {
  return pending.reduce((current, entry) => applyMove(current, entry.move), board);
}

/**
 * Once every move is acknowledged and the committed board already shows each moved card where the optimistic board
 * draws it, the overlay is redundant: dropping it changes nothing on screen.
 */
function isConfirmed(board: TaskBoard, pending: PendingMove[]) {
  if (pending.length === 0 || pending.some((entry) => !entry.acknowledged)) return false;
  const shown = withMoves(board, pending);
  return [...new Set(pending.map((entry) => entry.move.id))].every((id) => samePlacement(placementOf(board, id), placementOf(shown, id)));
}

export function useTaskBoardEdits(repositoryId: string, board: TaskBoard, refresh: () => Promise<void>): TaskBoardEdits {
  const [pending, setPending] = useState<PendingMove[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [running, setRunning] = useState(0);
  const [settled, setSettled] = useState(0);
  const [repository, setRepository] = useState(repositoryId);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const active = useRef(0);
  const keys = useRef(0);
  const epoch = useRef(0);

  // A repository switch starts from the committed board of the new one.
  if (repository !== repositoryId) {
    setRepository(repositoryId);
    setPending([]);
    setFailure(null);
  }
  // The committed board caught up with every acknowledged move: the overlay goes without any visible change.
  const confirmed = isConfirmed(board, pending);
  if (confirmed) setPending([]);

  const display = useMemo(() => confirmed ? board : withMoves(board, pending), [board, pending, confirmed]);

  // Otherwise the committed board reads differently for another reason; trust it once it has had time to refresh.
  useEffect(() => {
    if (pending.length === 0 || pending.some((entry) => !entry.acknowledged)) return undefined;
    const timer = window.setTimeout(() => setPending((list) => list.filter((entry) => !entry.acknowledged)), CONFIRM_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // The first action in a quiet line starts at once; the rest follow in order once the one before has answered.
  const enqueue = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const next = active.current === 0 ? run() : chain.current.then(run);
    active.current += 1;
    chain.current = next.then(() => undefined, () => undefined).then(() => { active.current -= 1; });
    return next;
  }, []);

  const moveTask = useCallback((move: TaskMove) => {
    const entry: PendingMove = { key: (keys.current += 1), epoch: epoch.current, move, acknowledged: false };
    setFailure(null);
    setPending((list) => [...list, entry]);
    return enqueue(async () => {
      // An earlier move in the line failed and took this one back with it.
      if (entry.epoch !== epoch.current) return false;
      const result = await moveDesktopTask(repositoryId, move);
      if (result.ok) {
        setPending((list) => list.map((candidate) => candidate.key === entry.key ? { ...candidate, acknowledged: true } : candidate));
        void refresh();
      } else {
        // Roll back this move and every later one, which were drawn on top of it. Earlier acknowledged moves stay.
        epoch.current += 1;
        setPending((list) => list.filter((candidate) => candidate.acknowledged || candidate.epoch !== entry.epoch));
        setFailure(MOVE_FAILURE_MESSAGE);
      }
      setSettled((count) => count + 1);
      return result.ok;
    });
  }, [enqueue, refresh, repositoryId]);

  const waitedAction = useCallback((send: () => Promise<TaskActionResult>, message: (error: Extract<TaskActionResult, { ok: false }>["error"]) => string) => {
    setFailure(null);
    setRunning((count) => count + 1);
    return enqueue(async () => {
      const result = await send();
      if (result.ok) await refresh(); else setFailure(message(result.error));
      setRunning((count) => count - 1);
      setSettled((count) => count + 1);
      return result.ok;
    });
  }, [enqueue, refresh]);
  const columnAction = useCallback((action: ColumnAction, send: () => Promise<TaskActionResult>) => waitedAction(send, (error) => columnFailureMessage(action, error)), [waitedAction]);

  return {
    board: display,
    failure,
    busy: running > 0,
    settled,
    moveTask,
    addColumn: useCallback((name: string) => columnAction("create", () => createDesktopColumn(repositoryId, name)), [columnAction, repositoryId]),
    renameColumn: useCallback((id: string, name: string) => columnAction("rename", () => renameDesktopColumn(repositoryId, id, name)), [columnAction, repositoryId]),
    moveColumn: useCallback((id: string, position: number) => columnAction("reorder", () => reorderDesktopColumn(repositoryId, id, position)), [columnAction, repositoryId]),
    deleteColumn: useCallback((id: string) => columnAction("delete", () => deleteDesktopColumn(repositoryId, id)), [columnAction, repositoryId]),
    addFeature: useCallback((name: string) => waitedAction(() => createDesktopFeature(repositoryId, name), featureFailureMessage), [waitedAction, repositoryId]),
    reject: useCallback((message: string) => setFailure(message), []),
  };
}
