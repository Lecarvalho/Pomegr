import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { TaskBoard } from "../../shared/task-contract";
import { readDesktopTaskLog, type TaskLog } from "../../app/components/tasks/task-desktop";
import { ScorecardSection } from "../../app/components/design-system/DesignSystemScorecardSample";
import { TaskLogPanel } from "../../app/components/tasks/TaskLogPanel";
import { scheduleLabel, timeOfDay } from "../../app/components/tasks/task-schedule";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
const taskAction = vi.fn(async () => ({ ok: true }));
const taskLog = vi.fn<(repositoryId: string) => Promise<unknown>>();
const labels = ["Started", "Assigned to a session", "Reported complete", "Blocked", "Requeued", "Marked done", "Session ended without a report", "Session working again", "CI passed", "CI failed", "Merged"];
const kinds: TaskLog["entries"][number]["kind"][] = ["started", "assigned", "review", "blocked", "requeued", "done", "stalled", "recovered", "checks_passed", "checks_failed", "merged"];
const log = (): TaskLog => ({ entries: kinds.map((kind, i) => ({ id: i + 1, task: `T-${i + 1}`, kind, at: new Date(2026, 9, 23, 8, i).getTime(), pullRequest: i === 10 ? 42 : null })), more: false, arilCursor: 6 });
const setBridge = (bridge: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; };
beforeEach(() => {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh: vi.fn(async () => {}) }); setBridge({ taskAction, taskLog });
});
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });
const show = (value = log()) => render(<TaskLogPanel read={{ state: "ready", log: value }} onClose={() => {}} titleId="log-title" />);

it("shows newest entries first with every fixed label, PR suffix, local times and the Aril divider", () => {
  const value = log(); value.entries[10].at = Date.now();
  show(value);
  const list = screen.getByRole("list", { name: "Task log entries" });
  expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    ...value.entries.toReversed().slice(0, 6).map((entry) => `${entry.id === 11 ? timeOfDay(new Date(entry.at).toISOString()) : scheduleLabel(new Date(entry.at).toISOString())}${entry.task}${labels[entry.id - 1]}${entry.pullRequest ? `PR #${entry.pullRequest}` : ""}`),
    "Aril has read up to here",
    ...value.entries.toReversed().slice(6).map((entry) => `${scheduleLabel(new Date(entry.at).toISOString())}${entry.task}${labels[entry.id - 1]}`),
  ]);
  expect(screen.getByText("The task log stays on this computer.")).toBeInTheDocument();
});

it.each([0, 11])("omits the divider when cursor %s leaves no mixed read state", (arilCursor) => {
  show({ ...log(), arilCursor }); expect(screen.queryByText("Aril has read up to here")).toBeNull();
});
it("shows empty and more captions", () => {
  const { rerender } = show({ entries: [], more: false, arilCursor: 0 });
  expect(screen.getByText("Nothing logged yet.")).toBeInTheDocument();
  expect(screen.queryByText("Showing the newest 200 entries.")).toBeNull();
  rerender(<TaskLogPanel read={{ state: "ready", log: { ...log(), more: true } }} onClose={() => {}} titleId="log-title" />);
  expect(screen.getByText("Showing the newest 200 entries.")).toBeInTheDocument();
});
it("hides Log without the desktop bridge and during server rendering", () => {
  expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toContain(">Log<");
  setBridge({ taskAction }); render(<TaskBoardPane repositoryId={repositoryId} />);
  expect(screen.queryByRole("button", { name: "Log" })).toBeNull(); expect(taskLog).not.toHaveBeenCalled();
});
it("reads once on open, returns focus to Log, and reads again on reopening", async () => {
  let answer: (value: unknown) => void = () => {};
  taskLog.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; })).mockResolvedValueOnce({ ok: true, log: log() });
  setBridge({ taskAction, taskLog, taskScorecard: vi.fn() });
  const user = userEvent.setup(); render(<TaskBoardPane repositoryId={repositoryId} />);
  const opener = screen.getByRole("button", { name: "Log" });
  expect(opener).toHaveAttribute("aria-haspopup", "dialog");
  expect(opener.nextElementSibling).toHaveTextContent("Scorecard"); expect(taskLog).not.toHaveBeenCalled();
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Task log" });
  expect(within(dialog).getByText("Reading the task log…")).toBeInTheDocument();
  answer({ ok: true, log: log() }); await waitFor(() => expect(within(dialog).getByText("PR #42")).toBeInTheDocument());
  expect(taskLog).toHaveBeenCalledExactlyOnceWith(repositoryId);
  await user.click(within(dialog).getByRole("button", { name: "Close" })); expect(opener).toHaveFocus();
  await user.click(opener); await screen.findByText("PR #42"); expect(taskLog).toHaveBeenCalledTimes(2);
  await user.keyboard("{Escape}"); expect(opener).toHaveFocus();
});
it.each([{ ok: false }, { ok: true, log: { ...log(), arilCursor: -1 } }])("alerts on failed or malformed answers", async (answer) => {
  taskLog.mockResolvedValue(answer); const user = userEvent.setup(); render(<TaskBoardPane repositoryId={repositoryId} />);
  await user.click(screen.getByRole("button", { name: "Log" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The task log could not be read.");
});
it("strictly parses the renderer answer and strips extra fields", async () => {
  taskLog.mockResolvedValue({ ok: true, log: { ...log(), private: "hidden", entries: [{ ...log().entries[0], private: "hidden" }] } });
  expect(await readDesktopTaskLog(repositoryId)).toEqual({ ok: true, log: { ...log(), entries: [log().entries[0]] } });
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    (s) => { s.entries = Array(201).fill(log().entries[0]); }, (s) => { s.entries = null; }, (s) => { s.more = "true"; },
  ];
  for (const arilCursor of [-1, 0.5, undefined, Number.MAX_SAFE_INTEGER + 1]) mutations.push((s) => { s.arilCursor = arilCursor; });
  for (const [field, values] of Object.entries({ id: [0, 1.5], task: ["T-0", "T-01", null], kind: ["toString", "unknown", ["started"]], at: [NaN, 1.5], pullRequest: [undefined, 0, 1.5] })) {
    for (const value of values) mutations.push((s) => { s.entries = [{ ...log().entries[0], [field]: value }]; });
  }
  for (const mutate of mutations) { const value = { ...log() }; mutate(value); taskLog.mockResolvedValue({ ok: true, log: value }); expect(await readDesktopTaskLog(repositoryId)).toEqual({ ok: false }); }
  taskLog.mockRejectedValue(new Error("private")); expect(await readDesktopTaskLog(repositoryId)).toEqual({ ok: false });
});

it("renders the desktop Log action and each task log state from synthetic samples", () => {
  const { container } = render(<ScorecardSection />);
  for (const label of ["Task log, entries", "Task log, empty", "Task log, reading", "Task log, failed", "Task log, more"]) expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: "Log" })) {
    expect(button).toHaveClass("commandQuietAction", "taskQueueSettingsAction");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button.nextElementSibling).toHaveTextContent("Scorecard");
  }
  expect(screen.getAllByText("Aril has read up to here").length).toBeGreaterThan(0);
  expect(screen.getByText("Nothing logged yet.")).toBeInTheDocument();
  expect(screen.getByText("Reading the task log…")).toBeInTheDocument();
  expect(screen.getByText("The task log could not be read.")).toHaveAttribute("role", "alert");
  expect(screen.getByText("Showing the newest 200 entries.")).toBeInTheDocument();
  expect(container.querySelector(".taskLogList .isError, .taskLogList .isPositive")).toBeNull();
});
