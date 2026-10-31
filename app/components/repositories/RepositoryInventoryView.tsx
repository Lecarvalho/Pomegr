"use client";

import { useState } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { CommandEmpty, CommandFilter, CommandPage, CommandSearch, CommandToolbar } from "../command-center/CommandPage";
import { RepositoryCard } from "./RepositoryCard";
import styles from "./RepositoryCards.module.css";
import { repositorySetupSummary } from "./repository-setup";

type RepositoryFilter = "all" | "attention" | "live";

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

  return <CommandPage title="Repositories" description="Where your agents work, how busy each place is, and what still needs setting up." busy={loading && !snapshot.repositories.length}>
    <div className="commandRepositoryToolbar"><CommandToolbar>
      <CommandSearch value={query} onChange={setQuery} placeholder="Filter repositories" label="Filter repositories" />
      <div className="commandRepositoryFilters">
        <CommandFilter active={filter === "all"} onClick={() => setFilter("all")}>All</CommandFilter>
        <CommandFilter active={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</CommandFilter>
        <CommandFilter active={filter === "live"} onClick={() => setFilter("live")}>Live now</CommandFilter>
      </div>
      <span className="commandToolbarCount">{count}</span>
    </CommandToolbar></div>
    {repositories.length ? <ul className={styles.grid} aria-label="Repositories">
      {repositories.map((repository, index) => <li key={repository.id}><RepositoryCard repository={repository} enter={Math.min(index, 8)} /></li>)}
    </ul> : <CommandEmpty {...empty} icon="repositories" />}
  </CommandPage>;
}
