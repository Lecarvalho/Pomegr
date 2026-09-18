"use client";

import { DottedInfoPopover } from "../../DottedInfoPopover";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { activityDuration } from "./duration";
import type { ActivityFeedView } from "./useActivityFeed";

/**
 * Left rail: per-kind call counters that filter the request list, plus aggregate shell counts.
 * Only bounded, browser-safe metadata renders here: kind, count, share and median wall duration.
 */
export function ActivityKindRail({ feed, selection }: { feed: ActivityFeedView; selection: SessionRequestSelection }) {
  const kindTotal = feed.byKind.reduce((sum, row) => sum + row.count, 0);
  const kindMax = feed.byKind.reduce((max, row) => Math.max(max, row.count), 0);
  // Busiest kind first: the bars only read as a ranking when the rows follow their own lengths.
  const rows = [...feed.byKind].sort((left, right) => right.count - left.count || WORK_LABELS[left.kind].localeCompare(WORK_LABELS[right.kind]));
  return <div className="activityBreakdown">
    <header><h3 className="sessionEyebrow">Actions by kind</h3><span>count</span><span>share</span><span>median</span></header>
    <div className="activityKindRows" role="group" aria-label="Filter calls by kind">
      {rows.map(({ kind, count, medianDurationMs }) => <button type="button" key={kind} className="commandQuietAction activityKindRow" aria-pressed={selection.workKind === kind}
        onClick={() => selection.setWorkKind(selection.workKind === kind ? null : kind)}>
        <WorkKindIcon kind={kind} /><span className="activityKindLabel">{WORK_LABELS[kind]}</span>
        {/* The bar compares kinds against the busiest one; the share column keeps the count-over-total
            reading. A recorded kind keeps a 2% sliver so one call is still visible beside 59. */}
        <span className="activityKindBar" aria-hidden="true"><i style={{ width: `${kindMax ? Math.max(2, Math.round(count / kindMax * 100)) : 0}%` }} /></span>
        <strong>{count.toLocaleString()}</strong><span>{kindTotal ? Math.round(count / kindTotal * 100) : 0}%</span><span>{activityDuration(medianDurationMs)}</span>
      </button>)}
    </div>
    <div className="activityOtherCounts">
      <div><span>Shell tasks</span><strong>{feed.shellTasks.total.toLocaleString()}</strong></div>
      <div className={feed.shellTasks.failed ? "activityFailures" : ""}><span>Failed shell runs</span><strong>{feed.shellTasks.failed.toLocaleString()}</strong></div>
    </div>
    <p className="activityKindCaveat"><DottedInfoPopover ariaLabel="About these counts" content="Counts describe recorded tool calls, not effort or quality. Duration is wall time from call to result, including approval waits.">Counts, not effort or cost.</DottedInfoPopover></p>
  </div>;
}
