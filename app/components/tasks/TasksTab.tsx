"use client";

import { useTasks } from "../../tasks-store";
import { TaskBoardView } from "./TaskBoardView";

/** Repository page Tasks tab: the stored board for this repository, read-only. */
export function TasksTab({ repositoryId }: { repositoryId: string }) {
  const { board } = useTasks(repositoryId);
  return <div className="repositoryTasksTab" aria-busy={board.readiness === "loading"}>
    <header className="repositoryPaneHead"><div><h2>Tasks</h2><p>Stored tasks for this repository, grouped by column. A card shows its task text until its session has a title.</p></div></header>
    <TaskBoardView board={board} />
  </div>;
}
