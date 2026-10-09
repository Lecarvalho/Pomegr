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
    features: [], tasks: [task()], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] }, ...overrides,
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
    ["a column role outside the fixed list", () => json({ ...board(), columns: [{ id: "col-1", name: "Backlog", position: 0, role: "ready" }] })],
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
  it("keeps valid Codex run models, drops invalid ones, and treats a missing field as empty", () => {
    const older: Partial<TaskBoard> = board();
    delete older.runModels;
    expect(parseTaskBoard(older, repositoryId)?.runModels).toEqual({ codex: [] });
    const rows = [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6.1-sol", label: null }, { id: "../x", label: null }, { id: "gpt-5.2", label: "bad\nlabel" }, { id: 7 }];
    expect(parseTaskBoard({ ...board(), runModels: { codex: rows } }, repositoryId)?.runModels).toEqual({ codex: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-5.2", label: null }] });
  });

  it("keeps a valid ready board with its session and report", () => {
    const parsed = parseTaskBoard(board({ tasks: [task({ session: { id: "claude:1", title: "Fix parser", state: "working", observedModel: "opus" }, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open", passed: false }], blockReason: null } })] }), repositoryId);
    expect(parsed?.tasks[0].session?.title).toBe("Fix parser");
    expect(parsed?.queue).toEqual({ status: "idle", blockedBy: null, pauseReason: null, order: [] });
  });

  it("keeps the queue start order and rejects a malformed one like any malformed board", () => {
    const queue = (order: unknown) => ({ status: "idle", blockedBy: null, pauseReason: null, order });
    expect(parseTaskBoard(board({ queue: queue(["T-2", "T-1"]) as TaskBoard["queue"] }), repositoryId)?.queue.order).toEqual(["T-2", "T-1"]);
    for (const order of [undefined, "T-1", [1], ["task-1"], ["T-0"], [{ id: "T-1" }], Array.from({ length: 501 }, (_, index) => `T-${index + 1}`)]) {
      expect(parseTaskBoard(board({ queue: queue(order) as TaskBoard["queue"] }), repositoryId)).toBeNull();
    }
  });

  it("keeps the start gates and the schedule whole, and drops either one when a value is outside the contract", () => {
    const gates = {
      threshold: 85,
      usage: { claude: { status: "ok", fiveHourPercent: 62, sevenDayPercent: 31 }, codex: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null } },
      providerStatus: { claude: "ok", codex: "incident" }, workingTree: "clean",
      next: { taskId: "T-2", provider: "claude", blockedBy: null, reasons: ["usage_over", "after_queue_stop"] },
    };
    const schedule = { startAt: null, stopAfter: "2026-10-09T07:00:00.000Z" };
    const queue = (extra: object) => board({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-2"], ...extra } as TaskBoard["queue"] });
    expect(parseTaskBoard(queue({ gates: { ...gates, root: "C:/repo" }, schedule: { ...schedule, zone: "x" } }), repositoryId)?.queue)
      .toEqual({ status: "running", blockedBy: null, pauseReason: null, order: ["T-2"], schedule, gates });
    expect(parseTaskBoard(queue({ gates: { ...gates, next: null } }), repositoryId)?.queue.gates?.next).toBeNull();
    for (const broken of [{ ...gates, threshold: 80 }, { ...gates, workingTree: "C:/repo" }, { ...gates, usage: { ...gates.usage, codex: { status: "ok", fiveHourPercent: 140, sevenDayPercent: 1 } } },
      { ...gates, providerStatus: { claude: "ok" } }, { ...gates, next: { ...gates.next, reasons: ["spawn ENOENT"] } }, { ...gates, next: { ...gates.next, taskId: "task" } }, "ok", null]) {
      const parsed = parseTaskBoard(queue({ gates: broken }), repositoryId);
      expect(parsed?.readiness).toBe("ready");
      expect(parsed?.queue.gates).toBeUndefined();
    }
    for (const broken of [{ startAt: null, stopAfter: null }, { startAt: "soon", stopAfter: null }, { startAt: 5, stopAfter: null }, { stopAfter: "2026-10-09T07:00:00.000Z" }, "07:00", null]) {
      const parsed = parseTaskBoard(queue({ schedule: broken }), repositoryId);
      expect(parsed?.readiness).toBe("ready");
      expect(parsed?.queue.schedule).toBeUndefined();
    }
  });

  it("keeps one fixed pause reason on a paused queue and reads anything else as none", () => {
    const queue = (status: string, pauseReason: unknown) => board({ queue: { status, blockedBy: "T-2", pauseReason, order: ["T-2"] } as TaskBoard["queue"] });
    for (const reason of ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked"]) {
      expect(parseTaskBoard(queue("paused", reason), repositoryId)?.queue).toEqual({ status: "paused", blockedBy: "T-2", pauseReason: reason, order: ["T-2"] });
    }
    for (const reason of ["C:/Users/me/claude.exe", "spawn ENOENT", 7, null, undefined]) {
      expect(parseTaskBoard(queue("paused", reason), repositoryId)?.queue.pauseReason).toBeNull();
    }
    expect(parseTaskBoard(queue("running", "start_failed"), repositoryId)?.queue.pauseReason).toBeNull();
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
      expect(await response.json()).toEqual({ version: 1, readiness: "desktop_only", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] } });
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
    expect(await response.json()).toEqual({ version: 1, readiness: "unavailable", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] } });
  });
});
