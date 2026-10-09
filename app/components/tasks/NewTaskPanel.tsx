"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { createDesktopTask, createFailureMessage } from "./task-desktop";

// New task side panel (design contract D184-D194, D234-D238). Part 3 builds the Task field and the footer;
// the Run on, Effort, Done when, Feature and Step fields (D195-D233) belong to part 4 and are not drawn.

/**
 * The only mutation here goes through the desktop bridge (`createDesktopTask`). Success calls `onCreated`
 * so the board is re-read; the monitor's committed answer is what the board then shows.
 */
export function NewTaskPanel({ repositoryId, repositoryName, onCreated, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  onCreated(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const helperId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  useEffect(() => {
    mounted.current = true;
    field.current?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    // A control that handled Escape itself (an open list, for instance) keeps the panel open.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const submit = async (another: boolean) => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await createDesktopTask(repositoryId, trimmed);
    inFlight.current = false;
    // The task exists once the monitor says so, even if the panel was closed in the meantime.
    if (result.ok) onCreated();
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(createFailureMessage(result.error));
      field.current?.focus({ preventScroll: true });
      return;
    }
    if (!another) { onClose(); return; }
    setText("");
    field.current?.focus({ preventScroll: true });
  };

  return <section className="newTaskPanel" role="dialog" aria-labelledby={titleId}>
    <header className="newTaskPanelHeader">
      <h2 id={titleId}>New task</h2>
      {repositoryName && <span className="newTaskPanelRepository">{repositoryName}</span>}
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      <button type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <div className="newTaskPanelBody">
      <div className="newTaskField">
        <label htmlFor={fieldId}>Task</label>
        <textarea ref={field} id={fieldId} rows={5} maxLength={TASK_BOUNDS.textLength} value={text} readOnly={busy}
          placeholder="What should the session do?" aria-describedby={failure ? `${helperId} ${errorId}` : helperId}
          onChange={(event) => setText(event.target.value)} />
        <p id={helperId} className="newTaskHelper">The card shows this text until the session has a title.</p>
        {failure && <p id={errorId} className="newTaskError" role="alert">{failure}</p>}
      </div>
    </div>
    <footer className="newTaskPanelFooter">
      <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit(false)}>Create task</button>
      <button type="button" className="commandSecondaryAction" disabled={!canSubmit} onClick={() => void submit(true)}>Create and add another</button>
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      <span className="newTaskPanelNote">Goes to Backlog, not queued</span>
    </footer>
  </section>;
}
