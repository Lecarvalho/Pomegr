"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import { TASK_BOUNDS, type Task } from "../../../shared/task-contract";
import { CommandPageHeader } from "../command-center/CommandPage";
import { setPaletteScope } from "../command-center/palette-scope";
import { AddFeatureAction } from "./AddFeatureAction";
import { QueueControl } from "./QueueControl";
import { TaskBoardView, type TaskReveal, type TaskView } from "./TaskBoardView";
import { TaskModal } from "./TaskModal";
import { PromoteIssuesAction } from "./promote-issues-action";
import { useTaskDesktopAvailability } from "./task-desktop";
import { queueStatusLine } from "./task-queue-banner";
import { taskSearchItems } from "./task-search";
import { useTaskBoardEdits } from "./use-task-board-edits";
import { useTaskIssuesAvailability } from "./use-promote-issues";

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
  // Same rule for the GitHub issues bridge: a desktop build from before it draws no Promote issues action.
  const issuesBridge = useTaskIssuesAvailability();
  const [modal, setModal] = useState<OpenModal>(null);
  const [view, setView] = useState<TaskView>("board");
  const [reveal, setReveal] = useState<TaskReveal | null>(null);
  const section = useRef<HTMLElement>(null);
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
  // A new task whose ticked GitHub issue failed: its own modal takes the place of New task so the reason is read. The
  // board is already being read again; the modal draws once it holds the task, and closing still returns focus to the New task action.
  const openCreated = useCallback((id: string) => { opener.current = trigger.current; setModal({ kind: "task", id }); }, []);
  const ready = board.readiness === "ready";
  const queueLine = queueStatusLine(board.queue.status);
  const openNew = useCallback(() => { opener.current = trigger.current; setModal({ kind: "new" }); }, []);
  const openCard = useCallback((task: Task, element: HTMLElement) => { opener.current = element; setModal({ kind: "task", id: task.id }); }, []);
  // Choosing a view lets go of the card the Search bar last showed, so coming back to the Board does not take focus again.
  const chooseView = useCallback((next: TaskView) => { setReveal(null); setView(next); }, []);
  // A task chosen in the Search bar: the desktop app opens its modal, any other client is shown its card on the Board.
  const openFound = useCallback((id: string) => {
    if (desktop !== "available") { setView("board"); setReveal((last) => ({ id, turn: (last?.turn ?? 0) + 1 })); return; }
    const card = [...(section.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find((element) => element.getAttribute("data-task-id") === id);
    opener.current = card?.querySelector<HTMLElement>(".taskCardOpen") ?? trigger.current;
    setModal({ kind: "task", id });
  }, [desktop]);
  // While a ready board is in view the Search bar searches its tasks, from the board already in memory.
  const searchItems = useMemo(() => (ready ? taskSearchItems(board) : null), [board, ready]);
  useEffect(() => {
    if (!searchItems) return;
    return setPaletteScope({ label: "Search tasks", placeholder: "Search tasks and destinations", emptyLine: "No tasks or destinations match that search.", items: searchItems, onSelect: openFound });
  }, [openFound, searchItems]);
  return <section ref={section} className="commandView tasksPage" aria-labelledby={headingId} aria-busy={board.readiness === "loading"}>
    <CommandPageHeader className="tasksPageHeader" headingId={headingId} title="Tasks"
      meta={<div className="tasksPageMeta">
        <p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p>
        {desktop === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app.</p>}
        {/* A blocked or paused queue is worded by its banner instead. */}
        {ready && queueLine && <p className="taskBoardNote">{queueLine}</p>}
      </div>}
      actions={(switcher || ready || issuesBridge === "available") && <div className="taskHeadActions">
        {switcher}
        {ready && <div className="commandSegmented" role="group" aria-label="Tasks view">
          <button type="button" aria-pressed={view === "board"} onClick={() => chooseView("board")}>Board</button>
          <button type="button" aria-pressed={view === "queue"} onClick={() => chooseView("queue")}>Queue</button>
        </div>}
        {desktop === "available" && ready && <QueueControl status={board.queue.status} busy={edits.busy} onSet={(on) => { void edits.setQueue(on); }} />}
        {/* The Board's filter row carries this action once a feature exists; without one the row is not drawn. */}
        {desktop === "available" && ready && (view === "queue" || board.features.length === 0) && <AddFeatureAction edits={edits} full={board.features.length >= TASK_BOUNDS.featuresPerRepository} />}
        {/* Opens the Promote issues page. The header has no primary action: a new task is made in the first lane. */}
        {issuesBridge === "available" && <PromoteIssuesAction repositoryId={repositoryId} />}
      </div>} />
    <div className="tasksPageBody">
      <TaskBoardView board={board} view={view} reveal={reveal} onOpenTask={desktop === "available" ? openCard : undefined} edits={desktop === "available" ? edits : undefined}
        newTask={desktop === "available" ? { triggerRef: trigger, onOpen: openNew } : undefined} />
      {desktop === "available" && modal?.kind === "new" && <TaskModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={changed} onIssueFailed={openCreated} onClose={close} />}
      {desktop === "available" && openTask && <TaskModal key={openTask.id} mode="edit" repositoryId={repositoryId} repositoryName={repositoryName} task={openTask} board={board} refresh={refresh} onOpenTask={openCard} onChanged={changed} onDeleted={deleted} onClose={close} />}
    </div>
  </section>;
}
