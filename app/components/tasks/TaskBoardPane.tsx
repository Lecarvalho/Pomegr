"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import { TASK_BOUNDS, type Task } from "../../../shared/task-contract";
import { CommandPageHeader } from "../command-center/CommandPage";
import { AddFeatureAction } from "./AddFeatureAction";
import { QueueControl } from "./QueueControl";
import { TaskBoardView, type TaskView } from "./TaskBoardView";
import { TaskModal } from "./TaskModal";
import { useTaskDesktopAvailability } from "./task-desktop";
import { queueStatusLine } from "./task-queue-banner";
import { useTaskBoardEdits } from "./use-task-board-edits";

/** One modal at a time: the New task modal, or the Task modal of one card. */
type OpenModal = { kind: "new" } | { kind: "task"; id: string } | null;

/**
 * The Tasks page for one repository: its header, the stored board and the task modal. `switcher` is the page's
 * repository switcher, drawn first among the header actions. Tasks are created, edited and moved in the desktop app
 * only; any other client reads the board.
 */
export function TaskBoardPane({ repositoryId, switcher }: { repositoryId: string; switcher?: ReactNode }) {
  const headingId = useId();
  const { board: committed, refresh } = useTasks(repositoryId);
  // The board drawn is the committed one with the moves the monitor has not shown yet applied.
  const edits = useTaskBoardEdits(repositoryId, committed, refresh);
  const board = edits.board;
  const { snapshot } = useRepositoryInventory();
  // Decided on the first client render: `pending` is only the server pass, and draws no action.
  const desktop = useTaskDesktopAvailability();
  const [modal, setModal] = useState<OpenModal>(null);
  const [view, setView] = useState<TaskView>("board");
  // The + New task action of the first lane. The Queue view has no lanes, so it is absent there.
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const repositoryName = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  const openTask = modal?.kind === "task" ? board.tasks.find((task) => task.id === modal.id) : undefined;
  const open = modal?.kind === "new" || openTask !== undefined;
  useEffect(() => {
    // Closing by any route (Escape, Close, a created or deleted task) returns focus to the control that opened the modal.
    if (wasOpen.current && !open) {
      const target = opener.current?.isConnected ? opener.current : trigger.current;
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => setModal(null), []);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  const deleted = useCallback(() => { opener.current = trigger.current; setModal(null); }, []);
  const ready = board.readiness === "ready";
  const queueLine = queueStatusLine(board.queue.status);
  const openNew = useCallback(() => { opener.current = trigger.current; setModal({ kind: "new" }); }, []);
  const openCard = useCallback((task: Task, element: HTMLElement) => { opener.current = element; setModal({ kind: "task", id: task.id }); }, []);
  return <section className="commandView tasksPage" aria-labelledby={headingId} aria-busy={board.readiness === "loading"}>
    <CommandPageHeader className="tasksPageHeader" headingId={headingId} title="Tasks"
      meta={<div className="tasksPageMeta">
        <p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p>
        {desktop === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app.</p>}
        {/* A blocked or paused queue is worded by its banner instead. */}
        {ready && queueLine && <p className="taskBoardNote">{queueLine}</p>}
      </div>}
      actions={(switcher || ready) && <div className="taskHeadActions">
        {switcher}
        {ready && <div className="commandSegmented" role="group" aria-label="Tasks view">
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button type="button" aria-pressed={view === "queue"} onClick={() => setView("queue")}>Queue</button>
        </div>}
        {desktop === "available" && ready && <QueueControl status={board.queue.status} busy={edits.busy} onSet={(on) => { void edits.setQueue(on); }} />}
        {/* The Board's filter row carries this action once a feature exists; without one the row is not drawn. */}
        {desktop === "available" && ready && (view === "queue" || board.features.length === 0) && <AddFeatureAction edits={edits} full={board.features.length >= TASK_BOUNDS.featuresPerRepository} />}
      </div>} />
    <div className="tasksPageBody">
      <TaskBoardView board={board} view={view} onOpenTask={desktop === "available" ? openCard : undefined} edits={desktop === "available" ? edits : undefined}
        newTask={desktop === "available" ? { triggerRef: trigger, onOpen: openNew } : undefined} />
      {desktop === "available" && modal?.kind === "new" && <TaskModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={changed} onClose={close} />}
      {desktop === "available" && openTask && <TaskModal key={openTask.id} mode="edit" repositoryId={repositoryId} repositoryName={repositoryName} task={openTask} board={board} refresh={refresh} onOpenTask={openCard} onChanged={changed} onDeleted={deleted} onClose={close} />}
    </div>
  </section>;
}
