"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import type { TaskBoardEdits } from "./use-task-board-edits";

/**
 * Add column (design contract D28): a Secondary action in the page head. It is unavailable once the board holds
 * the most columns it can. Activating it swaps in a one-line form (name, Add, Cancel); the new column is appended last.
 */
export function AddColumnAction({ edits, full, describedBy }: { edits: TaskBoardEdits; full: boolean; describedBy?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    if (open) { field.current?.focus({ preventScroll: true }); return; }
    if (returnFocus.current) { returnFocus.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [open]);

  const close = () => { returnFocus.current = true; setName(""); setOpen(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || edits.busy) return;
    if (await edits.addColumn(trimmed)) close(); else field.current?.focus({ preventScroll: true });
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  if (!open) {
    return <button ref={trigger} type="button" className="commandSecondaryAction" disabled={full} aria-describedby={full ? describedBy : undefined} onClick={() => setOpen(true)}>Add column</button>;
  }
  return <form className="taskAddColumn" onSubmit={(event) => void submit(event)}>
    <input ref={field} className="taskOwnInput" aria-label="Column name" maxLength={TASK_BOUNDS.columnNameLength} value={name} readOnly={edits.busy}
      onChange={(event) => setName(event.target.value)} onKeyDown={keys} />
    <button type="submit" className="commandSecondaryAction" disabled={!trimmed || edits.busy}>Add</button>
    <button type="button" className="commandQuietAction" onClick={close}>Cancel</button>
  </form>;
}
