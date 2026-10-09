import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/tasks/route";
import { parseTaskBoard, resetTasksStoreForTests, useTasks } from "../../app/tasks-store";
import type { Task, TaskBoard } from "../../shared/task-contract";

const repositoryId = "repo-0123456789abcdef01234567";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-1", text: "Write the changelog", columnId: "col-1", position: 0, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId,
    columns: [{ id: "col-1", name: "Backlog", position: 0 }],
    features: [], tasks: [task()], queue: { status: "idle", blockedBy: null }, ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function Probe({ id = repositoryId }: { id?: string }) {
  const { board: current, refresh } = useTasks(id);
  return <div>
    <output aria-label="readiness">{current.readiness}</output>
    <output aria-label="tasks">{current.tasks.map((entry) => entry.text).join("|")}</output>
    <output aria-label="columns">{current.columns.length}</output>
    <button type="button" onClick={() => void refresh()}>Refresh</button>
  </div>;
}

afterEach(() => {
  resetTasksStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("useTasks", () => {
  it("is loading before the first answer, then passes a ready board through", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<Probe />);
    expect(screen.getByLabelText("readiness")).toHaveTextContent("loading");
    expect(screen.getByLabelText("tasks")).toHaveTextContent("");
    answer(json(board()));
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("ready"));
    expect(screen.getByLabelText("tasks")).toHaveTextContent("Write the changelog");
    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks?repositoryId=${repositoryId}`, expect.objectContaining({ cache: "no-store" }));
  });

  it("becomes unavailable with no content when the fetch fails or answers with an error status", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("PRIVATE_DIAGNOSTIC"));
    const failed = render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("unavailable"));
    expect(screen.getByLabelText("tasks")).toHaveTextContent("");
    expect(screen.queryByText(/PRIVATE_DIAGNOSTIC/)).not.toBeInTheDocument();
    failed.unmount();
    resetTasksStoreForTests();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "boom" }, 503));
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("unavailable"));
    expect(screen.getByLabelText("columns")).toHaveTextContent("0");
  });

  it.each([
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a board for another repository", () => json(board({ repositoryId: "repo-ffffffffffffffffffffffff" }))],
    ["a board with an unknown version", () => json({ ...board(), version: 2 })],
    ["a board with an unknown readiness", () => json({ ...board(), readiness: "hydrating" })],
    ["columns that are not a list", () => json({ ...board(), columns: "Backlog" })],
    ["a task with an unknown state", () => json(board({ tasks: [task({ state: "running" as never })] }))],
    ["a task with a bad id", () => json(board({ tasks: [task({ id: "task-1" })] }))],
    ["a task with a session that is not an object", () => json(board({ tasks: [task({ session: "claude:1" as never })] }))],
    ["a task with an unknown check", () => json(board({ tasks: [task({ doneWhen: { checks: ["deploy" as never], own: null } })] }))],
    ["more tasks than the documented bound", () => json(board({ tasks: Array.from({ length: 501 }, (_, index) => task({ id: `T-${index + 1}` })) }))],
  ])("becomes unavailable with no content for %s", async (_name, response) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("unavailable"));
    expect(screen.getByLabelText("tasks")).toHaveTextContent("");
    expect(screen.getByLabelText("columns")).toHaveTextContent("0");
  });

  it("passes desktop_only through and drops any content the body carries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(board({ readiness: "desktop_only" })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("desktop_only"));
    expect(screen.getByLabelText("tasks")).toHaveTextContent("");
    expect(screen.getByLabelText("columns")).toHaveTextContent("0");
  });

  it("reads a client the proxy or LAN gateway denies as desktop_only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "denied" }, 403));
    const denied = render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("desktop_only"));
    denied.unmount();
    resetTasksStoreForTests();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("readiness")).toHaveTextContent("desktop_only"));
  });

  it("refresh refetches, and a failed refresh keeps the last resolved board", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(board()))
      .mockResolvedValueOnce(json(board({ tasks: [task({ text: "Write the changelog" }), task({ id: "T-2", text: "Cut the release", position: 1 })] })))
      .mockRejectedValueOnce(new Error("offline"));
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("tasks")).toHaveTextContent("Write the changelog"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByLabelText("tasks")).toHaveTextContent("Write the changelog|Cut the release"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("readiness")).toHaveTextContent("ready");
    expect(screen.getByLabelText("tasks")).toHaveTextContent("Write the changelog|Cut the release");
  });

  it("shares one store per repository and never writes task content to browser storage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(board()));
    render(<><Probe /><Probe /></>);
    await waitFor(() => expect(screen.getAllByLabelText("readiness")[1]).toHaveTextContent("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("parseTaskBoard", () => {
  it("keeps a valid ready board with its session and report", () => {
    const parsed = parseTaskBoard(board({ tasks: [task({ session: { id: "claude:1", title: "Fix parser", state: "working", observedModel: "opus" }, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open", passed: false }], blockReason: null } })] }), repositoryId);
    expect(parsed?.tasks[0].session?.title).toBe("Fix parser");
    expect(parsed?.queue).toEqual({ status: "idle", blockedBy: null });
  });
});

describe("GET /api/tasks proxy", () => {
  const same = (path = `/api/tasks?repositoryId=${repositoryId}`, headers: Record<string, string> = {}) =>
    new Request(`http://localhost:3003${path}`, { headers: { Host: "localhost:3003", Origin: "http://localhost:3003", "Sec-Fetch-Site": "same-origin", ...headers } });

  it("forwards one validated repository ID to the monitor with no-store", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(board()));
    const response = await GET(same());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:4317/api/tasks?repositoryId=${repositoryId}`, expect.objectContaining({ cache: "no-store" }));
    expect(((await response.json()) as TaskBoard).tasks).toHaveLength(1);
  });

  it("answers a content-free desktop_only board to a client that is not on this computer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const request of [
      new Request(`http://192.168.1.20:3003/api/tasks?repositoryId=${repositoryId}`, { headers: { Host: "192.168.1.20:3003" } }),
      same(undefined, { Origin: "https://untrusted.example" }),
      same(undefined, { "Sec-Fetch-Site": "cross-site" }),
      same(undefined, { Host: "localhost:3999" }),
      same(undefined, { "Content-Length": "1" }),
    ]) {
      const response = await GET(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ version: 1, readiness: "desktop_only", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing, malformed, repeated or extra query before proxying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const path of ["/api/tasks", "/api/tasks?repositoryId=repo-short", `/api/tasks?repositoryId=${repositoryId}&repositoryId=${repositoryId}`, `/api/tasks?repositoryId=${repositoryId}&path=C%3A%5Csecret`]) {
      expect((await GET(same(path))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers an unavailable board without task content when the monitor fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("PRIVATE_PATH"));
    const response = await GET(same());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ version: 1, readiness: "unavailable", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null } });
  });
});
