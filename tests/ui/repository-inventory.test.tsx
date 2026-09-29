import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoriesView } from "../../app/components/command-center/CommandViews";
import { RepositoryInventoryStore, useRepositoryInventory } from "../../app/repository-inventory-client";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";

const repositoryId = "repo-0123456789abcdef01234567";
class RepositoryEventSource {
  static instances: RepositoryEventSource[] = [];
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  constructor(_: string | URL) { RepositoryEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const entries = this.listeners.get(type) || new Set();
    entries.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, entries);
  }
  emit(value: object) { for (const listener of this.listeners.get("repositories") || []) listener(new MessageEvent("repositories", { data: JSON.stringify(value) })); }
  close() {}
}
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
function setHidden(hidden: boolean) { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); }
const snapshot: RepositoryInventorySnapshot = {
  revision: 1,
  readiness: "ready",
  repositories: [{
    id: repositoryId, name: "Pomegr", displayName: "Pomegr", sessionCount: 3, liveCount: 1, historyCount: 2,
    providerCount: 2, updatedAt: "2026-09-04T10:00:00.000Z",
    reporting: { status: "missing", version: null, checkedAt: "2026-09-04T10:00:00.000Z" },
    providers: [{ provider: "claude", source: "Claude Code", sessionCount: 2, supported: true, status: "current", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "installed", version: "0.5.0", enabled: true, scope: "user", checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "available", version: "0.6.0", checkedAt: "2026-09-04T10:00:00.000Z" }, canInstall: false, canUpdate: true },
      currentRevision: { id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, contextAllocation: { initialTokens: 1200, deferredTokens: 0, reservedTokens: 0 },
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } },
      revisions: [{ id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, contextAllocation: { initialTokens: 1200, deferredTokens: 0, reservedTokens: 0 },
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } }] },
    { provider: "codex", source: "Codex", sessionCount: 1, supported: false, status: "unavailable", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "not_installed", version: null, enabled: null, scope: null, checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "unknown", version: null, checkedAt: null }, canInstall: true, canUpdate: false },
      currentRevision: null, revisions: [] }],
  }],
};

function RefreshProbe({ onReady }: { onReady: (refresh: (force?: boolean) => Promise<void>) => void }) {
  const { refresh } = useRepositoryInventory();
  useEffect(() => onReady(refresh), [onReady, refresh]);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  RepositoryEventSource.instances = [];
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  Reflect.deleteProperty(window, "pomegrDesktop");
});

describe("repository index", () => {
  function serve(repositories = snapshot.repositories) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/repositories")
      ? new Response(JSON.stringify({ ...snapshot, repositories }), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(null, { status: 404 }));
  }

  function readyRepository() {
    const repository = structuredClone(snapshot.repositories[0]);
    repository.id = "repo-aaaaaaaaaaaaaaaaaaaaaaaa";
    repository.name = repository.displayName = "Example library";
    repository.liveCount = 0;
    repository.historyCount = repository.sessionCount;
    repository.reporting = { status: "configured", version: 1, checkedAt: null };
    for (const provider of repository.providers) {
      provider.pluginSetup = { ...provider.pluginSetup!, installation: "installed", enabled: true, canUpdate: false };
    }
    return repository;
  }

  it("composes search with attention and live filters and restores All", async () => {
    const live = readyRepository();
    live.id = "repo-bbbbbbbbbbbbbbbbbbbbbbbb";
    live.name = live.displayName = "Example live";
    live.liveCount = 1;
    serve([snapshot.repositories[0], readyRepository(), live]);
    render(<RepositoriesView />);
    await screen.findByRole("link", { name: "Pomegr, Plugin update available" });
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Needs attention" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Live now" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter repositories" }), " example ");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Example live, Ready" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.clear(screen.getByRole("searchbox"));
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
  it("serializes a forced refresh behind an in-flight poll", async () => {
    const replies: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => replies.push(resolve)));
    let refresh: ((force?: boolean) => Promise<void>) | null = null;
    render(<RefreshProbe onReady={(next) => { refresh = next; }} />);
    await waitFor(() => expect(refresh).not.toBeNull());
    await waitFor(() => expect(replies).toHaveLength(1));
    const forced = refresh!(true);
    replies.shift()!(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(replies).toHaveLength(1));
    replies.shift()!(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } }));
    await forced;
  });

  it("suppresses hidden repository publications and revalidates on foreground", async () => {
    vi.stubGlobal("EventSource", RepositoryEventSource);
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } }));
    const store = new RepositoryInventoryStore();
    const unsubscribe = store.subscribe(() => {});
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    setHidden(true);
    act(() => RepositoryEventSource.instances[0].emit({ domain: "repositories", revision: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    setHidden(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    unsubscribe();
  });
});
