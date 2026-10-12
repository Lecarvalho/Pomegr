"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import type { TaskBoard } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { QueueBlockRules } from "./QueueBlockRules";
import { SchedulePanel } from "./SchedulePanel";
import { StartGatesPanel } from "./StartGatesPanel";
import { TaskDialog } from "./TaskModalFrame";
import type { TaskBoardEdits } from "./use-task-board-edits";

type Props = { queue: TaskBoard["queue"]; edits?: TaskBoardEdits; onClose(): void };

/** The panel's own content: its head, then Start gates, Schedule and the blocking rules. Without `edits` it is read-only. */
export function QueueSettings({ queue, edits, onClose, titleId, closeRef }: Props & { titleId: string; closeRef?: RefObject<HTMLButtonElement | null> }) {
  return <div className="taskQueueSettings">
    <header className="taskQueueSettingsHead">
      <h2 id={titleId}>Queue settings</h2>
      <button ref={closeRef} type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <StartGatesPanel queue={queue} edits={edits} />
    <SchedulePanel queue={queue} edits={edits} />
    <QueueBlockRules />
  </div>;
}

/** Queue settings as a side panel at the right edge of the Tasks page. Focus returns to `returnFocus` when it closes. */
export function QueueSettingsPanel({ returnFocus, ...props }: Props & { returnFocus: RefObject<HTMLElement | null> }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const opener = returnFocus.current;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [returnFocus]);
  return <TaskDialog className="taskModalScrim taskQueueSettingsScrim" labelledBy={titleId} closeOnScrim onClose={props.onClose}>
    <QueueSettings {...props} titleId={titleId} closeRef={closeRef} />
  </TaskDialog>;
}
