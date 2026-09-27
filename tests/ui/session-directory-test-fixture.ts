import { vi } from "vitest";

import type { SessionSummary } from "../../shared/monitor-contract";

export function directoryResponse(sessions: SessionSummary[], overrides: Record<string, unknown> = {}) {
  return {
    sessions,
    revision: "directory-test",
    readiness: { catalog: "ready" as const },
    coverage: { status: "complete" as const, knownCount: sessions.length, exactTotal: sessions.length, observedAt: "2026-09-27T12:00:00.000Z", lastCompletedTotal: sessions.length, lastCompletedAt: "2026-09-27T12:00:00.000Z" },
    matchedCount: sessions.length,
    counts: { all: sessions.length, live: sessions.filter((session) => session.isLive).length, needs: sessions.filter((session) => session.needsInput || session.activityStatus === "needs_input").length },
    pageSize: 25,
    nextCursor: null,
    ...overrides,
  };
}

/** Explicit server-directory fixture. It never reads the shell's bounded session feed. */
export function installDirectoryFixture(initial: SessionSummary[]) {
  let rows = initial;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/sessions") && new URL(url, "http://pomegr.local").searchParams.get("mode") === "directory") {
      const params = new URL(url, "http://pomegr.local").searchParams;
      const query = (params.get("query") || "").toLowerCase();
      const visible = rows.filter((session) => {
        if (params.get("project") && session.project !== params.get("project")) return false;
        if (params.get("repositoryId") && session.repositoryId !== params.get("repositoryId")) return false;
        if (params.get("filter") === "live" && !session.isLive) return false;
        if (params.get("filter") === "needs" && !(session.needsInput || session.activityStatus === "needs_input")) return false;
        return !query || `${session.title} ${session.project} ${session.source}`.toLowerCase().includes(query);
      });
      return Promise.resolve(new Response(JSON.stringify(directoryResponse(visible)), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }));
  return (next: SessionSummary[]) => { rows = next; };
}
