"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import { TASK_BOUNDS, type Task } from "../../../shared/task-contract";
import { AddColumnAction } from "./AddColumnAction";
import { NewTaskPanel } from "./NewTaskPanel";
import { TaskBoardView } from "./TaskBoardView";
import { TaskPanel } from "./TaskPanel";
import { useTaskDesktopAvailability } from "./task-desktop";
import { useTaskBoardEdits } from "./use-task-board-edits";

/** One drawer at a time: the New task panel, or the Task panel of one card. */
type OpenPanel = { kind: "new" } | { kind: "task"; id: string } | null;

/**
 * Repository page Tasks tab: the stored board for this repository. Tasks are created, edited and moved, and columns
 * managed, in the desktop app only; any other client reads the board.
 */
export function TasksTab({ repositoryId }: { repositoryId: string }) {
  const { board: committed, refresh } = useTasks(repositoryId);
  // The board drawn is the committed one with the moves the monitor has not shown yet applied.
  const edits = useTaskBoardEdits(repositoryId, committed, refresh);
  const board = edits.board;
  const fullNoteId = useId();
  const { snapshot } = useRepositoryInventory();
  // Decided on the first client render: `pending` is only the server pass, and draws neither the action nor the note.
  const desktop = useTaskDesktopAvailability();
  const [panel, setPanel] = useState<OpenPanel>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const repositoryName = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  const openTask = panel?.kind === "task" ? board.tasks.find((task) => task.id === panel.id) : undefined;
  const open = panel?.kind === "new" || openTask !== undefined;
  useEffect(() => {
    // Closing by any route (Escape, Close, a created or deleted task) returns focus to the control that opened the drawer.
    if (wasOpen.current && !open) {
      const target = opener.current?.isConnected ? opener.current : trigger.current;
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => setPanel(null), []);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  const deleted = useCallback(() => { opener.current = trigger.current; setPanel(null); }, []);
  const columnsFull = board.columns.length >= TASK_BOUNDS.columnsPerRepository;
  const openNew = () => { opener.current = trigger.current; setPanel({ kind: "new" }); };
  const openCard = useCallback((task: Task, element: HTMLElement) => { opener.current = element; setPanel({ kind: "task", id: task.id }); }, []);
  return <div className="repositoryTasksTab" aria-busy={board.readiness === "loading"}>
    <header className="repositoryPaneHead">
      <div>
        <h2>Tasks</h2>
        <p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p>
        {desktop === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app.</p>}
        {desktop === "available" && columnsFull && <p id={fullNoteId} className="taskBoardNote">The board holds {TASK_BOUNDS.columnsPerRepository} columns, the most it allows.</p>}
      </div>
      {desktop === "available" && <div className="taskHeadActions">
        {board.readiness === "ready" && <AddColumnAction edits={edits} full={columnsFull} describedBy={fullNoteId} />}
        <button ref={trigger} type="button" className="commandPrimaryAction taskNewAction" aria-haspopup="dialog" onClick={openNew}>New task</button>
      </div>}
    </header>
    <TaskBoardView board={board} onOpenTask={desktop === "available" ? openCard : undefined} edits={desktop === "available" ? edits : undefined} />
    {desktop === "available" && panel?.kind === "new" && <NewTaskPanel repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={changed} onClose={close} />}
    {desktop === "available" && openTask && <TaskPanel key={openTask.id} repositoryId={repositoryId} task={openTask} board={board} refresh={refresh} onOpenTask={openCard} onChanged={changed} onDeleted={deleted} onClose={close} />}
  </div>;
}
