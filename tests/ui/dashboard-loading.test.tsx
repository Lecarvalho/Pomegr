import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

  it("keeps the explicit loading state while switching sessions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/sessions") {
        return Promise.resolve(jsonResponse({
          sessions: [{
            id: "claude:live-1",
            provider: "claude",
            source: "Claude Code",
            title: "Live work",
            project: "Threadlight",
            updatedAt: "2026-08-11T12:00:00.000Z",
            isLive: true,
            needsInput: false,
          }],
        }));
      }
      if (url.includes("sessionId=")) return new Promise<Response>(() => {});
      if (url === "/api/state") return Promise.resolve(jsonResponse(createEmptyMonitorState({ connected: true })));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    render(<Dashboard />);
    const session = await screen.findByRole("button", { name: /Live work/ });
    await user.click(session);

    expect(screen.getByRole("heading", { name: "Loading session" })).toBeInTheDocument();
    expect(screen.getByText("Connecting to monitor")).toBeInTheDocument();
    expect(screen.queryByText(/monitor offline/i)).not.toBeInTheDocument();
  });

  it("reports the monitor offline only after a request actually fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unavailable"));

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Local monitor offline" })).toBeInTheDocument());
    expect(screen.getByText("Monitor offline")).toBeInTheDocument();
  });

});
