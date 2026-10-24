"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import type { Task } from "../../../shared/task-contract";
import { CommandPageHeader } from "../command-center/CommandPage";
import { setPaletteScope } from "../command-center/palette-scope";
import { NewFeatureAction, type FeatureEntry } from "./FeatureActions";
import { FeatureModal } from "./FeatureModal";
import { QueueControl } from "./QueueControl";
import { TaskBoardView, type FeatureSelection, type TaskReveal } from "./TaskBoardView";
import { TaskModal } from "./TaskModal";
import { PromoteIssuesAction } from "./promote-issues-action";
import { readDesktopScorecard, useScorecardAvailability, useTaskEditAvailability } from "./task-desktop";
import { queueStatusLine } from "./task-queue-banner";
import { taskSearchItems } from "./task-search";
import { useTaskBoardEdits } from "./use-task-board-edits";
import { useTaskIssuesAvailability } from "./use-promote-issues";

type OpenModal = { kind: "new" } | { kind: "task"; id: string; focus?: "after" } | { kind: "newFeature" } | { kind: "feature"; id: string } | null;

export function TaskBoardPane({ repositoryId, featureId = null, switcher, breadcrumb }: { repositoryId: string; featureId?: string | null; switcher?: ReactNode; breadcrumb?: ReactNode }) {
  const headingId = useId();
  const { board: committed, refresh } = useTasks(repositoryId);
  const edits = useTaskBoardEdits(repositoryId, committed, refresh);
  const board = edits.board;
  const { snapshot } = useRepositoryInventory();
  const access = useTaskEditAvailability();
  const editable = access === "desktop" || access === "paired";
  // Only the desktop app makes and edits a feature from the Board; a paired device still names one in the task modal.
  const desktop = access === "desktop";
  const issuesBridge = useTaskIssuesAvailability();
  const scorecardBridge = useScorecardAvailability();
  const readScorecard = useCallback(() => readDesktopScorecard(repositoryId), [repositoryId]);
  const [modal, setModal] = useState<OpenModal>(null);
  const [reveal, setReveal] = useState<TaskReveal | null>(null);
  const [featureSelection, setFeatureSelection] = useState<FeatureSelection | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const repositoryName = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  const openTask = modal?.kind === "task" ? board.tasks.find((task) => task.id === modal.id) : undefined;
  const openFeature = modal?.kind === "feature" ? board.features.find((feature) => feature.id === modal.id) : undefined;
  const open = modal?.kind === "new" || modal?.kind === "newFeature" || openTask !== undefined || openFeature !== undefined;
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
  // The feature and the Edit feature button that opened its modal are gone once the board is read again, so focus returns to the filter.
  const featureDeleted = useCallback(async () => {
    opener.current = section.current?.querySelector<HTMLElement>(".taskFeatureFilter [role='combobox']") ?? trigger.current;
    await refresh();
  }, [refresh]);
  const openCreated = useCallback((id: string) => { opener.current = trigger.current; setModal({ kind: "task", id }); }, []);
  const ready = board.readiness === "ready";
  const queueLine = queueStatusLine(board.queue.status);
  const openNew = useCallback(() => { opener.current = trigger.current; setModal({ kind: "new" }); }, []);
  const featureEntry = useMemo<FeatureEntry>(() => ({
    onNew: (element) => { opener.current = element; setModal({ kind: "newFeature" }); },
    onEdit: (id, element) => { opener.current = element; setModal({ kind: "feature", id }); },
  }), []);
  // The feature's opener stays the opener, so closing the task returns to where the owner started.
  const openFromFeature = useCallback((task: Task) => setModal({ kind: "task", id: task.id }), []);
  const openCard = useCallback((task: Task, element: HTMLElement, focus?: "after") => { opener.current = element; setModal({ kind: "task", id: task.id, ...(focus ? { focus } : {}) }); }, []);
  // A feature named by the address, such as by a session's feature link, is answered once, when the board and the client are known.
  // The filter chooses it in any client, and the desktop app also opens its modal. A feature the board does not hold opens nothing.
  if (featureId !== null && answered !== featureId && ready && access !== "pending") {
    setAnswered(featureId);
    if (board.features.some((feature) => feature.id === featureId)) {
      setFeatureSelection({ id: featureId });
      if (desktop) setModal({ kind: "feature", id: featureId });
    }
  }
  // No control opened that modal, so closing it returns focus to the filter that shows the feature.
  useEffect(() => {
    if (answered !== null) opener.current = section.current?.querySelector<HTMLElement>(".taskFeatureFilter [role='combobox']") ?? null;
  }, [answered]);
  const openFound = useCallback((id: string) => {
    if (!editable) { setReveal((last) => ({ id, turn: (last?.turn ?? 0) + 1 })); return; }
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
    <CommandPageHeader className="tasksPageHeader" headingId={headingId} breadcrumb={breadcrumb} title="Tasks"
      meta={<div className="tasksPageMeta">
        <p>Work for this repository. Ready is the queue: cards start from the top.</p>
        {access === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app or on a paired device.</p>}
        {access === "paired" && <p className="taskBoardNote">Sessions start on the computer running Pomegr.</p>}
        {/* A blocked or paused queue is worded by its banner instead. */}
        {ready && queueLine && <p className="taskBoardNote">{queueLine}</p>}
      </div>}
      actions={(switcher || ready || issuesBridge === "available") && <div className="taskHeadActions">
        {switcher}
        {editable && ready && <QueueControl status={board.queue.status} busy={edits.busy} onSet={(on) => { void edits.setQueue(on); }} />}
        {/* The filter row carries this action once a feature exists. */}
        {desktop && ready && board.features.length === 0 && <NewFeatureAction board={board} entry={featureEntry} />}
        {/* Opens the Promote issues page. */}
        {issuesBridge === "available" && <PromoteIssuesAction repositoryId={repositoryId} />}
      </div>} />
    <div className="tasksPageBody">
      <TaskBoardView board={board} readScorecard={scorecardBridge === "available" ? readScorecard : undefined} reveal={reveal} featureSelection={featureSelection} onOpenTask={editable ? openCard : undefined} edits={editable ? edits : undefined}
        newTask={editable ? { triggerRef: trigger, onOpen: openNew } : undefined} features={desktop ? featureEntry : undefined} />
      {editable && modal?.kind === "new" && <TaskModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={changed} onFollowUpFailed={openCreated} onClose={close} />}
      {editable && openTask && <TaskModal key={openTask.id} mode="edit" repositoryId={repositoryId} repositoryName={repositoryName} task={openTask} board={board} refresh={refresh} onOpenTask={openCard} onChanged={changed} onDeleted={deleted} onClose={close} focus={modal?.kind === "task" ? modal.focus : undefined} />}
      {desktop && modal?.kind === "newFeature" && <FeatureModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} onCreated={changed} onClose={close} />}
      {desktop && openFeature && <FeatureModal key={openFeature.id} mode="edit" repositoryId={repositoryId} repositoryName={repositoryName} board={board} feature={openFeature}
        onOpenTask={openFromFeature} onChanged={changed} onDeleted={featureDeleted} onClose={close} />}
    </div>
  </section>;
}
