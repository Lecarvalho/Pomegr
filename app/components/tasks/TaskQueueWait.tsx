import type { WaitDetail } from "./task-wait-model";

/** The Queue block of the task modal: where a waiting task stands in the start order, and why it has not started. */
export function TaskQueueWait({ detail }: { detail: WaitDetail }) {
  return <div className="newTaskField taskQueueWait" role="group" aria-label="Queue">
    <span className="taskQueueWaitLabel">Queue</span>
    <p className="taskQueueWaitPlace">{detail.place}</p>
    <ul className="taskQueueWaitReasons">{detail.lines.map((line) => <li key={line}>{line}</li>)}</ul>
  </div>;
}
