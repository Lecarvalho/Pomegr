import type { Task } from "../../../shared/task-contract";
import { sessionListTime } from "../../dashboard-utils";
import { SafeMarkdown } from "../markdown/SafeMarkdown";

/** The agent's report under Complete when: one muted line, then the agent's own words in a notice when it gave any. */
export function TaskReportNote({ report }: { report: Pick<NonNullable<Task["report"]>, "at" | "blockReason" | "attention"> }) {
  // The time sits in parentheses.
  const time = Number.isFinite(Date.parse(report.at)) ? <> (<time dateTime={report.at}>{sessionListTime(report.at)}</time>)</> : null;
  const blocked = report.blockReason !== null;
  const words = blocked ? report.blockReason : report.attention ?? null;
  const line = blocked ? <>Agent reported it cannot continue{time}</> : <>Agent reported complete{time}{words !== null && " and asks for your attention"}</>;
  return <div className="taskCompleteWhenNote taskReport">
    <span className="newTaskHelper">{line}{words === null ? "." : ":"}</span>
    {words !== null && <div className="taskReportNotice"><SafeMarkdown text={words} /></div>}
  </div>;
}
