"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import type { ContextInventoryRevisionDetail, ProviderId, RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
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

function ProviderInventory({ repository, provider, desktop, confirming, onConfirm, onCancel, onCapture, initialRevisionId }: {
  repository: RepositorySummary;
  provider: RepositoryProviderInventory;
  desktop: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onCapture: () => void;
  initialRevisionId?: string | null;
}) {
  const [requestedRevisionId, setRequestedRevisionId] = useState<string | null>(initialRevisionId || null);
  const selectedRevisionId = provider.revisions.some((revision) => revision.id === requestedRevisionId)
    ? requestedRevisionId! : initialRevisionId && provider.revisions.some((revision) => revision.id === initialRevisionId)
      ? initialRevisionId : provider.currentRevision?.id || "";
  const captureLabel = provider.status === "failed" ? "Retry diagnostic" : provider.currentRevision ? "Capture again" : "Capture inventory";
  return <section className="repositoryProvider" aria-label={`${provider.source} context inventory`}>
    <div className="repositoryProviderRow">
      <div className="repositoryProviderIdentity"><ProviderBadge source={provider.source} /><span>{provider.sessionCount} observed session{provider.sessionCount === 1 ? "" : "s"}</span></div>
      <div className="repositoryProviderState"><span className={`repositoryProviderBadge ${provider.status}`}>{inventoryStatus(provider)}</span>{provider.status === "unavailable" ? <small>Pomegr will not combine or approximate Claude Code evidence.</small> : provider.status === "capturing" ? <small>Previous revision remains available until commit</small> : provider.status === "failed" ? <small>{failureMessage(provider.failureKind)} · no data saved</small> : provider.currentRevision ? <small>{provider.currentRevision.id} · {compactNumber(provider.currentRevision.machineryTokens)} estimated tokens</small> : <small>Native provider diagnostic</small>}</div>
      {provider.supported && <div className="repositoryProviderAction">{desktop ? <button type="button" className={provider.currentRevision ? "commandSecondaryButton" : "commandPrimaryButton"} disabled={provider.status === "capturing"} onClick={onConfirm}>{captureLabel}</button> : <span className="repositoryProviderRemoteHint">Capture available in Pomegr desktop</span>}</div>}
    </div>
    {confirming && <div className="repositoryCaptureConfirm" role="group" aria-label={`Confirm ${provider.source} inventory capture`}><span><strong>Run a {provider.source} diagnostic for {repository.displayName}?</strong><small>Starts a local diagnostic process and saves only normalized inventory as a new immutable revision.</small></span><span><button type="button" className="commandSecondaryButton" onClick={onCancel}>Cancel</button><button type="button" className="commandPrimaryButton" onClick={onCapture}>Run diagnostic</button></span></div>}
    {provider.currentRevision && selectedRevisionId && <RevisionEvidence repository={repository} provider={provider} selectedRevisionId={selectedRevisionId} onSelect={setRequestedRevisionId} />}
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
  const desktop = useSyncExternalStore(
    subscribeDesktopBridge,
    () => Boolean(repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory),
    () => false,
  );
  const [announcement, setAnnouncement] = useState("");
  const repositories = useMemo(() => snapshot.repositories.filter((repository) => repository.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query, snapshot.repositories]);
  const toggle = (repositoryId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(repositoryId)) next.delete(repositoryId); else next.add(repositoryId);
    return next;
  });
  const capture = async (repository: RepositorySummary, provider: RepositoryProviderInventory) => {
    setConfirming(null);
    setAnnouncement(`Capturing ${provider.source} inventory for ${repository.displayName}.`);
    const status = await repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory(repository.id, provider.provider) || "unavailable";
    setAnnouncement(status === "completed" ? `${provider.source} inventory captured.` : status === "busy" ? "A capture is already running." : `${provider.source} inventory capture ${status.replace("_", " ")}.`);
    await refresh();
  };
  return <CommandPage title="Repositories" description="Observed repositories and saved provider configuration diagnostics." busy={loading && !snapshot.repositories.length}>
    <CommandToolbar><CommandSearch value={query} onChange={setQuery} placeholder="Filter repositories" label="Filter repositories" /><span className="commandToolbarCount">{repositories.length} repositories · Saved diagnostics</span></CommandToolbar>
    <p className="commandVisuallyHidden" aria-live="polite">{announcement}</p>
    {!connected && !snapshot.repositories.length ? <CommandEmpty title="Repository inventory unavailable" detail="Pomegr will retry the local monitor automatically." icon="repositories" /> : !repositories.length ? <CommandEmpty title={snapshot.repositories.length ? "No repositories match" : "No repositories observed"} detail={snapshot.repositories.length ? "Try a different repository name." : "Repositories appear after their sessions are observed."} icon="repositories" /> : <div className="commandRepositoryList">{repositories.map((repository) => {
      const open = expanded.has(repository.id);
      const panelId = `repository-providers-${repository.id}`;
      return <article className={`commandRepositoryDisclosure ${open ? "expanded" : ""}`} key={repository.id}>
        <button type="button" className="commandRepositoryRow" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(repository.id)}>
          <span className="commandRepositoryChevron"><CommandIcon name="chevron" size="small" /></span><span className="commandRepositoryIdentity"><CommandIcon name="repositories" size="small" /><span><strong>{repository.displayName}</strong><small>{repository.sessionCount} observed session{repository.sessionCount === 1 ? "" : "s"}</small></span></span><span className="commandRepositoryStat"><strong>{repository.liveCount}</strong> live</span><span className="commandRepositoryStat"><strong>{repository.historyCount}</strong> history</span><span className="commandRepositoryProviders"><strong>{repository.providerCount}</strong> observed provider{repository.providerCount === 1 ? "" : "s"}</span>
        </button>
        {open && <div className="commandRepositoryProvidersPanel" id={panelId}>{repository.providers.map((provider) => {
          const key = providerKey(repository.id, provider.provider);
          return <ProviderInventory key={key} repository={repository} provider={provider} desktop={desktop} confirming={confirming === key} onConfirm={() => setConfirming(key)} onCancel={() => setConfirming(null)} onCapture={() => void capture(repository, provider)} initialRevisionId={initialDeepLink?.repository === repository.id && initialDeepLink.provider === provider.provider ? initialDeepLink.revision : null} />;
        })}<div className="repositoryGitComingSoon"><CommandIcon name="git" size="small" /><span>Git details coming soon</span></div></div>}
      </article>;
    })}</div>}
    <CommandComingSoon title="Detailed repository evidence is coming soon" detail="Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only." icon="git" />
  </CommandPage>;
}
