import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";

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

  it("reports the monitor offline only after a request actually fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unavailable"));

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Local monitor offline" })).toBeInTheDocument());
    expect(screen.getByText("Monitor offline")).toBeInTheDocument();
  });

});
