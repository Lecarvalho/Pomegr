"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import { NewTaskPanel } from "./NewTaskPanel";
import { TaskBoardView } from "./TaskBoardView";
import { useTaskDesktopAvailability } from "./task-desktop";

/** Repository page Tasks tab: the stored board for this repository. Tasks are created in the desktop app only. */
export function TasksTab({ repositoryId }: { repositoryId: string }) {
  const { board, refresh } = useTasks(repositoryId);
  const { snapshot } = useRepositoryInventory();
  // Decided on the first client render: `pending` is only the server pass, and draws neither the action nor the note.
  const desktop = useTaskDesktopAvailability();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const repositoryName = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  useEffect(() => {
    // Closing by any route (Escape, Close, a created task) returns focus to the action that opened the panel.
    if (wasOpen.current && !open) trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  const created = useCallback(() => { void refresh(); }, [refresh]);
  return <div className="repositoryTasksTab" aria-busy={board.readiness === "loading"}>
    <header className="repositoryPaneHead">
      <div>
        <h2>Tasks</h2>
        <p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p>
        {desktop === "absent" && <p className="taskBoardNote">Tasks are created and edited in the Pomegr desktop app.</p>}
      </div>
      {desktop === "available" && <button ref={trigger} type="button" className="commandPrimaryAction taskNewAction" aria-haspopup="dialog" onClick={() => setOpen(true)}>New task</button>}
    </header>
    <TaskBoardView board={board} />
    {desktop === "available" && open && <NewTaskPanel repositoryId={repositoryId} repositoryName={repositoryName} onCreated={created} onClose={close} />}
  </div>;
}
