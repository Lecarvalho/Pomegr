"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { CommandEmpty, CommandPage, CommandSelect } from "../command-center/CommandPage";
import { repositoryRouteId } from "../repositories/repository-route";
import { TaskBoardPane } from "./TaskBoardPane";
import { TaskBoardSkeleton } from "./TaskBoardView";

const SWITCHER_ID = "tasks-repository-switcher";

const tasksHref = (repositoryId: string) => `/tasks?${new URLSearchParams({ repository: repositoryId })}`;

/**
 * Root Tasks route (`/tasks?repository=<repositoryId>`): a repository switcher over the one task board. The repository
 * comes from the URL and is validated by the shared route validator; with none, or one the inventory does not list,
 * the first listed repository is shown and the URL is replaced once with its canonical form. The board is read only
 * for a repository that is shown, so nothing is drawn and then withdrawn while the inventory loads.
 */
export function TasksPage({ initialRepositoryId }: { initialRepositoryId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { snapshot, loading, connected } = useRepositoryInventory();
  // The route validated the first value on the server; once the URL carries the parameter, it is the live one.
  const requestedId = repositoryRouteId(searchParams.has("repository") ? searchParams.get("repository") : initialRepositoryId);
  const selected = snapshot.repositories.find((repository) => repository.id === requestedId) ?? snapshot.repositories[0] ?? null;
  const selectedId = selected?.id ?? null;
  const switched = useRef(false);
  const canonicalizing = useRef<string | null>(null);

  // One replace per fallback: the ref holds the target until the URL names it, so a re-render cannot send it twice.
  useEffect(() => {
    if (!selectedId) return;
    if (selectedId === requestedId) { canonicalizing.current = null; return; }
    if (canonicalizing.current === selectedId) return;
    canonicalizing.current = selectedId;
    router.replace(tasksHref(selectedId), { scroll: false });
  }, [requestedId, router, selectedId]);
  // The board is keyed by repository, so the switcher in its header is a new element after a choice; keep focus on it.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    document.getElementById(SWITCHER_ID)?.focus({ preventScroll: true });
  }, [selectedId]);

  if (!selected) {
    const unavailable = !connected || snapshot.readiness === "unavailable";
    const busy = !unavailable && (loading || snapshot.readiness === "loading");
    return <CommandPage title="Tasks" description="Stored tasks for a repository, grouped by column." busy={busy}>
      {busy ? <TaskBoardSkeleton /> : <CommandEmpty
        title={unavailable ? "Repository inventory unavailable" : "No repositories observed"}
        detail={unavailable ? "Pomegr will retry the local monitor automatically." : "A task board appears for each repository once its sessions are observed."}
        icon="repositories" />}
    </CommandPage>;
  }

  const options = snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName }));
  return <TaskBoardPane key={selected.id} repositoryId={selected.id} switcher={
    <CommandSelect className="tasksRepositorySwitcher" id={SWITCHER_ID} aria-label="Repository" options={options} value={selected.id}
      onChange={(repositoryId) => { switched.current = true; router.replace(tasksHref(repositoryId), { scroll: false }); }} />
  } />;
}
