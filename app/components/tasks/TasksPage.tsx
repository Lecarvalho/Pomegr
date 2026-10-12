"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { CommandBreadcrumbSeparator, CommandEmpty, CommandPage, CommandSelect } from "../command-center/CommandPage";
import { repositoryRouteId } from "../repositories/repository-route";
import { TaskBoardPane } from "./TaskBoardPane";
import { TaskBoardSkeleton } from "./TaskBoardView";
import { TasksHome, TasksHomeSkeleton, taskBoardHref } from "./TasksHome";

const SWITCHER_ID = "tasks-repository-switcher";
const HOME_HREF = "/tasks";

export function TasksPage({ initialRepositoryId }: { initialRepositoryId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { snapshot, loading, connected } = useRepositoryInventory();
  const requestedId = repositoryRouteId(searchParams.has("repository") ? searchParams.get("repository") : initialRepositoryId);
  const selected = requestedId ? snapshot.repositories.find((repository) => repository.id === requestedId) ?? null : null;
  const selectedId = selected?.id ?? null;
  // A repository the inventory does not list has no board: the page is the home, and the URL says so.
  const unlisted = searchParams.has("repository") && !selected && snapshot.repositories.length > 0;
  const switched = useRef(false);
  const canonicalizing = useRef(false);

  useEffect(() => {
    if (!unlisted) { canonicalizing.current = false; return; }
    if (canonicalizing.current) return;
    canonicalizing.current = true;
    router.replace(HOME_HREF, { scroll: false });
  }, [router, unlisted]);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    document.getElementById(SWITCHER_ID)?.focus({ preventScroll: true });
  }, [selectedId]);

  if (!snapshot.repositories.length) {
    const unavailable = !connected || snapshot.readiness === "unavailable";
    const busy = !unavailable && (loading || snapshot.readiness === "loading");
    return <CommandPage title="Tasks" description="One task board for each repository." busy={busy}>
      {busy ? (requestedId ? <TaskBoardSkeleton /> : <TasksHomeSkeleton />) : <CommandEmpty
        title={unavailable ? "Repository inventory unavailable" : "No repositories observed"}
        detail={unavailable ? "Pomegr will retry the local monitor automatically." : "A task board appears for each repository once its sessions are observed."}
        icon="repositories" />}
    </CommandPage>;
  }
  if (!selected) return <TasksHome repositories={snapshot.repositories} />;

  const options = snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName }));
  return <TaskBoardPane key={selected.id} repositoryId={selected.id}
    breadcrumb={<><Link href={HOME_HREF}>Tasks</Link><CommandBreadcrumbSeparator /><span aria-current="page">{selected.displayName}</span></>}
    switcher={
      <CommandSelect className="tasksRepositorySwitcher" id={SWITCHER_ID} aria-label="Repository" options={options} value={selected.id}
        onChange={(repositoryId) => { switched.current = true; router.replace(taskBoardHref(repositoryId), { scroll: false }); }} />
    } />;
}
