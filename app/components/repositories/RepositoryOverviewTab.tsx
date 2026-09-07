import Link from "next/link";
import type { ReactNode } from "react";
import type { RepositorySummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { compactNumber, newestSessionsFirst, relativeTime, sessionState } from "../../dashboard-utils";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { ProviderBadge } from "../ProviderBadge";
import { CommandIcon } from "../command-center/CommandPage";
import { inventoryDisplayTokens } from "../context-inventory/ContextAllocationBreakdown";
import { repositoryLastActivity, repositoryPluginAttention } from "./repository-setup";
import { inventoryState, pluginStatus, reportingState, versionLabel } from "./repository-setup-details";

function SetupCard({ title, label, tone, detail, href, linkLabel }: {
  title: string; label: ReactNode; tone: string; detail: ReactNode; href: string; linkLabel: string;
}) {
  return <div className="repositoryOverviewCard">
    <h4>{title}</h4>
    <span className={`commandChip ${tone}`}>{label}</span>
    <p>{detail}</p>
    <Link className="commandTextLink" href={href}>{linkLabel}</Link>
  </div>;
}

export function RepositoryOverviewTab({ repository }: { repository: RepositorySummary }) {
  const { sessions, loading, connected, readiness } = useSessionCatalog();
  const recent = newestSessionsFirst(sessions.filter((session) => session.repositoryId === repository.id)).slice(0, 5);
  const catalogUnavailable = !connected || readiness.catalog === "unavailable";
  const catalogLoading = loading || readiness.catalog === "loading";
  const observedProviders = repository.providers.filter((provider) => provider.sessionCount > 0);
  const attention = repositoryPluginAttention(repository);
  const bestPlugin = repository.providers.find(({ pluginSetup }) => pluginSetup?.readiness === "ready" && pluginSetup.installation === "installed" && pluginSetup.enabled === true)
    ?? repository.providers.find(({ pluginSetup }) => pluginSetup?.readiness === "ready" && pluginSetup.installation === "installed")
    ?? repository.providers[0];
  const plugin = pluginStatus(bestPlugin?.pluginSetup);
  const version = versionLabel(bestPlugin?.pluginSetup?.version ?? null);
  const unverifiedPlugin = repository.providers.some(({ pluginSetup }) => !pluginSetup || pluginSetup.readiness === "unavailable" || pluginSetup.installation === "unknown");
  const reporting = reportingState(repository.reporting);
  // A summary belongs to one provider revision; never add estimates across providers.
  const inventoryProvider = repository.providers.filter((provider) => provider.supported)
    .sort((left, right) => (Date.parse(right.currentRevision?.capturedAt ?? "") || 0) - (Date.parse(left.currentRevision?.capturedAt ?? "") || 0))[0];
  const revision = inventoryProvider?.currentRevision;
  const inventory = inventoryProvider ? inventoryState(inventoryProvider) : { label: "Unavailable", tone: "neutral" };
  const base = `/repositories/${repository.id}`;
  const sessionsHref = `/sessions?repository=${repository.id}`;

  return <>
    <div className="repositoryPaneHead"><div><h2>Overview</h2><p>Where this repository stands right now: setup that needs you, and the sessions Pomegr has observed here.</p></div></div>
    <dl className="repositoryOverviewFacts" aria-label="Repository facts">
      <div><dt>Live sessions</dt><dd className={repository.liveCount > 0 ? "live" : undefined}>{repository.liveCount}</dd></div>
      <div><dt>History</dt><dd>{repository.historyCount}</dd></div>
      <div><dt>Last activity</dt><dd>{repositoryLastActivity(repository)}</dd></div>
      <div><dt>Providers</dt><dd className="repositoryOverviewProviders">{observedProviders.length ? observedProviders.map((provider) => <ProviderBadge key={provider.provider} source={provider.source} />) : "None observed"}</dd></div>
    </dl>
    <section aria-labelledby="repository-overview-setup">
      <header className="repositorySectionHead repositoryOverviewHead"><h3 id="repository-overview-setup">Setup</h3></header>
      <div className="repositoryOverviewCards">
        <SetupCard title="Pomegr plugin" label={attention?.label ?? (unverifiedPlugin ? "Setup unverified" : <>{plugin.label}{version && <> · <span className="repositoryOverviewData">{version}</span></>}</>)} tone={attention?.tone ?? (unverifiedPlugin ? "neutral" : plugin.tone === "ready" ? "positive" : plugin.tone === "warning" ? "warning" : "neutral")}
          detail={repository.providers.length ? repository.providers.map((provider) => `${provider.source}: ${pluginStatus(provider.pluginSetup).label.toLowerCase()}`).join(" · ") : "No provider setup observed."} href={`${base}?tab=plugin`} linkLabel="Open plugin" />
        <SetupCard title="Reporting policy" label={<>{reporting.label}{repository.reporting?.status === "configured" && repository.reporting.version !== null && <> · <span className="repositoryOverviewData">v{repository.reporting.version}</span></>}</>} tone={reporting.tone === "ready" ? "positive" : reporting.tone === "warning" ? "warning" : "neutral"}
          detail={repository.reporting?.status === "configured" ? "Shared by both providers" : reporting.detail} href={`${base}?tab=reporting`} linkLabel="Open reporting" />
        <SetupCard title="Context inventory" label={inventory.label} tone={inventory.tone}
          detail={revision ? <>{inventoryProvider.source} · Captured {relativeTime(revision.capturedAt)} · <span className="repositoryInventoryTokens">{compactNumber(inventoryDisplayTokens(revision))}</span> {revision.contextAllocation ? "estimated initial tokens" : "categorized tokens"}</> : inventoryProvider ? "No saved inventory for this repository." : "No supported provider inventory observed."}
          href={`${base}?tab=inventory${inventoryProvider ? `&provider=${inventoryProvider.provider}` : ""}`} linkLabel="Open inventory" />
      </div>
    </section>
    <section aria-labelledby="repository-overview-sessions" aria-busy={catalogLoading && !recent.length}>
      <header className="repositorySectionHead repositoryOverviewHead"><h3 id="repository-overview-sessions">Recent sessions</h3><Link className="commandTextLink" href={sessionsHref}>View all {repository.sessionCount}</Link></header>
      {catalogUnavailable && <p className="repositoryOverviewMessage">Session catalog unavailable. Pomegr will retry the local monitor automatically.{recent.length > 0 && " Showing the last observed sessions."}</p>}
      {recent.length ? <div className="repositoryOverviewSessions">{recent.map((session) => {
        const status = sessionState(session);
        return <Link className="repositoryOverviewSession" key={session.id} href={`/sessions/${encodeSessionRoute(session.id)}`}>
          <span className="repositoryOverviewSessionTitle"><strong>{session.title}</strong><small>{session.agentCount === null ? "Agent count unavailable" : `${session.agentCount} agent${session.agentCount === 1 ? "" : "s"}`} · {session.source}</small></span>
          <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt)}</time>
          <span className={`commandChip ${status.state === "active" ? "positive" : status.state === "attention" ? "warning" : "neutral"}`}>{status.label}</span>
          <CommandIcon name="chevron" size="small" />
        </Link>;
      })}</div> : !catalogUnavailable && <p className="repositoryOverviewMessage">{catalogLoading ? "Loading recent sessions…" : !sessions.some((session) => session.repositoryId) ? "Sessions for this repository are listed once the monitor reports repository associations." : "No sessions for this repository in the current catalog."}</p>}
    </section>
  </>;
}
