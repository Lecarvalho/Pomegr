"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import type { TaskBoardEdits } from "./use-task-board-edits";

/**
 * + New feature (design contract D44): a Quiet action at the end of the feature filter row. It is unavailable once the
 * board holds the most features it can. Activating it swaps in a one-line form (name, Add, Cancel).
 */
export function AddFeatureAction({ edits, full }: { edits: TaskBoardEdits; full: boolean }) {
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
    if (await edits.addFeature(trimmed)) close(); else field.current?.focus({ preventScroll: true });
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  if (!open) {
    return <button ref={trigger} type="button" className="commandQuietAction" disabled={full} onClick={() => setOpen(true)}>+ New feature</button>;
  }
  return <form className="taskAddColumn" onSubmit={(event) => void submit(event)}>
    <input ref={field} className="taskOwnInput" aria-label="Feature name" maxLength={TASK_BOUNDS.featureNameLength} value={name} readOnly={edits.busy}
      onChange={(event) => setName(event.target.value)} onKeyDown={keys} />
    <button type="submit" className="commandSecondaryAction" disabled={!trimmed || edits.busy}>Add</button>
    <button type="button" className="commandQuietAction" onClick={close}>Cancel</button>
  </form>;
}
