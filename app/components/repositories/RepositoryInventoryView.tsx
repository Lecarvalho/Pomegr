"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import type { ContextInventoryRevisionDetail, ProviderId, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import type { RepositoryPluginAction, RepositoryPluginActionStatus, RepositoryPluginSetup, RepositoryReportingSetup } from "../../../shared/repository-plugin-contract";
import { compactNumber, relativeTime } from "../../dashboard-utils";
import { fetchRepositoryInventoryDetail, repositoryInventoryDesktopBridge, useRepositoryInventory } from "../../repository-inventory-client";
import { ProviderBadge } from "../ProviderBadge";
import { CommandComingSoon, CommandEmpty, CommandIcon, CommandPage, CommandSearch, CommandToolbar } from "../command-center/CommandPage";

function providerKey(repositoryId: string, provider: ProviderId) { return `${repositoryId}:${provider}`; }
const subscribeDesktopBridge = () => () => {};

function inventoryStatus(entry: RepositoryProviderInventory) {
  return entry.status === "not_captured" ? "NOT CAPTURED" : entry.status.toUpperCase();
}

function failureMessage(kind: RepositoryProviderInventory["failureKind"]) {
  if (kind === "executable_unavailable") return "Claude Code executable unavailable";
  if (kind === "timed_out") return "The diagnostic timed out";
  if (kind === "invalid_output") return "Claude Code returned an unsupported diagnostic format";
  return "The local diagnostic could not run";
}

function versionLabel(version: string | null) {
  return version ? (version.startsWith("v") ? version : `v${version}`) : null;
}

function pluginStatus(setup: RepositoryPluginSetup | undefined) {
  if (setup?.readiness === "loading") return { label: "Checking plugin setup", tone: "checking" };
  if (!setup || setup.readiness === "unavailable" || setup.installation === "unknown") return { label: "Unable to verify", tone: "unknown" };
  if (setup.installation === "not_installed") return { label: "Not installed", tone: "neutral" };
  if (setup.enabled === true) return { label: "Enabled", tone: "ready" };
  if (setup.enabled === false) return { label: "Disabled", tone: "warning" };
  return { label: "Status unknown", tone: "unknown" };
}

function pluginDetail(setup: RepositoryPluginSetup | undefined) {
  if (setup?.readiness === "loading") return "Checking local installation and update information.";
  if (!setup || setup.readiness === "unavailable" || setup.installation === "unknown") return "Local installation records could not be verified. Recheck to refresh the available information.";
  if (setup.installation === "not_installed") return "Enable agent-reported signals and progress for this provider.";
  const scope = setup.scope ? `${setup.scope[0].toUpperCase()}${setup.scope.slice(1)} installation` : "Local installation";
  if (setup.update.status === "available") return `${scope} · Update ${versionLabel(setup.update.version) || "available"}`;
  if (setup.update.status === "pinned") return `${scope} · Version is pinned`;
  if (setup.update.status === "unavailable") return `${scope} · Update check unavailable`;
  if (setup.update.status === "unknown") return `${scope} · Update status unknown`;
  return `${scope} · Up to date`;
}

function reportingState(reporting: RepositoryReportingSetup | undefined) {
  if (!reporting || reporting.status === "unknown") return { label: "Unavailable", detail: "Reporting setup could not be verified.", tone: "unknown" };
  if (reporting.status === "configured") return { label: "Configured", detail: reporting.version === null ? "Shared repository reporting policy" : `Shared repository policy · Version ${reporting.version}`, tone: "ready" };
  if (reporting.status === "invalid") return { label: "Invalid", detail: "Review the repository reporting policy with your coding agent.", tone: "warning" };
  return { label: "Not configured", detail: "Choose what agents report · Shared by Claude Code and Codex", tone: "neutral" };
}

function pluginActionMessage(provider: RepositoryProviderInventory, action: RepositoryPluginAction, status: RepositoryPluginActionStatus) {
  if (status === "busy") return "A plugin action is already running.";
  if (status === "cancelled") return "No plugin changes were made.";
  if (status === "unavailable") return "This plugin action is unavailable in the current Pomegr desktop version.";
  if (status === "timed_out") return "The plugin action timed out. Recheck the local setup before trying again.";
  if (status === "failed") return "The plugin action could not finish. Recheck the local setup before trying again.";
  if (action === "recheck") return `${provider.source} plugin setup checked.`;
  const followUp = provider.provider === "codex"
    ? " Restart Codex, review hook trust, then start a new session."
    : " Reload Claude Code before starting a new session.";
  return `${action === "update" ? "Plugin update" : "Plugin installation"} completed. Pomegr refreshed the local setup.${followUp}`;
}

type ProviderFeedback = { key: string; message: string; tone: "pending" | "success" | "neutral" | "error" };

function ProviderPluginSetupRow({ provider, desktop, actionRunning, feedback, onAction }: {
  provider: RepositoryProviderInventory;
  desktop: boolean;
  actionRunning: boolean;
  feedback: ProviderFeedback | null;
  onAction: (action: RepositoryPluginAction) => void;
}) {
  const setup = provider.pluginSetup;
  const state = pluginStatus(setup);
  const version = versionLabel(setup?.version || null);
  const checkedAt = setup?.checkedAt || setup?.update.checkedAt;
  return <div className="repositorySetupRow">
    <div className="repositorySetupInfo">
      <div className="repositorySetupTitle"><strong>Pomegr plugin</strong>{version && <code>{version}</code>}<span className={`repositorySetupStatus ${state.tone}`}>{state.label}</span></div>
      <small>{pluginDetail(setup)}{checkedAt && <span className="repositorySetupChecked">Checked {relativeTime(checkedAt)}</span>}</small>
      {feedback && <p className={`repositorySetupFeedback ${feedback.tone}`} role="status">{feedback.message}</p>}
    </div>
    <div className="repositorySetupActions">
      {desktop ? <>
        <button type="button" className="commandQuietAction" disabled={actionRunning} onClick={() => onAction("recheck")}>Recheck</button>
        {setup?.canInstall && <button type="button" className="commandPrimaryAction" disabled={actionRunning} onClick={() => onAction("install")}>Install plugin</button>}
        {setup?.canUpdate && <button type="button" className="commandPrimaryAction" disabled={actionRunning} onClick={() => onAction("update")}>Update plugin</button>}
      </> : <details className="repositorySetupInstructions"><summary>View setup instructions</summary><p>{provider.source === "Codex" ? "Add the Pomegr marketplace and plugin in Codex, then restart and review its hooks." : "Add the Pomegr marketplace and plugin in Claude Code, choose Project scope, then reload plugins."} <a href="https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md">Read the plugin instructions</a>.</p></details>}
    </div>
  </div>;
}

function RepositoryReportingRow({ repositoryId, reporting }: { repositoryId: string; reporting: RepositoryReportingSetup | undefined }) {
  const [open, setOpen] = useState(false);
  const state = reportingState(reporting);
  const helpId = `repository-reporting-help-${repositoryId}`;
  return <section className="repositoryReporting" aria-label="Shared repository reporting">
    <div className="repositorySetupRow">
      <div className="repositorySetupInfo">
        <div className="repositorySetupTitle"><strong>Repository reporting</strong><span className={`repositorySetupStatus ${state.tone}`}>{state.label}</span></div>
        <small>{state.detail}</small>
      </div>
      <div className="repositorySetupActions"><button type="button" className="commandSecondaryAction" aria-expanded={open} aria-controls={helpId} onClick={() => setOpen((current) => !current)}>{reporting?.status === "configured" ? "Review reporting" : "Configure reporting"}</button></div>
    </div>
    {open && <div className="repositoryReportingHelp" id={helpId}><strong>Set up reporting in your coding agent</strong><p>Use <code>/pomegr:init</code> in Claude Code or <code>$pomegr:init</code> in Codex. The agent proposes repository signals for you to review before saving.</p></div>}
  </section>;
}

function RevisionEvidence({ repository, provider, selectedRevisionId, onSelect }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  selectedRevisionId: string;
  onSelect: (revisionId: string) => void;
}) {
  const requestKey = `${repository.id}:${provider.provider}:${selectedRevisionId}`;
  const [loaded, setLoaded] = useState<{ key: string; detail: ContextInventoryRevisionDetail | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchRepositoryInventoryDetail(repository.id, provider.provider, selectedRevisionId, controller.signal)
      .then((detail) => setLoaded({ key: requestKey, detail }), () => setLoaded({ key: requestKey, detail: null }));
    return () => controller.abort();
  }, [provider.provider, repository.id, requestKey, selectedRevisionId]);
  const detail = loaded?.key === requestKey ? loaded.detail : null;
  if (loaded?.key !== requestKey) return <p className="repositoryInventoryLoading">Loading saved inventory…</p>;
  if (!detail) return <p className="repositoryInventoryUnavailable">Detailed evidence is no longer retained for this revision.</p>;
  const current = provider.currentRevision;
  return <div className="repositoryInventoryEvidence">
    <section className="repositoryInventorySummary" aria-label={`${provider.source} inventory summary`}>
      <div><span>Captured</span><strong>{relativeTime(detail.capturedAt)}</strong></div>
      <div><span>Model</span><strong>{detail.model}</strong></div>
      <div><span>Revision</span><strong>{detail.id}</strong></div>
      <div><span>Estimated setup</span><strong>{compactNumber(detail.machineryTokens)} tokens</strong></div>
    </section>
    {detail.change.state !== "first_capture" && <p className={`repositoryInventoryChange ${detail.change.state}`}>
      {detail.change.state === "unchanged" ? "No normalized inventory change" : "Changed"} since {detail.change.previousRevisionId}.
    </p>}
    <section className="repositoryInventoryBreakdown">
      <div className="repositoryInventoryHeading"><h3>{provider.source} category breakdown</h3><span>{detail.categoryCount} categories · {detail.itemCount} listed items</span></div>
      <div className="repositoryCategoryGrid" role="list" aria-label="Estimated context categories">
        {detail.categories.map((category) => <div className="repositoryCategory" role="listitem" key={category.name}><span>{category.name}</span><strong>{category.tokens}</strong><small>{category.percentage}%</small></div>)}
      </div>
    </section>
    {detail.groups.length > 0 && <details className="repositoryInventoryDetails"><summary>Inspect {detail.itemCount} listed items</summary><div className="repositoryInventoryGroups">{detail.groups.map((group) => <section key={group.id}><h4>{group.label}</h4>{group.items.map((item, index) => <div className="repositoryInventoryItem" key={`${item.name}-${index}`}><span><strong>{item.name}</strong><small>{item.detail}</small></span><b>{item.tokens}</b></div>)}</section>)}</div></details>}
    {provider.revisions.length > 1 && <details className="repositoryInventoryDetails"><summary>Compare {provider.source} revisions</summary><div className="repositoryRevisionCompare"><label>Revision<select value={selectedRevisionId} onChange={(event) => onSelect(event.currentTarget.value)}>{provider.revisions.map((revision) => <option value={revision.id} key={revision.id}>{revision.id} · {compactNumber(revision.machineryTokens)}</option>)}</select></label>{current && current.id !== detail.id && <dl><div><dt>Estimated setup</dt><dd>{compactNumber(detail.machineryTokens - current.machineryTokens)} vs current</dd></div><div><dt>Categories</dt><dd>{detail.categoryCount - current.categoryCount} vs current</dd></div><div><dt>Listed items</dt><dd>{detail.itemCount - current.itemCount} vs current</dd></div></dl>}</div></details>}
    <p className="repositoryInventoryPrivacy">Raw provider output never enters browser state or persistence. Only bounded normalized evidence is saved.</p>
  </div>;
}

function ProviderInventory({ repository, provider, desktop, confirming, onConfirm, onCancel, onCapture, pluginActionRunning, feedback, onPluginAction, initialRevisionId }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  desktop: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onCapture: () => void;
  pluginActionRunning: boolean;
  feedback: ProviderFeedback | null;
  onPluginAction: (action: RepositoryPluginAction) => void;
  initialRevisionId?: string | null;
}) {
  const [requestedRevisionId, setRequestedRevisionId] = useState<string | null>(initialRevisionId || null);
  const [inventoryOpen, setInventoryOpen] = useState(Boolean(initialRevisionId));
  const selectedRevisionId = provider.revisions.some((revision) => revision.id === requestedRevisionId)
    ? requestedRevisionId! : initialRevisionId && provider.revisions.some((revision) => revision.id === initialRevisionId)
      ? initialRevisionId : provider.currentRevision?.id || "";
  const captureLabel = provider.status === "failed" ? "Retry diagnostic" : provider.currentRevision ? "Capture again" : "Capture inventory";
  return <section className="repositoryProvider" aria-label={`${provider.source} context inventory`}>
    <header className="repositoryProviderHead"><div className="repositoryProviderIdentity"><ProviderBadge source={provider.source} /><span>{provider.sessionCount} observed session{provider.sessionCount === 1 ? "" : "s"}</span></div></header>
    <ProviderPluginSetupRow provider={provider} desktop={desktop && Boolean(repositoryInventoryDesktopBridge()?.repositoryPluginAction)} actionRunning={pluginActionRunning} feedback={feedback} onAction={onPluginAction} />
    <details className="repositoryContextDisclosure" open={inventoryOpen} onToggle={(event) => setInventoryOpen(event.currentTarget.open)}>
      <summary>Context inventory <span>{provider.status === "unavailable" ? "· Unavailable" : provider.currentRevision ? `· ${provider.currentRevision.id} saved` : "· Not captured"}</span></summary>
      <div className="repositoryProviderRow">
        <div className="repositoryProviderState"><span className={`repositoryProviderBadge ${provider.status}`}>{inventoryStatus(provider)}</span>{provider.status === "unavailable" ? <small>Pomegr will not combine or approximate Claude Code evidence.</small> : provider.status === "capturing" ? <small>Previous revision remains available until commit</small> : provider.status === "failed" ? <small>{failureMessage(provider.failureKind)} · no data saved</small> : provider.currentRevision ? <small>{provider.currentRevision.id} · {compactNumber(provider.currentRevision.machineryTokens)} estimated tokens</small> : <small>Native provider diagnostic</small>}</div>
        {provider.supported && <div className="repositoryProviderAction">{desktop ? <button type="button" className={provider.currentRevision ? "commandSecondaryAction" : "commandPrimaryAction"} disabled={provider.status === "capturing"} onClick={onConfirm}>{captureLabel}</button> : <span className="repositoryProviderRemoteHint">Capture available in Pomegr desktop</span>}</div>}
      </div>
      {confirming && <div className="repositoryCaptureConfirm" role="group" aria-label={`Confirm ${provider.source} inventory capture`}><span><strong>Run a {provider.source} diagnostic for {repository.displayName}?</strong><small>Starts a local diagnostic process and saves only normalized inventory as a new immutable revision.</small></span><span><button type="button" className="commandSecondaryAction" onClick={onCancel}>Cancel</button><button type="button" className="commandPrimaryAction" onClick={onCapture}>Run diagnostic</button></span></div>}
      {provider.currentRevision && selectedRevisionId && <RevisionEvidence repository={repository} provider={provider} selectedRevisionId={selectedRevisionId} onSelect={setRequestedRevisionId} />}
    </details>
  </section>;
}

export function RepositoryInventoryView() {
  const searchParams = useSearchParams();
  const { snapshot, loading, connected, refresh } = useRepositoryInventory();
  const [query, setQuery] = useState("");
  const initialDeepLink = useMemo(() => {
    const repository = searchParams?.get("repository") || "";
    const provider = searchParams?.get("provider") || "";
    const revision = searchParams?.get("revision") || "";
    return /^repo-[a-f0-9]{24}$/u.test(repository) && ["claude", "codex"].includes(provider) && /^ctx-\d{3,9}$/u.test(revision)
      ? { repository, provider, revision } : null;
  }, [searchParams]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialDeepLink ? [initialDeepLink.repository] : []));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pluginActionKey, setPluginActionKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ProviderFeedback | null>(null);
  const desktop = useSyncExternalStore(
    subscribeDesktopBridge,
    () => Boolean(repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory),
    () => false,
  );
  const repositories = useMemo(() => snapshot.repositories.filter((repository) => repository.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query, snapshot.repositories]);
  const toggle = (repositoryId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(repositoryId)) next.delete(repositoryId); else next.add(repositoryId);
    return next;
  });
  const capture = async (repository: RepositorySummary, provider: RepositoryProviderInventory) => {
    const key = providerKey(repository.id, provider.provider);
    setConfirming(null);
    setFeedback({ key, tone: "pending", message: `Capturing ${provider.source} inventory for ${repository.displayName}.` });
    const status = await repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory(repository.id, provider.provider) || "unavailable";
    setFeedback({ key, tone: status === "completed" ? "success" : status === "busy" ? "neutral" : "error", message: status === "completed" ? `${provider.source} inventory captured.` : status === "busy" ? "A capture is already running." : `${provider.source} inventory capture ${status.replace("_", " ")}.` });
    await refresh(true);
  };
  const runPluginAction = async (repository: RepositorySummary, provider: RepositoryProviderInventory, action: RepositoryPluginAction) => {
    const key = providerKey(repository.id, provider.provider);
    setPluginActionKey(key);
    setFeedback({ key, tone: "pending", message: action === "recheck" ? `Checking ${provider.source} plugin setup.` : `${action === "update" ? "Updating" : "Installing"} the ${provider.source} plugin.` });
    try {
      const status = await repositoryInventoryDesktopBridge()?.repositoryPluginAction(repository.id, provider.provider, action) || "unavailable";
      setFeedback({ key, tone: status === "completed" || status === "changed" ? "success" : status === "cancelled" || status === "busy" ? "neutral" : "error", message: pluginActionMessage(provider, action, status) });
    } catch {
      setFeedback({ key, tone: "error", message: "The plugin action could not finish. Recheck the local setup before trying again." });
    } finally {
      setPluginActionKey(null);
      await refresh(true);
    }
  };
  return <CommandPage title="Repositories" description="Observed projects, Pomegr plugin setup, and saved provider diagnostics." busy={loading && !snapshot.repositories.length}>
    <CommandToolbar><CommandSearch value={query} onChange={setQuery} placeholder="Filter repositories" label="Filter repositories" /><span className="commandToolbarCount">{repositories.length} repositories · Saved diagnostics</span></CommandToolbar>
    {!connected && !snapshot.repositories.length ? <CommandEmpty title="Repository inventory unavailable" detail="Pomegr will retry the local monitor automatically." icon="repositories" /> : !repositories.length ? <CommandEmpty title={snapshot.repositories.length ? "No repositories match" : "No repositories observed"} detail={snapshot.repositories.length ? "Try a different repository name." : "Repositories appear after their sessions are observed."} icon="repositories" /> : <div className="commandRepositoryList">{repositories.map((repository) => {
      const open = expanded.has(repository.id);
      const panelId = `repository-providers-${repository.id}`;
      return <article className={`commandRepositoryDisclosure ${open ? "expanded" : ""}`} key={repository.id}>
        <button type="button" className="commandRepositoryRow" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(repository.id)}>
          <span className="commandRepositoryChevron"><CommandIcon name="chevron" size="small" /></span><span className="commandRepositoryIdentity"><CommandIcon name="repositories" size="small" /><span><strong>{repository.displayName}</strong><small>{repository.sessionCount} observed session{repository.sessionCount === 1 ? "" : "s"}</small></span></span><span className="commandRepositoryStat"><strong>{repository.liveCount}</strong> live</span><span className="commandRepositoryStat"><strong>{repository.historyCount}</strong> history</span><span className="commandRepositoryProviders"><strong>{repository.providerCount}</strong> observed provider{repository.providerCount === 1 ? "" : "s"}</span>
        </button>
        {open && <div className="commandRepositoryProvidersPanel" id={panelId}>{repository.providers.map((provider) => {
          const key = providerKey(repository.id, provider.provider);
          return <ProviderInventory key={key} repository={repository} provider={provider} desktop={desktop} confirming={confirming === key} onConfirm={() => setConfirming(key)} onCancel={() => setConfirming(null)} onCapture={() => void capture(repository, provider)} pluginActionRunning={pluginActionKey === key} feedback={feedback?.key === key ? feedback : null} onPluginAction={(action) => void runPluginAction(repository, provider, action)} initialRevisionId={initialDeepLink?.repository === repository.id && initialDeepLink.provider === provider.provider ? initialDeepLink.revision : null} />;
        })}<RepositoryReportingRow repositoryId={repository.id} reporting={repository.reporting} /><div className="repositoryGitComingSoon"><CommandIcon name="git" size="small" /><span>Git details coming soon</span></div></div>}
      </article>;
    })}</div>}
    <CommandComingSoon title="Detailed repository evidence is coming soon" detail="Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only." icon="git" />
  </CommandPage>;
}
