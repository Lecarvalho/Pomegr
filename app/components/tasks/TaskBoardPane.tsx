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
import { useTaskEditAvailability } from "./task-desktop";
import { queueStatusLine } from "./task-queue-banner";
import { taskSearchItems } from "./task-search";
import { useTaskBoardEdits } from "./use-task-board-edits";
import { useTaskIssuesAvailability } from "./use-promote-issues";

type OpenModal = { kind: "new" } | { kind: "task"; id: string } | null;

export function TaskBoardPane({ repositoryId, switcher }: { repositoryId: string; switcher?: ReactNode }) {
  const headingId = useId();
  const { board: committed, refresh } = useTasks(repositoryId);
  const edits = useTaskBoardEdits(repositoryId, committed, refresh);
  const board = edits.board;
  const { snapshot } = useRepositoryInventory();
  const access = useTaskEditAvailability();
  const editable = access === "desktop" || access === "paired";
  const issuesBridge = useTaskIssuesAvailability();
  const [modal, setModal] = useState<OpenModal>(null);
  const [view, setView] = useState<TaskView>("board");
  const [reveal, setReveal] = useState<TaskReveal | null>(null);
  const section = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const repositoryName = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  const openTask = modal?.kind === "task" ? board.tasks.find((task) => task.id === modal.id) : undefined;
  const open = modal?.kind === "new" || openTask !== undefined;
  useEffect(() => {
    if (wasOpen.current && !open) {
      const target = opener.current?.isConnected ? opener.current : trigger.current;
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => setModal(null), []);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  const deleted = useCallback(() => { opener.current = trigger.current; setModal(null); }, []);
  const openCreated = useCallback((id: string) => { opener.current = trigger.current; setModal({ kind: "task", id }); }, []);
  const ready = board.readiness === "ready";
  const queueLine = queueStatusLine(board.queue.status);
  const openNew = useCallback(() => { opener.current = trigger.current; setModal({ kind: "new" }); }, []);
  const openCard = useCallback((task: Task, element: HTMLElement) => { opener.current = element; setModal({ kind: "task", id: task.id }); }, []);
  const chooseView = useCallback((next: TaskView) => { setReveal(null); setView(next); }, []);
  const openFound = useCallback((id: string) => {
    if (!editable) { setView("board"); setReveal((last) => ({ id, turn: (last?.turn ?? 0) + 1 })); return; }
    const card = [...(section.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find((element) => element.getAttribute("data-task-id") === id);
    opener.current = card?.querySelector<HTMLElement>(".taskCardOpen") ?? trigger.current;
    setModal({ kind: "task", id });
  }, [editable]);
  const searchItems = useMemo(() => (ready ? taskSearchItems(board) : null), [board, ready]);
  useEffect(() => {
    if (!searchItems) return;
    return setPaletteScope({ label: "Search tasks", placeholder: "Search tasks and destinations", emptyLine: "No tasks or destinations match that search.", items: searchItems, onSelect: openFound });
  }, [openFound, searchItems]);
  return <section ref={section} className="commandView tasksPage" aria-labelledby={headingId} aria-busy={board.readiness === "loading"}>
    <CommandPageHeader className="tasksPageHeader" headingId={headingId} title="Tasks"
      meta={<div className="tasksPageMeta">
        <p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p>
        {access === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app or on a paired device.</p>}
        {access === "paired" && <p className="taskBoardNote">Sessions are started and the queue is turned on in the Pomegr desktop app.</p>}
        {/* A blocked or paused queue is worded by its banner instead. */}
        {ready && queueLine && <p className="taskBoardNote">{queueLine}</p>}
      </div>}
      actions={(switcher || ready || issuesBridge === "available") && <div className="taskHeadActions">
        {switcher}
        {ready && <div className="commandSegmented" role="group" aria-label="Tasks view">
          <button type="button" aria-pressed={view === "board"} onClick={() => chooseView("board")}>Board</button>
          <button type="button" aria-pressed={view === "queue"} onClick={() => chooseView("queue")}>Queue</button>
        </div>}
        {editable && ready && <QueueControl status={board.queue.status} busy={edits.busy} offOnly={access === "paired"} onSet={(on) => { void edits.setQueue(on); }} />}
        {/* The Board filter row carries this action once a feature exists. */}
        {editable && ready && (view === "queue" || board.features.length === 0) && <AddFeatureAction edits={edits} full={board.features.length >= TASK_BOUNDS.featuresPerRepository} />}
        {/* Opens the Promote issues page. */}
        {issuesBridge === "available" && <PromoteIssuesAction repositoryId={repositoryId} />}
      </div>} />
    <div className="tasksPageBody">
      <TaskBoardView board={board} view={view} reveal={reveal} onOpenTask={editable ? openCard : undefined} edits={editable ? edits : undefined}
        newTask={editable ? { triggerRef: trigger, onOpen: openNew } : undefined} />
      {editable && modal?.kind === "new" && <TaskModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={changed} onIssueFailed={openCreated} onClose={close} />}
      {editable && openTask && <TaskModal key={openTask.id} mode="edit" repositoryId={repositoryId} repositoryName={repositoryName} task={openTask} board={board} refresh={refresh} onOpenTask={openCard} onChanged={changed} onDeleted={deleted} onClose={close} />}
    </div>
  </section>;
}
