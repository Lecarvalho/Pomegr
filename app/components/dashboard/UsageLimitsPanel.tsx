import type { UsageLimits } from "../../../shared/monitor-contract";
import { relativeTime, resetCountdown } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";

export function UsageLimitsPanel({ usageLimits }: { usageLimits: UsageLimits }) {
  return (
    <section className="panel limitsPanel" aria-label="Claude usage limits">
      <div className="limitsHeader">
        <div><span className="label">CLAUDE PLAN</span><h2>Usage limits</h2></div>
        <span className={`quiet usageCheck ${usageLimits.error ? "stale" : ""}`} title={usageLimits.error || undefined}>
          {usageLimits.error
            ? usageLimits.fetchedAt
              ? `Checked ${relativeTime(usageLimits.fetchedAt)} · retry failed ${relativeTime(usageLimits.attemptedAt)}`
              : `Refresh failed ${relativeTime(usageLimits.attemptedAt)} · retrying`
            : usageLimits.fetchedAt ? `Checked ${relativeTime(usageLimits.fetchedAt)}` : "Connecting…"}
        </span>
      </div>
      <div className="limitCards">
        {!usageLimits.available && <EmptyState text={usageLimits.error || "Plan usage is connecting."} />}
        {usageLimits.limits.map((limit) => (
          <article className={`limitCard ${limit.severity}`} key={limit.id}>
            <div className="limitTop"><div><span>{limit.window}</span><strong>{limit.label}</strong></div><b>{Math.round(limit.percent)}%</b></div>
            <div className="limitTrack"><i style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }} /></div>
            <div className="limitBottom"><span>{resetCountdown(limit.resetsAt)}</span>{limit.active && <em>Active limit</em>}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
