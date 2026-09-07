"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";
import type { ProviderId } from "../../../shared/monitor-contract";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { ProviderBadge } from "../ProviderBadge";
import { CommandComingSoon, CommandEmpty, CommandIcon, CommandPage } from "../command-center/CommandPage";
import { repositoryTab, repositoryTabs, type RepositoryTab } from "./repository-route";

export function RepositoryDetailView({ repositoryId, initialTab = "overview", initialProvider, initialRevisionId }: {
  repositoryId: string;
  initialTab?: RepositoryTab;
  initialProvider?: ProviderId;
  initialRevisionId?: string;
}) {
  const { snapshot, loading, connected } = useRepositoryInventory();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const tab = repositoryTab(searchParams.get("tab")) ?? initialTab;
  const repository = snapshot.repositories.find((entry) => entry.id === repositoryId);

  const switchTab = (next: RepositoryTab) => {
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", next);
    if (!query.has("provider") && initialProvider) query.set("provider", initialProvider);
    if (!query.has("revision") && initialRevisionId) query.set("revision", initialRevisionId);
    router.replace(`/repositories/${repositoryId}?${query}`, { scroll: false });
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
        {tab === "git" ? <CommandComingSoon title="Detailed repository evidence is coming soon" detail="Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only." icon="git" /> : <h2>{repositoryTabs.find(([id]) => id === tab)?.[1]}</h2>}
      </div>
    </div>
  </section>;
}
