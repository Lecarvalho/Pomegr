import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { TaskBoard } from "../../shared/task-contract";
import { parseScorecard, scorecardRows, type Scorecard } from "../../app/components/tasks/scorecard-model";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
const HOUR = 3_600_000;
const taskAction = vi.fn(async () => ({ ok: true }));
const taskScorecard = vi.fn<(repositoryId: string) => Promise<unknown>>();

const measures = (turns: number | null, sample: number) => ({ ownerTurns: { value: turns, sample }, reviewToDoneMs: { value: turns === null ? null : 2 * HOUR, sample }, firstPass: { value: turns === null ? null : 0.75, sample } });
const LATER: Scorecard = {
  formula: 1,
  current: { version: "0.9.1", takenAt: Date.UTC(2026, 10, 2), measures: measures(1.5, 8) },
  baseline: { version: "0.9.0", takenAt: Date.UTC(2026, 9, 24), measures: measures(3, 4) },
};
const FIRST: Scorecard = { formula: 1, current: { version: "0.9.0", takenAt: Date.UTC(2026, 9, 24), measures: measures(null, 0) }, baseline: null };

function setBoard() {
  const board: TaskBoard = {
    version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
  };
  useTasks.mockReturnValue({ board, refresh: vi.fn(async () => {}) });
}
const setBridge = (bridge: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; };
const strip = () => screen.getByRole("region", { name: "Provider capacity" });

beforeEach(() => { setBoard(); setBridge({ taskAction, taskScorecard }); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

describe("Scorecard on the Tasks page", () => {
  it("draws no Scorecard action when the desktop bridge cannot read one, and none in the first render", () => {
    expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toContain(">Scorecard<");
    setBridge({ taskAction });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(within(strip()).queryByRole("button", { name: "Scorecard" })).toBeNull();
    expect(taskScorecard).not.toHaveBeenCalled();
  });

  it("reads nothing until Scorecard opens the panel, then reads once and shows each measure now and at the baseline", async () => {
    let answer: (value: unknown) => void = () => {};
    taskScorecard.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const action = within(strip()).getByRole("button", { name: "Scorecard" });
    expect(action).toHaveAttribute("aria-haspopup", "dialog");
    expect(taskScorecard).not.toHaveBeenCalled();
    await user.click(action);
    const dialog = screen.getByRole("dialog", { name: "Scorecard" });
    expect(within(dialog).getByText("Reading the scorecard…")).toBeInTheDocument();
    answer({ ok: true, scorecard: LATER });
    await waitFor(() => expect(within(dialog).getByText("1.5 turns")).toBeInTheDocument());
    expect(taskScorecard).toHaveBeenCalledTimes(1);
    expect(taskScorecard).toHaveBeenCalledWith(repositoryId);
    expect(within(dialog).getByText("3 turns")).toBeInTheDocument();
    expect(within(dialog).getAllByText("2 h")).toHaveLength(2);
    expect(within(dialog).getAllByText("75%")).toHaveLength(2);
    expect(within(dialog).getAllByText("n 8")).toHaveLength(3);
    expect(within(dialog).getByText(/The baseline is the first snapshot, saved .* in 0\.9\.0\. Scorecard values stay on this computer\./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Scorecard" })).toBeNull();
    expect(within(strip()).getByRole("button", { name: "Scorecard" })).toHaveFocus();
  });

  it("says No data, never 0, before any merged task, and names this version as the coming baseline", async () => {
    taskScorecard.mockResolvedValue({ ok: true, scorecard: FIRST });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(within(strip()).getByRole("button", { name: "Scorecard" }));
    const dialog = screen.getByRole("dialog", { name: "Scorecard" });
    await waitFor(() => expect(within(dialog).getAllByText("No data")).toHaveLength(3));
    expect(within(dialog).queryByText(/^0/)).toBeNull();
    expect(within(dialog).getByText(/This version's values become the baseline/)).toBeInTheDocument();
  });

  it("turns a failed or malformed answer into one alert, and reads again when reopened", async () => {
    taskScorecard.mockResolvedValueOnce({ ok: false, error: "unavailable" }).mockResolvedValueOnce({ ok: true, scorecard: { ...LATER, formula: "1" } });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(within(strip()).getByRole("button", { name: "Scorecard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The scorecard could not be read.");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(within(strip()).getByRole("button", { name: "Scorecard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The scorecard could not be read.");
    expect(taskScorecard).toHaveBeenCalledTimes(2);
  });
});

describe("parseScorecard", () => {
  it("accepts a well-formed answer, with or without a baseline", () => {
    expect(parseScorecard(LATER)).toEqual(LATER);
    expect(parseScorecard(FIRST)).toEqual(FIRST);
  });

  it("rejects any malformed part", () => {
    const broken = (patch: (card: Scorecard) => unknown) => parseScorecard(patch(structuredClone(LATER)));
    expect(parseScorecard(null)).toBeNull();
    expect(broken((card) => ({ ...card, baseline: undefined }))).toBeNull();
    expect(broken((card) => { card.current.version = ""; return card; })).toBeNull();
    expect(broken((card) => { card.current.version = "x".repeat(41); return card; })).toBeNull();
    expect(broken((card) => { card.current.measures.firstPass.value = 1.2; return card; })).toBeNull();
    expect(broken((card) => { card.current.measures.ownerTurns.sample = -1; return card; })).toBeNull();
    expect(broken((card) => { card.current.measures.ownerTurns.value = Number.NaN; return card; })).toBeNull();
    expect(broken((card) => { (card.baseline as Scorecard["current"]).takenAt = 1.5; return card; })).toBeNull();
  });

  it("lists S1 twice, then S2, then S3 to S7 with no value", () => {
    const rows = scorecardRows(LATER);
    expect(rows.map((row) => row.id)).toEqual(["S1", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
    expect(rows.slice(3).every((row) => row.now === null && row.baseline === null && row.pending)).toBe(true);
  });
});
