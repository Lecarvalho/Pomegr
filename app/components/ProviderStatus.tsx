"use client";

import type { ProviderId, ProviderServiceStatus } from "../../shared/monitor-contract";
import { DottedInfoPopover } from "./DottedInfoPopover";
import { ExternalLink } from "./ExternalLink";
import styles from "./ProviderStatus.module.css";

const STATUS_LABELS: Record<ProviderServiceStatus["status"], string> = {
  operational: "Reported healthy",
  degraded: "Degraded service",
  outage: "Service outage",
  maintenance: "Maintenance",
  unknown: "Status unknown",
};
function statusTone(status: ProviderServiceStatus["status"], freshness: ProviderServiceStatus["freshness"]) {
  if (freshness !== "fresh") return "unknown";
  if (status === "outage") return "critical";
  if (status === "degraded" || status === "maintenance") return "warning";
  return status === "operational" ? "okay" : "unknown";
}
export function providerStatusTone(status: ProviderServiceStatus | undefined) {
  return status?.readiness === "ready" ? statusTone(status.status, status.freshness) : "unknown";
}
function statusLabel(status: ProviderServiceStatus | undefined) {
  if (!status || status.readiness === "loading") return "Provider status loading";
  if (status.readiness === "unavailable" && !status.checkedAt) return "Provider status unavailable";
  if (status.freshness !== "fresh") return "Provider status may be stale";
  if (status.readiness === "unavailable") return "Status refresh delayed";
  return STATUS_LABELS[status.status];
}
function timestamp(value: string | null) { return value ? new Date(value).toLocaleString() : "Not reported"; }
function statusLink(status: ProviderServiceStatus) { return status.incidents[0]?.url || status.statusPageUrl; }

export function ProviderStatusIndicator({ status, compact = false }: { status: ProviderServiceStatus | undefined; compact?: boolean }) {
  const label = statusLabel(status);
  const tone = providerStatusTone(status);
  return <span className={`${styles.indicator} ${styles[tone]}${compact ? ` ${styles.compact}` : ""}`} title={label} aria-label={`Provider service status: ${label}`}>
    <span className={styles.dot} aria-hidden="true" /><span>{label}</span>
  </span>;
}

function ProviderStatusSymbol({ status }: { status: ProviderServiceStatus | undefined }) {
  const tone = providerStatusTone(status);
  return <svg className={`${styles.mobileSymbol} ${styles[tone]}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {tone === "okay" ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></> : tone === "warning" || tone === "critical" ? <><path d="m12 3 10 18H2L12 3Z M12 9v5M12 17h.01" /></> : <><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" /></>}
  </svg>;
}

export function ProviderStatusDetails({ status, compact = false, mobileIconOnly = false, chip = false, dotOnly = false }: { status: ProviderServiceStatus | undefined; compact?: boolean; mobileIconOnly?: boolean; chip?: boolean; dotOnly?: boolean }) {
  const source = status?.source || "Provider";
  if (!status) return dotOnly ? <span className={`${styles.dot} ${styles.unknown}`} role="img" aria-label={statusLabel(status)} /> : <ProviderStatusIndicator status={status} compact={compact} />;
  const label = statusLabel(status);
  const linkLabel = `View ${status.incidents.length ? "incident" : "status page"}`;
  return <DottedInfoPopover
    ariaLabel={`${source} provider service status details${mobileIconOnly || chip || dotOnly ? `: ${label}` : ""}`}
    className={`${styles.details}${compact ? ` ${styles.detailsCompact}` : ""}${mobileIconOnly ? ` ${styles.mobileIconOnly}` : ""}${chip ? ` ${styles.chip} ${styles[providerStatusTone(status)]}` : ""}${dotOnly ? ` ${styles.dotOnly} ${styles[providerStatusTone(status)]}` : ""}`}
    content={<>
      {(mobileIconOnly || dotOnly) && <p className={dotOnly ? styles.statusLabel : styles.mobileStatusLabel}>{label}</p>}
      <dl className={styles.detailList}><div><dt>Last checked</dt><dd>{timestamp(status.checkedAt)}</dd></div><div><dt>Provider update</dt><dd>{timestamp(status.updatedAt)}</dd></div></dl>
    </>}
    link={{ href: statusLink(status), label: linkLabel, ariaLabel: linkLabel }}
  >
    {dotOnly ? <span className={`${styles.dot} ${styles[providerStatusTone(status)]}`} aria-hidden="true" /> : <ProviderStatusIndicator status={status} compact={compact} />}
    {mobileIconOnly && <ProviderStatusSymbol status={status} />}
  </DottedInfoPopover>;
}

export function ProviderStatusArea({ providers, className = "", headingId }: { providers: ProviderServiceStatus[]; className?: string; headingId?: string }) {
  return <aside className={`${styles.area} ${headingId ? styles.panel : ""} ${className}`} aria-label={headingId ? undefined : "Provider service status"} aria-labelledby={headingId}>
    {headingId ? <h2 id={headingId}>Provider status</h2> : <span className={styles.areaLabel}>Provider status</span>}
    <div className={styles.areaRows}>
      {providers.map((provider) => <span className={styles.areaRow} key={provider.provider}><strong>{provider.source}</strong><ProviderStatusDetails status={provider} compact /></span>)}
    </div>
  </aside>;
}

const IMPACT_RANK = { none: 0, minor: 1, major: 2, critical: 3 } as const;
const STATUS_RANK = { operational: 0, unknown: 0, maintenance: 1, degraded: 2, outage: 3 } as const;
export function providerIncidentRank(status: ProviderServiceStatus) {
  return STATUS_RANK[status.status] * 4 + Math.max(...status.incidents.map((incident) => IMPACT_RANK[incident.impact]), 0);
}
export type ProviderIncidentDismissal = { key: string; rank: number } | null;
const SESSION_NOTICE_DISMISSAL_LIMIT = 24;
const dismissedProviderIncidents = new Map<string, Exclude<ProviderIncidentDismissal, null>>();
export function dismissedProviderIncidentFor(sessionId: string | null): ProviderIncidentDismissal { return sessionId ? dismissedProviderIncidents.get(sessionId) || null : null; }
export function dismissProviderIncident(sessionId: string, dismissal: Exclude<ProviderIncidentDismissal, null>) {
  dismissedProviderIncidents.delete(sessionId);
  dismissedProviderIncidents.set(sessionId, dismissal);
  if (dismissedProviderIncidents.size > SESSION_NOTICE_DISMISSAL_LIMIT) dismissedProviderIncidents.delete(dismissedProviderIncidents.keys().next().value!);
}
export function providerHasServiceIssue(status: ProviderServiceStatus | undefined): status is ProviderServiceStatus {
  return Boolean(status && status.readiness !== "loading" && status.freshness === "fresh" && ["degraded", "outage", "maintenance"].includes(status.status));
}
export function providerServiceNoticeVisible(status: ProviderServiceStatus | undefined, historical: boolean, dismissed: ProviderIncidentDismissal, sessionReady = true) {
  if (!sessionReady || historical || !providerHasServiceIssue(status)) return false;
  const key = status.incidentKey || status.status;
  return !dismissed || dismissed.key !== key || providerIncidentRank(status) > dismissed.rank;
}

export function ProviderServiceNotice({ status, onDismiss }: { status: ProviderServiceStatus; onDismiss: () => void }) {
  const incident = status.incidents[0];
  const refreshDelayed = status.readiness === "unavailable";
  return <aside className={styles.notice} role="status" aria-label={`${status.source} provider service notice`}>
    <span className={styles.noticeMark} aria-hidden="true">!</span>
    <div><strong>{status.source} reports service issues</strong><p>{incident ? `${incident.label.replace(/[.!?]+$/u, "")}. ` : ""}Requests may be delayed or fail.{refreshDelayed ? " Pomegr could not refresh this status; this is the last confirmed report." : ""}</p>
      <div className={styles.noticeMeta}><span>Last checked {timestamp(status.checkedAt)}</span><span>Provider update {timestamp(status.updatedAt)}</span><ExternalLink href={statusLink(status)} aria-label={`View ${incident ? "incident" : "status page"}`}>View {incident ? "incident" : "status page"}</ExternalLink></div>
    </div>
    <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss provider service notice">Dismiss</button>
  </aside>;
}

export function providerStatusFor(providers: ProviderServiceStatus[], provider: ProviderId) { return providers.find((entry) => entry.provider === provider); }
