"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { TASK_BOUNDS, type TaskColumnRole } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { CommandSelect } from "../command-center/CommandSelect";
import { COLUMN_NAME_REQUIRED_MESSAGE } from "./task-desktop";
import type { TaskBoardEdits } from "./use-task-board-edits";

// Column header (design contract D50-D52): the name and the count. In the desktop app one Icon-role action opens an
// inline editor under the header: rename, move left or right, the state change that moves cards here, delete. Delete
// is offered but unavailable while the column holds tasks and for the last column, with the reason beside it. Nothing
// here renders without `edits`.

type Column = { id: string; name: string; role?: TaskColumnRole | null };

/** When Pomegr moves a card to the column by itself. One column holds each choice but Never. */
const ROLE_LABEL = "Pomegr moves a card here";
const NO_ROLE = "none";
const ROLE_OPTIONS: { value: TaskColumnRole | typeof NO_ROLE; label: string }[] = [
  { value: NO_ROLE, label: "Never" },
  { value: "in_progress", label: "When its session starts" },
  { value: "review", label: "When it needs review" },
  { value: "done", label: "When it is done" },
];

export function TaskColumnHeader({ column, headingId, index, columnCount, taskCount, hiddenCount = 0, edits, onMove, onDeleted }: {
  column: Column;
  headingId: string;
  index: number;
  columnCount: number;
  taskCount: number;
  /** Cards a feature filter hides: they still keep the column from being deleted. */
  hiddenCount?: number;
  edits?: TaskBoardEdits;
  onMove(side: "left" | "right"): void;
  onDeleted(): void;
}) {
  const editorId = useId();
  const noteId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [seen, setSeen] = useState(column.name);
  // The name last sent, so Enter and the blur that follows it send one rename even before the board shows it.
  const [sent, setSent] = useState(column.name);
  const holdsTasks = taskCount + hiddenCount > 0;
  const onlyColumn = columnCount <= 1;
  const role = column.role ?? NO_ROLE;
  const reason = holdsTasks ? "A column must be empty to be deleted." : onlyColumn ? "A board keeps at least one column." : null;

  // The name changed in the committed board: the field follows it.
  if (seen !== column.name) { setSeen(column.name); setDraft(column.name); setSent(column.name); }
  useEffect(() => {
    if (!open) return;
    cancelled.current = false;
    field.current?.focus({ preventScroll: true });
  }, [open]);

  const commitName = async () => {
    // Leaving with Escape discards the draft, even if the browser reports the input losing focus as it unmounts.
    if (!edits || cancelled.current) return;
    const name = draft.trim();
    if (!name) { setDraft(column.name); edits.reject(COLUMN_NAME_REQUIRED_MESSAGE); return; }
    setDraft(name);
    if (name === sent) return;
    setSent(name);
    if (!(await edits.renameColumn(column.id, name))) { setSent(column.name); setDraft(column.name); }
  };
  const nameKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void commitName(); return; }
    if (event.key !== "Escape") return;
    // Escape leaves the editor and keeps the board's own Escape handling (closing a panel) out of it.
    event.preventDefault();
    cancelled.current = true;
    setDraft(column.name);
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  };
  const remove = async () => {
    if (await edits?.deleteColumn(column.id)) onDeleted();
  };

  return <>
    <header className="taskColumnHeader">
      <h3 id={headingId}>{column.name}</h3>
      <span className="taskColumnCount">{taskCount}<span className="visuallyHidden"> {taskCount === 1 ? "task" : "tasks"}</span></span>
      {edits && <button ref={toggle} type="button" className="commandIconAction taskColumnEdit" data-column-edit="" aria-label={`Edit column ${column.name}`} aria-expanded={open} aria-controls={editorId} onClick={() => setOpen((value) => !value)}>
        <CommandIcon name="more" />
      </button>}
    </header>
    {edits && open && <div id={editorId} className="taskColumnEditor" role="group" aria-label={`Edit column ${column.name}`}>
      <input ref={field} className="taskOwnInput taskColumnName" aria-label="Column name" maxLength={TASK_BOUNDS.columnNameLength} value={draft}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => void commitName()} onKeyDown={nameKeys} />
      <div className="taskColumnActions">
        <button type="button" className="commandIconAction taskColumnMove" data-column-move="left" aria-label={`Move ${column.name} left`} title={`Move ${column.name} left`}
          disabled={index === 0} onClick={() => onMove("left")}><CommandIcon name="arrow" /></button>
        <button type="button" className="commandIconAction taskColumnMove" data-column-move="right" aria-label={`Move ${column.name} right`} title={`Move ${column.name} right`}
          disabled={index >= columnCount - 1} onClick={() => onMove("right")}><CommandIcon name="arrow" /></button>
        <button type="button" className="commandQuietAction" aria-label={`Delete column ${column.name}`} aria-describedby={reason ? noteId : undefined}
          disabled={reason !== null} onClick={() => void remove()}>Delete column</button>
      </div>
      <div className="taskGateField">
        <span className="taskGateFieldLabel">{ROLE_LABEL}</span>
        <CommandSelect aria-label={`${ROLE_LABEL}: ${column.name}`} value={role} options={ROLE_OPTIONS} disabled={edits.busy}
          onChange={(value) => { if (value !== role) void edits.setColumnRole(column.id, value === NO_ROLE ? null : value); }} />
      </div>
      {reason && <p id={noteId} className="newTaskHelper">{reason}</p>}
    </div>}
  </>;
}
