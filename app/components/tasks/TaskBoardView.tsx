import { useId } from "react";
import type { CSSProperties } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { TaskCard } from "./TaskCard";
import { taskColumns, type TaskColumnView } from "./task-presentation";

type OpenTask = (task: Task, opener: HTMLElement) => void;

function TaskColumn({ column, onOpen }: { column: TaskColumnView; onOpen?: OpenTask }) {
  const headingId = useId();
  const total = column.tasks.length;
  return <section className="taskColumn" aria-labelledby={headingId}>
    <header className="taskColumnHeader">
      <h3 id={headingId}>{column.name}</h3>
      <span className="taskColumnCount">{total}<span className="visuallyHidden"> {total === 1 ? "task" : "tasks"}</span></span>
    </header>
    {total > 0 && <ul className="taskColumnList">{column.tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={onOpen} />)}</ul>}
  </section>;
}

// Five default columns, so the placeholder holds the layout the first answer will fill.
function TaskBoardSkeleton() {
  return <div className="taskBoardSkeleton" aria-label="Loading tasks">
    {Array.from({ length: 5 }, (_, index) => <div className="taskBoardSkeletonColumn" key={index}><span /><span /></div>)}
  </div>;
}

/** Columns with a name and a count, each holding its task cards. Cards open the Task panel only when `onOpenTask` is given. */
export function TaskBoardView({ board, onOpenTask }: { board: TaskBoard; onOpenTask?: OpenTask }) {
  if (board.readiness === "loading") return <TaskBoardSkeleton />;
  if (board.readiness === "unavailable") return <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>;
  if (board.readiness === "desktop_only") return <section className="panel taskBoardNotice" aria-label="Tasks">
    <span className="commandChip">Desktop only</span>
    <p>The task board is available in the Pomegr desktop app on this computer.</p>
  </section>;
  const columns = taskColumns(board);
  return <>
    {board.tasks.length === 0 && <p className="taskBoardEmpty">No tasks on this board yet.</p>}
    {columns.length > 0 && <div className="taskBoardScroller" role="region" aria-label="Task board" tabIndex={0}>
      <div className="taskBoardGrid" style={{ "--task-columns": columns.length } as CSSProperties}>
        {columns.map((column) => <TaskColumn key={column.id} column={column} onOpen={onOpenTask} />)}
      </div>
    </div>}
  </>;
}
