import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsAnalyticsSnapshot, AgentsRun } from "../../shared/agents-contract";
import { AgentsView } from "../../app/components/agents/AgentsView";

type Filters = Pick<AgentsAnalyticsSnapshot["filters"], "project" | "days" | "scope">;
const defaults: Filters = { project: "all", days: 30, scope: "all" };
function snapshot(filters: Filters = defaults): AgentsAnalyticsSnapshot {
  const run: AgentsRun = {
    id: "run", agentId: "primary", sessionId: "codex:example", source: "Codex", project: "Pomegr",
    sessionTitle: "Example", label: "Example agent", assignment: null, role: "builder", model: "Example model",
    modelEvidence: "latest_reported", scope: filters.scope === "delegated" ? "delegated" : "main", parentId: null,
    depth: 0, status: "active", startedAt: "2026-09-01T12:00:00.000Z", lastSeen: "2026-09-01T12:00:00.000Z",
    latestContextTotal: 100, toolCalls: 0, executionTaskCount: 0, work: [],
  };
  const main = run.scope === "main" ? 1 : 0;
  return {
    revision: 1, readiness: "ready", generatedAt: "2026-09-01T12:00:00.000Z",
    filters: { ...filters, projects: ["Pomegr", "Another project with a long name"] },
    coverage: { retainedSessions: 1, eligibleSessions: 1, missingSessions: 0, retainedRuns: 1, truncated: false, earliestStartedAt: run.startedAt },
    summary: { runCount: 1, sessionCount: 1, modelCount: 1, mainRunCount: main, delegatedRunCount: 1 - main },
    models: [{ model: run.model, runCount: 1, mainRunCount: main, delegatedRunCount: 1 - main, roles: [{ role: run.role, runCount: 1 }] }],
    runs: [run], roster: [run], work: [],
  };
}
const response = (filters: Filters = defaults) => new Response(JSON.stringify(snapshot(filters)));
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const pendingResponse = () => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe("Agents selection transitions", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("keeps controls, options and evidence mounted until a fast scope response commits", async () => {
    const next = pendingResponse();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockReturnValueOnce(next.promise);
    render(<AgentsView />); await flush();
    const project = screen.getByRole("combobox", { name: "Project" });
    const options = within(project).getAllByRole("option");
    const content = screen.getByText("Latest reported model per agent run");
    const about = screen.getByText("About this data");
    const live = screen.getByRole("tab", { name: "Live agents 1" });

    fireEvent.click(screen.getByRole("button", { name: "Main" }));
    expect(screen.getByRole("button", { name: "All agents" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: "Project" })).toBe(project);
    expect(within(project).getAllByRole("option")).toEqual(options);
    expect(screen.getByText("Latest reported model per agent run")).toBe(content);
    expect(screen.getByText("About this data")).toBe(about);
    expect(screen.getByRole("tab", { name: "Live agents 1" })).toBe(live);
    expect(screen.queryByLabelText("Loading agent summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    next.resolve(response({ ...defaults, scope: "main" })); await flush();
    expect(screen.getByRole("button", { name: "Main" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tabpanel")).not.toHaveAttribute("aria-busy");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains slow or failed selections without replacing applied filters or evidence", async () => {
    const next = pendingResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(response({ ...defaults, project: "Pomegr" }));
    render(<AgentsView />); await flush();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "Pomegr" } });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("all");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole("status")).toHaveTextContent("Loading All agents · Pomegr · Last 30 days. Your current selection stays visible.");
    next.reject(new Error("PRIVATE_FAILURE")); await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Could not load All agents · Pomegr");
    expect(screen.getByRole("status")).not.toHaveTextContent("PRIVATE_FAILURE");
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("all");
    expect(screen.getByText("Latest reported model per agent run")).toBeInTheDocument();
    fireEvent(window, new Event("focus")); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Pomegr");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("aborts superseded scopes and ignores their late responses", async () => {
    const main = pendingResponse(), delegated = pendingResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockReturnValueOnce(main.promise).mockReturnValueOnce(delegated.promise);
    render(<AgentsView />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Main" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegated" }));
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    delegated.resolve(response({ ...defaults, scope: "delegated" })); await flush();
    main.resolve(response({ ...defaults, scope: "main" })); await flush();
    expect(screen.getByRole("button", { name: "Delegated" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Loading agent summary")).not.toBeInTheDocument();
  });

  it("keeps background polls quiet and preserves live roster controls", async () => {
    const next = pendingResponse();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockReturnValueOnce(next.promise);
    render(<AgentsView />); await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Live agents 1" }));
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Example" } });
    fireEvent(window, new Event("focus"));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText("Summary observed")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("Example");
    next.resolve(new Response(null, { status: 204 })); await flush();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("Example");
  });
});
