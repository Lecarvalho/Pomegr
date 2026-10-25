"use client";

import { Fragment, useEffect, useId, useRef, useState, type RefObject } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { TASK_LOG_LABELS, type TaskLog, type TaskLogAnswer } from "./task-desktop";
import { TaskDialog } from "./TaskModalFrame";
import { scheduleLabel, timeOfDay } from "./task-schedule";

export type TaskLogRead = { state: "pending" } | { state: "failed" } | { state: "ready"; log: TaskLog };

function logTime(at: number) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "—";
  const instant = date.toISOString();
  return date.toDateString() === new Date().toDateString() ? timeOfDay(instant) : scheduleLabel(instant);
}

export function TaskLogPanel({ read, onClose, titleId, closeRef }: { read: TaskLogRead; onClose(): void; titleId: string; closeRef?: RefObject<HTMLButtonElement | null> }) {
  const log = read.state === "ready" ? read.log : null;
  const entries = log ? [...log.entries].sort((a, b) => b.id - a.id) : [];
  const divider = log && entries.some((entry) => entry.id > log.arilCursor) ? entries.find((entry) => entry.id <= log.arilCursor)?.id : undefined;
  return <div className="taskQueueSettings taskScorecard" aria-busy={read.state === "pending" || undefined}>
    <header className="taskQueueSettingsHead">
      <h2 id={titleId}>Task log</h2>
      <button ref={closeRef} type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <p className="taskGatesCaption">Task starts, reports, stalls, CI results, and merges on this board, newest first. Aril reads the entries after its last answer.</p>
    {read.state === "pending" && <p className="taskGatesCaption">Reading the task log…</p>}
    {read.state === "failed" && <p className="taskGatesCaption" role="alert">The task log could not be read.</p>}
    {log && (entries.length === 0 ? <p className="taskGatesCaption">Nothing logged yet.</p> : <ol className="taskGateList taskLogList" aria-label="Task log entries">
      {entries.map((entry) => <Fragment key={entry.id}>
        <li className="taskGateRow taskLogRow">
          <time className="taskScorecardId">{logTime(entry.at)}</time>
          <span className="taskScorecardId">{entry.task}</span>
          <span>{TASK_LOG_LABELS[entry.kind]}</span>
          {entry.pullRequest !== null && <span className="taskScorecardId">PR #{entry.pullRequest}</span>}
        </li>
        {entry.id === divider && <li className="taskGateRow taskGatesCaption">Aril has read up to here</li>}
      </Fragment>)}
    </ol>)}
    {log?.more && <p className="taskGatesCaption">Showing the newest 200 entries.</p>}
    <p className="taskGatesCaption">The task log stays on this computer.</p>
  </div>;
}

export function TaskLogDialog({ readTaskLog, returnFocus, onClose }: { readTaskLog(): Promise<TaskLogAnswer>; returnFocus: RefObject<HTMLElement | null>; onClose(): void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [read, setRead] = useState<TaskLogRead>({ state: "pending" });
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const opener = returnFocus.current;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [returnFocus]);
  useEffect(() => {
    let current = true;
    void readTaskLog().then((answer) => { if (current) setRead(answer.ok ? { state: "ready", log: answer.log } : { state: "failed" }); })
      .catch(() => { if (current) setRead({ state: "failed" }); });
    return () => { current = false; };
  }, [readTaskLog]);
  return <TaskDialog className="taskModalScrim taskQueueSettingsScrim" labelledBy={titleId} closeOnScrim onClose={onClose}>
    <TaskLogPanel read={read} onClose={onClose} titleId={titleId} closeRef={closeRef} />
  </TaskDialog>;
}
