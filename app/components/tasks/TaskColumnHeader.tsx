type Column = { id: string; name: string };

export function TaskColumnHeader({ column, headingId, taskCount }: { column: Column; headingId: string; taskCount: number }) {
  return <header className="taskColumnHeader">
    <h3 id={headingId}>{column.name}</h3>
    <span className="taskColumnCount">{taskCount}<span className="visuallyHidden"> {taskCount === 1 ? "task" : "tasks"}</span></span>
  </header>;
}
