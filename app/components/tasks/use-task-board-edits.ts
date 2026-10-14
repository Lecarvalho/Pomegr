"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskBoard, TaskGateThreshold, TaskQueueSchedule } from "../../../shared/task-contract";
import { applyMove, placementOf, samePlacement } from "./task-board-model";
import {
  GATE_THRESHOLD_FAILURE_MESSAGE, MOVE_FAILURE_MESSAGE, QUEUE_GROUP_ADD_FAILURE_MESSAGE, QUEUE_GROUP_FAILURE_MESSAGE, QUEUE_GROUP_LIMIT_MESSAGE, QUEUE_SCHEDULE_FAILURE_MESSAGE, QUEUE_UNGROUP_FAILURE_MESSAGE, QUEUE_SETTINGS_FAILURE_MESSAGE, REQUEUE_FAILURE_MESSAGE, RESOLVE_DONE_FAILURE_MESSAGE,
  groupDesktopTasks, moveDesktopTask, queueDesktopGroup,
  requeueDesktopTask, resolveDesktopTaskDone, setDesktopGateThreshold, setDesktopQueue, setDesktopQueueSchedule, ungroupDesktopTasks, type TaskActionResult, type TaskMove,
} from "./task-desktop";

const CONFIRM_FALLBACK_MS = 10_000;

type PendingMove = { key: number; epoch: number; move: TaskMove; acknowledged: boolean };

export type TaskBoardEdits = {
  board: TaskBoard;
  failure: string | null;
  busy: boolean;
  settled: number;
  moveTask(move: TaskMove): Promise<boolean>;
  /** Puts the waiting cards in one parallel group: the group of the first one, or a new group. */
  groupTasks(ids: readonly string[]): Promise<boolean>;
  /** Takes each waiting card out of its parallel group. */
  ungroupTasks(ids: readonly string[]): Promise<boolean>;
  /** Queues every card of the task's parallel group that is not queued yet, in the order of the plan. */
  queueGroup(id: string): Promise<boolean>;
  setQueue(on: boolean): Promise<boolean>;
  setGateThreshold(threshold: TaskGateThreshold): Promise<boolean>;
  setQueueSchedule(schedule: TaskQueueSchedule): Promise<boolean>;
  resolveTask(id: string, done: boolean): Promise<boolean>;
};

function withMoves(board: TaskBoard, pending: PendingMove[]) {
  return pending.reduce((current, entry) => applyMove(current, entry.move), board);
}

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

  if (repository !== repositoryId) {
    setRepository(repositoryId);
    setPending([]);
    setFailure(null);
  }
  const confirmed = isConfirmed(board, pending);
  if (confirmed) setPending([]);

  const display = useMemo(() => confirmed ? board : withMoves(board, pending), [board, pending, confirmed]);

  // Otherwise the committed board reads differently for another reason.
  useEffect(() => {
    if (pending.length === 0 || pending.some((entry) => !entry.acknowledged)) return undefined;
    const timer = window.setTimeout(() => setPending((list) => list.filter((entry) => !entry.acknowledged)), CONFIRM_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

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
      if (entry.epoch !== epoch.current) return false;
      const result = await moveDesktopTask(repositoryId, move);
      if (result.ok) {
        setPending((list) => list.map((candidate) => candidate.key === entry.key ? { ...candidate, acknowledged: true } : candidate));
        void refresh();
      } else {
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

  return {
    board: display,
    failure,
    busy: running > 0,
    settled,
    moveTask,
    groupTasks: useCallback((ids: readonly string[]) => waitedAction(() => groupDesktopTasks(repositoryId, ids), (error) => error === "limit" ? QUEUE_GROUP_LIMIT_MESSAGE : QUEUE_GROUP_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    queueGroup: useCallback((id: string) => waitedAction(() => queueDesktopGroup(repositoryId, id), () => QUEUE_GROUP_ADD_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    ungroupTasks: useCallback((ids: readonly string[]) => waitedAction(() => ungroupDesktopTasks(repositoryId, ids), () => QUEUE_UNGROUP_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    setQueue: useCallback((on: boolean) => waitedAction(() => setDesktopQueue(repositoryId, on), () => QUEUE_SETTINGS_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    setGateThreshold: useCallback((threshold: TaskGateThreshold) => waitedAction(() => setDesktopGateThreshold(repositoryId, threshold), () => GATE_THRESHOLD_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    setQueueSchedule: useCallback((schedule: TaskQueueSchedule) => waitedAction(() => setDesktopQueueSchedule(repositoryId, schedule), () => QUEUE_SCHEDULE_FAILURE_MESSAGE), [waitedAction, repositoryId]),
    resolveTask: useCallback((id: string, done: boolean) => waitedAction(() => done ? resolveDesktopTaskDone(repositoryId, id) : requeueDesktopTask(repositoryId, id),
      () => done ? RESOLVE_DONE_FAILURE_MESSAGE : REQUEUE_FAILURE_MESSAGE), [waitedAction, repositoryId]),
  };
}
