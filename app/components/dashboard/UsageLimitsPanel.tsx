import type { ProviderSource, UsageLimits } from "../../../shared/monitor-contract";
import { usageLimitSeverity } from "../../../shared/usage-limit-severity.mjs";
import { EmptyState } from "../EmptyState";
import { MinuteRelativeTimeText, ResetCountdownText } from "../LiveTime";

export function UsageLimitsPanel({ source, usageLimits }: { source: ProviderSource; usageLimits: UsageLimits }) {
  const reauthenticationRequired = /returned 401\b/i.test(usageLimits.error || "");

  return (
    <section className="panel limitsPanel" aria-label="Provider usage limits">
      <div className="limitsHeader">
        <h2>Usage limits</h2>
        <span className="quiet usageCheck">
          {usageLimits.fetchedAt ? <>Updated <MinuteRelativeTimeText value={usageLimits.fetchedAt} /></> : "Connecting…"}
        </span>
      </div>
      <div className="limitCards">
        {!usageLimits.available && <EmptyState text={usageLimits.error || "Connecting to plan usage…"} />}
        {usageLimits.limits.map((limit) => (
          <article className={`limitCard ${usageLimitSeverity(limit.percent)}`} key={limit.id}>
            <div className="limitTop"><div><span>{limit.window}</span><strong>{limit.label}</strong></div><b>{Math.round(limit.percent)}%</b></div>
            <div className="limitTrack"><i style={{ transform: `scaleX(${Math.min(100, Math.max(0, limit.percent)) / 100})` }} /></div>
            <div className="limitBottom"><span><ResetCountdownText value={limit.resetsAt} /></span>{limit.active && <em>Active limit</em>}</div>
          </article>
        ))}
      </div>
      {reauthenticationRequired && (
        <div className="usageAuthNotice" role="status">
          <strong>Re-authentication needed</strong>
          <span>Sign in to {source} again. Pomegr will retry automatically.</span>
        </div>
      )}
    </section>
  );
}
