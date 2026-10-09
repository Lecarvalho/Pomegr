type Column = { id: string; name: string };

// Column header (design contract D50-D52): the name and the count. The board has five fixed columns, so the header
// carries no control, in the desktop app and in a browser alike.
export function TaskColumnHeader({ column, headingId, taskCount }: { column: Column; headingId: string; taskCount: number }) {
  return <header className="taskColumnHeader">
    <h3 id={headingId}>{column.name}</h3>
    <span className="taskColumnCount">{taskCount}<span className="visuallyHidden"> {taskCount === 1 ? "task" : "tasks"}</span></span>
  </header>;
}
