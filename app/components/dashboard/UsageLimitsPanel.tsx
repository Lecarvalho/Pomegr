import type { ProviderSource, UsageLimits } from "../../../shared/monitor-contract";
import { usageLimitSeverity } from "../../../shared/usage-limit-severity.mjs";
import { usageLimitFailureKind, usageLimitFailureMessage } from "../../usage-limit-presentation";
import { EmptyState } from "../EmptyState";
import { MinuteRelativeTimeText, ResetCountdownText, RetryCountdownText } from "../LiveTime";

export function UsageLimitsPanel({ source, usageLimits }: { source: ProviderSource; usageLimits: UsageLimits }) {
  const failureKind = usageLimitFailureKind(usageLimits);
  const refreshNotice = failureKind === "authentication_required" || failureKind === "rate_limited";
  const refreshTitle = failureKind === "authentication_required" ? "Re-authentication needed" : "Refresh rate-limited";

  return (
    <section className="panel limitsPanel" aria-label="Provider usage limits">
      <div className="limitsHeader">
        <h2>Usage limits</h2>
        <span className="quiet usageCheck">
          {usageLimits.fetchedAt
            ? <>Updated <MinuteRelativeTimeText value={usageLimits.fetchedAt} /></>
            : usageLimits.attemptedAt
              ? <>Checked <MinuteRelativeTimeText value={usageLimits.attemptedAt} /></>
              : "Connecting…"}
        </span>
      </div>
      <div className="limitCards">
        {!usageLimits.available && <EmptyState text={refreshNotice ? "Usage data is unavailable." : usageLimitFailureMessage(source, usageLimits)} />}
        {usageLimits.limits.map((limit) => (
          <article className={`limitCard ${usageLimitSeverity(limit.percent)}`} key={limit.id}>
            <div className="limitTop"><div><span>{limit.window}</span><strong>{limit.label}</strong></div><b>{Math.round(limit.percent)}%</b></div>
            <div className="limitTrack"><i style={{ transform: `scaleX(${Math.min(100, Math.max(0, limit.percent)) / 100})` }} /></div>
            <div className="limitBottom"><span><ResetCountdownText value={limit.resetsAt} /></span>{limit.active && <em>Active limit</em>}</div>
          </article>
        ))}
      </div>
      {refreshNotice && (
        <div className="usageRefreshNotice" role="status">
          <strong>{refreshTitle}</strong>
          <span>
            {usageLimitFailureMessage(source, usageLimits)}
            {usageLimits.retryAt && <> <RetryCountdownText value={usageLimits.retryAt} />.</>}
          </span>
        </div>
      )}
    </section>
  );
}
