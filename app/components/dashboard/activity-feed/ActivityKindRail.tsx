"use client";

import type { ExecutionTask, WorkKind } from "../../../../shared/monitor-contract";
import { DottedInfoPopover } from "../../DottedInfoPopover";
import { ExecutionTaskRow } from "../../ExecutionTaskRow";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import { activityDuration } from "./duration";
import type { ActivityFeedView } from "./useActivityFeed";

const SHOWN_TASKS = 4;

export function ActivityKindRail({ feed, tasks, selectedKinds }: { feed: ActivityFeedView; tasks: ExecutionTask[]; selectedKinds: ReadonlySet<WorkKind> }) {
  const latestTasks = [...tasks].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.id.localeCompare(left.id));
  const shownTasks = latestTasks.slice(0, SHOWN_TASKS);
  const running = tasks.filter((task) => task.status === "running").length;
  const kindTotal = feed.byKind.reduce((sum, row) => sum + row.count, 0);
  const kindMax = feed.byKind.reduce((max, row) => Math.max(max, row.count), 0);
  // Busiest kind first: the bars only read as a ranking when the rows follow their own lengths.
  const rows = [...feed.byKind].sort((left, right) => right.count - left.count || WORK_LABELS[left.kind].localeCompare(WORK_LABELS[right.kind]));
  return <div className="activityBreakdown">
    <header><h3 className="sessionEyebrow">Tool calls by kind</h3><span>count</span><span>share</span><span>median</span></header>
    <div className="activityKindRows" role="list" aria-label="Recorded calls by kind">
      {rows.map(({ kind, count, medianDurationMs }) => <div key={kind} className={`activityKindRow${selectedKinds.has(kind) ? " selected" : ""}`} role="listitem"
        aria-label={selectedKinds.has(kind) ? `${WORK_LABELS[kind]} · recorded for selected request` : undefined}>
        <WorkKindIcon kind={kind} /><span className="activityKindLabel">{WORK_LABELS[kind]}</span>
        {/* A recorded kind keeps a 2% sliver so one call stays visible beside a busy kind. */}
        <span className="activityKindBar" aria-hidden="true"><i style={{ width: `${kindMax ? Math.max(2, Math.round(count / kindMax * 100)) : 0}%` }} /></span>
        <strong>{count.toLocaleString()}</strong><span>{kindTotal ? Math.round(count / kindTotal * 100) : 0}%</span><span>{activityDuration(medianDurationMs)}</span>
      </div>)}
    </div>
    <div className="activityShellTasks">
      {/* Counts retained tasks, not recorded shell calls: two sources that never share a line. */}
      <div className="activityShellHeader"><h3 className="sessionEyebrow">Shell tasks</h3>{latestTasks.length > 0 && <span>{latestTasks.length.toLocaleString()} {latestTasks.length === 1 ? "task" : "tasks"}{running ? ` · ${running} running` : ""}</span>}</div>
      {shownTasks.length > 0
        ? <div role="group" aria-label="Latest shell tasks">{shownTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} dense />)}</div>
        : <p className="activityShellEmpty">No shell task details in this scope.</p>}
      {latestTasks.length > shownTasks.length && <p className="activityShellMore">Latest {shownTasks.length} shown</p>}
    </div>
    <div className="activityOtherCounts">
      <div className={feed.shellTasks.failed ? "activityFailures" : ""}><span>Failed shell runs</span><strong>{feed.shellTasks.failed.toLocaleString()}</strong></div>
    </div>
    <p className="activityKindCaveat"><DottedInfoPopover className="activityKindInfo" ariaLabel="About these counts" content="Recorded tool calls, not effort or quality. Durations are wall time, including approval waits.">Counts, not effort or cost.</DottedInfoPopover></p>
  </div>;
}
