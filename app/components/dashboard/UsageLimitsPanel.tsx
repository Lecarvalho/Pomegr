import type { ProviderSource, UsageLimits } from "../../../shared/monitor-contract";
import { usageLimitSeverity } from "../../../shared/usage-limit-severity.mjs";
import { usageLimitDisplay, usageLimitFailureKind, usageLimitFailureMessage } from "../../usage-limit-presentation";
import { EmptyState } from "../EmptyState";
import { ClaudeUsageControls } from "../ClaudeUsageControls";
import { MinuteRelativeTimeText, ResetCountdownText, RetryCountdownText } from "../LiveTime";

export function UsageLimitsPanel({ source, usageLimits }: { source: ProviderSource; usageLimits: UsageLimits }) {
  const failureKind = usageLimitFailureKind(usageLimits);
  const refreshNotice = failureKind === "authentication_required" || failureKind === "rate_limited";
  const refreshTitle = failureKind === "authentication_required" ? "Usage access interrupted" : "Refresh rate-limited";
  const local = usageLimits.origin === "local_observation";
  const displayedLimits = usageLimitDisplay(usageLimits);

  return (
    <section className="panel limitsPanel" aria-label="Provider usage limits">
      <div className="limitsHeader">
        <h2>Usage limits</h2>
        <span className="quiet usageCheck">
          {usageLimits.fetchedAt
            ? <>{local ? "Last observed" : "Updated"} <MinuteRelativeTimeText value={usageLimits.fetchedAt} /></>
            : usageLimits.attemptedAt
              ? <>Checked <MinuteRelativeTimeText value={usageLimits.attemptedAt} /></>
              : "Connecting…"}
        </span>
      </div>
      {local && usageLimits.freshness === "stale" && <p className="usageObservationNote">Showing the last observation. Current usage may have changed.</p>}
      <div className="limitCards">
        {!usageLimits.available && <EmptyState text={refreshNotice ? "Usage data is unavailable." : usageLimitFailureMessage(source, usageLimits)} />}
        {displayedLimits.current.map((limit) => (
          <article className={`limitCard ${usageLimitSeverity(limit.percent)}`} key={limit.id}>
            <div className="limitTop"><div><span>{limit.window}</span><strong>{limit.label}</strong></div><b>{Math.round(limit.percent)}%</b></div>
            <div className="limitTrack"><i style={{ transform: `scaleX(${Math.min(100, Math.max(0, limit.percent)) / 100})` }} /></div>
            <div className="limitBottom"><span><ResetCountdownText value={limit.resetsAt} /></span>{limit.active && <em>Active limit</em>}</div>
          </article>
        ))}
        {displayedLimits.localFable?.kind === "retained" && <article className={`limitCard ${usageLimitSeverity(displayedLimits.localFable.limit.percent)}`} key="retained-model-fable">
          <div className="limitTop"><div><span>{displayedLimits.localFable.limit.window}</span><strong>{displayedLimits.localFable.limit.label}</strong></div><b>{Math.round(displayedLimits.localFable.limit.percent)}%</b></div>
          <div className="limitTrack"><i style={{ transform: `scaleX(${Math.min(100, Math.max(0, displayedLimits.localFable.limit.percent)) / 100})` }} /></div>
          <div className="limitBottom"><span><ResetCountdownText value={displayedLimits.localFable.limit.resetsAt} /></span><span>Last API value <MinuteRelativeTimeText value={displayedLimits.localFable.fetchedAt} /></span></div>
        </article>}
        {displayedLimits.localFable?.kind === "unavailable" && <article className="limitCard" key="unavailable-model-fable">
          <div className="limitTop"><div><span>7 days</span><strong>Fable</strong></div><b>{displayedLimits.localFable.label}</b></div>
          <div className="limitBottom"><span>{displayedLimits.localFable.detail}</span></div>
        </article>}
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
      {source === "Claude Code" && <ClaudeUsageControls usageLimits={usageLimits} />}
    </section>
  );
}
