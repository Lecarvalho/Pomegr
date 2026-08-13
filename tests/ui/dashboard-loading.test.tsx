import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dashboard loading state", () => {
  it("shows a connecting state instead of reporting the monitor offline before the first response", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));

    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Connecting to local monitor" })).toBeInTheDocument();
    expect(screen.getByText("Connecting to monitor")).toBeInTheDocument();
    expect(screen.queryByText(/monitor offline/i)).not.toBeInTheDocument();
  });

  it("waits for a slow state request instead of starting overlapping polls", () => {
    vi.useFakeTimers();
    let stateRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/state") stateRequests += 1;
      return new Promise<Response>(() => {});
    });

    render(<Dashboard />);
    expect(stateRequests).toBe(1);

    act(() => vi.advanceTimersByTime(10_000));
    expect(stateRequests).toBe(1);
  });

  it("keeps the current dashboard visible while switching sessions", async () => {
    const user = userEvent.setup();
    const firstState = liveState("claude:live-1", "First live session");
    const secondState = liveState("claude:live-2", "Second live session");
    let resolveSecondState!: (response: Response) => void;
    const secondStateResponse = new Promise<Response>((resolve) => { resolveSecondState = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/sessions") {
        return Promise.resolve(jsonResponse({
          sessions: [firstState, secondState].map(({ session }) => ({
            id: session!.id,
            provider: "claude",
            source: "Claude Code",
            title: session!.title,
            project: session!.project,
            updatedAt: session!.updatedAt,
            isLive: true,
            needsInput: false,
          })),
        }));
      }
      if (url === "/api/state?sessionId=claude%3Alive-2") return secondStateResponse;
      if (url === "/api/state" || url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(firstState));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(<Dashboard />);
    expect(await screen.findByRole("heading", { name: "First live session" })).toBeInTheDocument();
    const session = await screen.findByRole("button", { name: /Second live session/ });
    await user.click(session);

    expect(screen.getByRole("heading", { name: "First live session" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading session" })).not.toBeInTheDocument();
    expect(screen.getByText("Monitor connected")).toBeInTheDocument();
    expect(document.querySelector(".sessionView")).toHaveAttribute("aria-busy", "true");

    await act(async () => resolveSecondState(jsonResponse(secondState)));

    expect(await screen.findByRole("heading", { name: "Second live session" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First live session" })).not.toBeInTheDocument();
  });

  it("reports the monitor offline only after a request actually fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unavailable"));

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Local monitor offline" })).toBeInTheDocument());
    expect(screen.getByText("Monitor offline")).toBeInTheDocument();
  });

});
