"use client";

import { useState } from "react";
import Link from "next/link";
import type { RepositorySummary } from "../../../shared/monitor-contract";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { ProviderBadge } from "../ProviderBadge";
import { CommandEmpty, CommandFilter, CommandIcon, CommandPage, CommandSearch, CommandToolbar } from "../command-center/CommandPage";
import { repositoryLastActivity, repositorySetupSummary } from "./repository-setup";

type RepositoryFilter = "all" | "attention" | "live";

function RepositoryRow({ repository }: { repository: RepositorySummary }) {
  const setup = repositorySetupSummary(repository);
  return <Link className="commandRepositoryRow" href={`/repositories/${repository.id}`} aria-label={`${repository.displayName}, ${setup.label}`}>
    <span className="commandRepositoryIcon"><CommandIcon name="repositories" size="small" /></span>
    <span className="commandRepositoryBody">
      <span className="commandRepositoryNameAndSetup">
        <span className="commandRepositoryIdentity"><strong>{repository.displayName}</strong><small>{repository.sessionCount} observed session{repository.sessionCount === 1 ? "" : "s"} · last {repositoryLastActivity(repository)}</small></span>
        <span className={`commandChip commandRepositorySetup${setup.tone === "neutral" ? "" : ` ${setup.tone}`}`}><i aria-hidden="true" />{setup.label}</span>
      </span>
      <span className="commandRepositoryMeta">
        <span className="commandRepositorySessions"><span><strong className={repository.liveCount > 0 ? "live" : undefined}>{repository.liveCount}</strong> live</span><span className="commandRepositoryMobileDot" aria-hidden="true">·</span><span><strong>{repository.historyCount}</strong> history</span></span>
        <span className="commandRepositoryMobileDot" aria-hidden="true">·</span>
        <span className="commandRepositoryProviders">{repository.providers.filter((provider) => provider.sessionCount > 0).map((provider) => <ProviderBadge key={provider.provider} source={provider.source} />)}</span>
      </span>
    </span>
    <span className="commandRepositoryArrow"><CommandIcon name="chevron" size="small" /></span>
  </Link>;
}

export function RepositoryInventoryView() {
  const { snapshot, loading, connected } = useRepositoryInventory();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepositoryFilter>("all");
  const matchingSearch = snapshot.repositories.filter((repository) => repository.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const repositories = matchingSearch.filter((repository) => filter === "all" || (filter === "live" ? repository.liveCount > 0 : repositorySetupSummary(repository).tone === "warning"));
  const attentionCount = repositories.filter((repository) => repositorySetupSummary(repository).tone === "warning").length;
  const count = `${repositories.length} repositories${attentionCount ? ` · ${attentionCount} needs attention` : ""}`;
  const empty = !connected && !snapshot.repositories.length
    ? { title: "Repository inventory unavailable", detail: "Pomegr will retry the local monitor automatically." }
    : !snapshot.repositories.length
      ? { title: "No repositories observed", detail: "Repositories appear after their sessions are observed." }
      : !matchingSearch.length
        ? { title: "No repositories match", detail: "Try a different repository name." }
        : { title: filter === "attention" ? "No repositories need attention" : "No repositories are live now", detail: `Clear the filter to see all ${snapshot.repositories.length} repositories.` };

  return <CommandPage title="Repositories" description="Observed projects, Pomegr plugin setup, and saved provider diagnostics." busy={loading && !snapshot.repositories.length}>
    <div className="commandRepositoryToolbar"><CommandToolbar>
      <CommandSearch value={query} onChange={setQuery} placeholder="Filter repositories" label="Filter repositories" />
      <div className="commandRepositoryFilters">
        <CommandFilter active={filter === "all"} onClick={() => setFilter("all")}>All</CommandFilter>
        <CommandFilter active={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</CommandFilter>
        <CommandFilter active={filter === "live"} onClick={() => setFilter("live")}>Live now</CommandFilter>
      </div>
      <span className="commandToolbarCount">{count}</span>
    </CommandToolbar></div>
    {repositories.length ? <div className="commandRepositoryList">
      <div className="commandRepositoryListCount">{count}</div>
      <div className="commandRepositoryHead" aria-hidden="true"><span /><span>Repository</span><span>Providers</span><span>Sessions</span><span>Setup</span><span /></div>
      {repositories.map((repository) => <RepositoryRow key={repository.id} repository={repository} />)}
    </div> : <CommandEmpty {...empty} icon="repositories" />}
    <p className="commandRepositoryFootnote">Rows reflect session associations only. Branch, working-tree, and pull-request detail will appear inside each repository when the monitor can provide a bounded repository summary.</p>
  </CommandPage>;
}
