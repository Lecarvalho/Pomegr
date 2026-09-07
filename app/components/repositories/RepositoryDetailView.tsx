"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ProviderId, RepositoryProviderInventory } from "../../../shared/monitor-contract";
import type { RepositoryPluginAction } from "../../../shared/repository-plugin-contract";
import { repositoryInventoryDesktopBridge, useRepositoryInventory } from "../../repository-inventory-client";
import { ProviderBadge } from "../ProviderBadge";
import { CommandComingSoon, CommandEmpty, CommandIcon, CommandPage } from "../command-center/CommandPage";
import { repositoryRouteOptions, repositoryTab, repositoryTabs, type RepositoryTab } from "./repository-route";
import { pluginActionMessage, type ProviderFeedback } from "./repository-setup-details";
import { PluginSetupRow } from "./PluginSetupRow";
import { RepositoryReportingRow } from "./RepositoryReportingRow";
import { RepositoryInventoryTab } from "./RepositoryInventoryTab";
import { RepositoryOverviewTab } from "./RepositoryOverviewTab";

const subscribeDesktopBridge = () => () => {};

export function RepositoryDetailView({ repositoryId, initialTab = "overview", initialProvider, initialRevisionId }: {
  repositoryId: string;
  initialTab?: RepositoryTab;
  initialProvider?: ProviderId;
  initialRevisionId?: string;
}) {
  const { snapshot, loading, connected, refresh } = useRepositoryInventory();
  const [confirming, setConfirming] = useState<ProviderId | null>(null);
  const [pluginActionKey, setPluginActionKey] = useState<string | null>(null);
  const [captureKey, setCaptureKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ProviderFeedback | null>(null);
  const actionInFlight = useRef(false);
  const desktopPlugin = useSyncExternalStore(subscribeDesktopBridge, () => Boolean(repositoryInventoryDesktopBridge()?.repositoryPluginAction), () => false);
  const desktopCapture = useSyncExternalStore(subscribeDesktopBridge, () => Boolean(repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory), () => false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const tab = repositoryTab(searchParams.get("tab")) ?? initialTab;
  const previousTab = useRef(tab);
  useEffect(() => {
    if (previousTab.current !== tab) {
      tabsRef.current[repositoryTabs.findIndex(([id]) => id === tab)]?.focus();
      previousTab.current = tab;
    }
  }, [tab]);
  const restoreActionFocus = (opener: Element | null) => {
    // Do not interrupt someone who moved to another control while the native action ran.
    if (document.activeElement === document.body || document.activeElement === opener) {
      tabsRef.current.find((button) => button?.getAttribute("aria-selected") === "true")?.focus();
    }
  };
  const cancelCapture = () => {
    setConfirming(null);
    restoreActionFocus(document.activeElement);
  };
  const repository = snapshot.repositories.find((entry) => entry.id === repositoryId);
  const inventorySelection = repositoryRouteOptions({
    provider: searchParams.get("provider") ?? initialProvider,
    revision: searchParams.has("tab") ? searchParams.get("revision") ?? undefined : initialRevisionId,
  });
  const selectRevision = (provider: ProviderId, revisionId: string) => {
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", "inventory");
    query.set("provider", provider);
    query.set("revision", revisionId);
    router.replace(`/repositories/${repositoryId}?${query}`, { scroll: false });
  };

  const switchTab = (next: RepositoryTab, provider?: ProviderId) => {
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", next);
    if (!query.has("provider") && initialProvider) query.set("provider", initialProvider);
    if (!query.has("revision") && initialRevisionId) query.set("revision", initialRevisionId);
    if (provider) { query.set("provider", provider); query.delete("revision"); }
    setConfirming(null);
    router.replace(`/repositories/${repositoryId}?${query}`, { scroll: false });
  };
  const capture = async (provider: RepositoryProviderInventory) => {
    if (actionInFlight.current || !repository) return;
    const opener = document.activeElement;
    actionInFlight.current = true;
    const key = `${repositoryId}:${provider.provider}:inventory`;
    setCaptureKey(key);
    setConfirming(null);
    setFeedback({ key, tone: "pending", message: `Capturing ${provider.source} inventory for ${repository.displayName}.` });
    try {
      const status = await repositoryInventoryDesktopBridge()?.captureRepositoryContextInventory?.(repositoryId, provider.provider) || "unavailable";
      setFeedback({ key, tone: status === "completed" ? "success" : status === "busy" ? "neutral" : "error", message: status === "completed" ? `${provider.source} inventory captured.` : status === "busy" ? "A capture is already running." : `${provider.source} inventory capture ${status.replace("_", " ")}.` });
    } catch {
      setFeedback({ key, tone: "error", message: `${provider.source} inventory capture failed.` });
    } finally {
      setCaptureKey(null);
      actionInFlight.current = false;
      await refresh(true);
      restoreActionFocus(opener);
    }
  };
  const runPluginAction = async (provider: RepositoryProviderInventory, action: RepositoryPluginAction) => {
    if (actionInFlight.current) return;
    const opener = document.activeElement;
    actionInFlight.current = true;
    const key = `${repositoryId}:${provider.provider}:plugin`;
    setPluginActionKey(key);
    setFeedback({ key, tone: "pending", message: action === "recheck" ? `Checking ${provider.source} plugin setup.` : `${action === "update" ? "Updating" : "Installing"} the ${provider.source} plugin.` });
    try {
      const status = await repositoryInventoryDesktopBridge()?.repositoryPluginAction?.(repositoryId, provider.provider, action) || "unavailable";
      setFeedback({ key, tone: status === "completed" || status === "changed" ? "success" : status === "cancelled" || status === "busy" ? "neutral" : "error", message: pluginActionMessage(provider, action, status) });
    } catch {
      setFeedback({ key, tone: "error", message: "The plugin action could not finish. Recheck the local setup before trying again." });
    } finally {
      setPluginActionKey(null);
      actionInFlight.current = false;
      await refresh(true);
      restoreActionFocus(opener);
    }
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % repositoryTabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + repositoryTabs.length) % repositoryTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = repositoryTabs.length - 1;
    else return;
    event.preventDefault();
    switchTab(repositoryTabs[next][0]);
    tabsRef.current[next]?.focus();
  };

  if (!repository) {
    const unavailable = !connected || snapshot.readiness === "unavailable";
    const busy = !unavailable && (loading || snapshot.readiness === "loading");
    return <CommandPage title="Repository" busy={busy}>
      {busy ? <div className="repositoryDetailSkeleton" aria-label="Loading repository"><span /><span /></div> : <>
        <CommandEmpty title={unavailable ? "Repository inventory unavailable" : "Repository not observed"} detail={unavailable ? "Pomegr will retry the local monitor automatically." : "This repository has no observed sessions on this machine."} icon="repositories" />
        <Link className="commandTextLink" href="/repositories">Back to repositories</Link>
      </>}
    </CommandPage>;
  }

  return <section className="commandView repositoryDetail" aria-labelledby="repository-title">
    <header className="commandViewIntro repositoryDetailHeader">
      <div className="repositoryDetailIdentity">
        <span className="repositoryDetailIcon"><CommandIcon name="repositories" /></span>
        <div className="commandPageHeading">
          <h1 id="repository-title">{repository.displayName}</h1>
          <div className="repositoryDetailMeta">
            <span className="repositoryDetailCount"><strong className={repository.liveCount > 0 ? "live" : undefined}>{repository.liveCount}</strong> live</span>
            <span aria-hidden="true">·</span>
            <span className="repositoryDetailCount"><strong>{repository.historyCount}</strong> history</span>
            {repository.providers.some((provider) => provider.sessionCount > 0) && <span aria-hidden="true">·</span>}
            {repository.providers.filter((provider) => provider.sessionCount > 0).map((provider) => <ProviderBadge key={provider.provider} source={provider.source} />)}
          </div>
        </div>
      </div>
      <Link className="commandSecondaryAction" href={`/sessions?repository=${repository.id}`}>View sessions <CommandIcon name="arrow" size="small" /></Link>
    </header>
    <div className="commandSettingsLayout repositoryDetailLayout">
      <div className="commandSettingsNav" role="tablist" aria-label="Repository sections">
        {repositoryTabs.map(([id, label], index) => <button key={id} ref={(node) => { tabsRef.current[index] = node; }} type="button" role="tab" id={`repository-tab-${id}`} aria-controls={`repository-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={`commandQuietAction${tab === id ? " active" : ""}`} onClick={() => switchTab(id)} onKeyDown={(event) => handleTabKey(event, index)}>
          <span>{label}</span>{id === "git" && <> <span className="repositoryDetailSoon">Soon</span></>}
        </button>)}
      </div>
      <div className="commandSettingsPane" role="tabpanel" id={`repository-panel-${tab}`} aria-labelledby={`repository-tab-${tab}`} tabIndex={0}>
        {tab === "overview" ? <RepositoryOverviewTab repository={repository} /> : tab === "plugin" ? <>
          <div className="repositoryPaneHead"><div><h2>Plugin</h2><p>Install and manage the Pomegr plugin for each provider. Installation and updates run natively on this machine after a confirmation.</p></div></div>
          {repository.providers.map((provider) => {
            const key = `${repositoryId}:${provider.provider}`;
            return <section key={key} aria-label={`${provider.source} setup`}>
              <header className="repositorySectionHead"><div><ProviderBadge source={provider.source} /></div></header>
              <PluginSetupRow provider={provider} desktop={desktopPlugin} actionRunning={Boolean(pluginActionKey || captureKey)} feedback={feedback?.key === `${key}:plugin` ? feedback : null} onAction={(action) => void runPluginAction(provider, action)} />
            </section>;
          })}
          <p className="repositorySetupFootnote">Plugin state is a local observation, rechecked on demand. Raw configuration never leaves this machine.</p>
        </> : tab === "inventory" ? <RepositoryInventoryTab repository={repository} initialProvider={inventorySelection.initialProvider} initialRevisionId={inventorySelection.initialRevisionId} desktop={desktopCapture} confirming={confirming} captureKey={captureKey} feedback={feedback} onProvider={(provider) => switchTab("inventory", provider)} onRevision={selectRevision} onConfirm={setConfirming} onCancel={cancelCapture} onCapture={(provider) => void capture(provider)} /> : tab === "reporting" ? <>
          <header className="repositoryPaneHead"><div><h2>Repository reporting</h2><p>One policy, shared by Claude Code and Codex, that chooses what agents report about this repository.</p></div></header>
          <RepositoryReportingRow reporting={repository.reporting} />
        </> : <CommandComingSoon title="Detailed repository evidence is coming soon" detail="Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only." icon="git" />}
      </div>
    </div>
  </section>;
}
