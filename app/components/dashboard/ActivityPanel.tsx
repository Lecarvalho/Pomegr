import type { Activity } from "../../../shared/monitor-contract";
import { shortTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { PanelHeader } from "../PanelHeader";

export function ActivityPanel({ activity, historical, loading, onRefresh }: { activity: Activity[]; historical: boolean; loading: boolean; onRefresh: () => void }) {
  return (
    <section className="panel activityPanel">
      <PanelHeader eyebrow="EVENT STREAM" title={historical ? "Recorded activity" : "Recent activity"} trailing={<button className="textButton" onClick={onRefresh} disabled={loading}>Refresh now</button>} />
      <div className="activityTable">
        <div className="activityHead"><span>TIME</span><span>AGENT</span><span>ACTION</span><span>TARGET</span></div>
        {activity.length === 0 && <EmptyState text="Tool and user activity will appear here as it happens." />}
        {activity.slice(0, 12).map((event) => <div className={`activityRow ${event.status === "failed" ? "failed" : ""}`} key={event.id}><time>{shortTime(event.timestamp)}</time><span className="actor"><i />{event.actor}</span><strong>{event.tool}</strong><span className="target" title={event.detail}>{event.detail || "—"}</span></div>)}
      </div>
    </section>
  );
}
