import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import type { MonitorState } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function liveState(id: string, title: string): MonitorState {
  return {
    ...createEmptyMonitorState({ connected: true }),
    session: {
      id,
      title,
      project: "Pomegr",
      cwd: "C:\\Workspace\\repos\\pomegr",
      repository: { available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } },
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:01:00.000Z",
      durationMs: 60_000,
      cost: null,
      approvalMode: null,
      contextMachinery: null,
      summary: null,
      signal: null,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("dashboard session navigation", () => {
  it("pins the first displayed session so live polling cannot navigate elsewhere", async () => {
    const firstSession = liveState("claude:live-1", "First live session");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: [] }));
      if (url === "/api/state") return Promise.resolve(jsonResponse(firstSession));
      if (url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(firstSession));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(<Dashboard />);

    expect(await screen.findByText("First live session")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/state?sessionId=claude%3Alive-1",
      expect.objectContaining({ cache: "no-store" }),
    ));
  });

  it("selects only a normalized session ID from native notification navigation", async () => {
    window.history.replaceState(null, "", "/?sessionId=codex%3Anotified-1");
    const notified = liveState("codex:notified-1", "Notified session");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: [] }));
      if (url === "/api/state?sessionId=codex%3Anotified-1") return Promise.resolve(jsonResponse(notified));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(<Dashboard />);
    expect(await screen.findByText("Notified session")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/state?sessionId=codex%3Anotified-1",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(window.location.search).toBe("");
  });

  it("ignores unsafe notification navigation values", async () => {
    window.history.replaceState(null, "", "/?sessionId=codex%3A..%2Fprivate");
    const first = liveState("claude:live-1", "First live session");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: [] }));
      if (url === "/api/state") return Promise.resolve(jsonResponse(first));
      if (url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(first));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(<Dashboard />);
    expect(await screen.findByText("First live session")).toBeInTheDocument();
  });
});
