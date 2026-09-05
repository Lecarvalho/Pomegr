import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Workflow } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent as primaryAgent } from "./dashboard-test-fixtures";

const sessionId = "grid-test";

const workflow = (id: string, name: string, agentIds: string[]): Workflow => ({
  id,
  name,
  status: "running",
  metadataStatus: "ready",
  summary: null,
  startedAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:10:00.000Z",
  durationMs: 60_000,
  agentIds,
  phases: [{ id: `${id}-phase`, label: "Implement", agentIds }],
});

function makeAgent(id: string, index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    ...primaryAgent,
    id,
    label: id,
    parentId: "primary",
    workflowId: null,
    workflowPhaseId: null,
    workflowOrder: index,
    status: "idle",
    toolCalls: 10 + index,
    durationMs: (index + 1) * 1_000,
    tokens: { ...primaryAgent.tokens, total: (index + 1) * 100 },
    ...overrides,
  };
}

function gridFixture() {
  const primary = { ...primaryAgent, tokens: { ...primaryAgent.tokens, total: 100 }, toolCalls: 5, durationMs: 1_000 };
  const direct = Array.from({ length: 16 }, (_, index) => makeAgent(`Direct worker ${index + 1}`, index, { status: index === 0 ? "active" : "idle" }));
  const build = Array.from({ length: 16 }, (_, index) => makeAgent(`Build worker ${index + 1}`, index, {
    workflowId: "build",
    workflowPhaseId: "build-phase",
    status: index === 0 ? "active" : index === 1 ? "finished" : "idle",
    tokens: { ...primaryAgent.tokens, total: index === 0 ? 400 : 100 + index * 10 },
    durationMs: index === 0 ? 5_000 : (index + 1) * 1_000,
    toolCalls: index === 0 ? 20 : 10 + index,
  }));
  const verification = Array.from({ length: 16 }, (_, index) => makeAgent(`Verification worker ${index + 1}`, index, {
    workflowId: "verification",
    workflowPhaseId: "verification-phase",
  }));
  verification[0] = makeAgent("Hidden maximum", 0, {
    workflowId: "verification",
    workflowPhaseId: "verification-phase",
    status: "stopped",
    tokens: { ...primaryAgent.tokens, total: 1_600 },
    durationMs: 100_000,
    toolCalls: 100,
  });
  verification[1] = makeAgent("Zero worker", 1, {
    workflowId: "verification",
    workflowPhaseId: "verification-phase",
    status: "unknown",
    tokens: { ...primaryAgent.tokens, total: 0 },
    durationMs: 0,
    toolCalls: 0,
  });
  const agents = [primary, ...direct, ...build, ...verification];
  const workflows = [
    workflow("build", "Build", build.map((item) => item.id)),
    workflow("verification", "Verification", verification.map((item) => item.id)),
  ];
  return { agents, workflows };
}

function panel(props: Partial<React.ComponentProps<typeof AgentActivityPanel>> = {}) {
  const { agents, workflows } = gridFixture();
  return <LiveClockProvider running={false}>
    <AgentActivityPanel
      agents={agents}
      workflows={workflows}
      executionTasks={[]}
      planTasks={[]}
      insights={[{ id: "warning", level: "warning", title: "Repeated work", detail: "Check progress", agentId: "Build worker 1" }]}
      historical
      sessionId={sessionId}
      viewMode="grid"
      {...props}
    />
  </LiveClockProvider>;
}

function tile(name: string) {
  return screen.getByRole("button", { name: `Select ${name}` });
}

function bar(name: string) {
  const element = tile(name).querySelector<HTMLElement>(".agentGridBar");
  expect(element).toBeTruthy();
  return element!;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("agent grid view", () => {
  it("renders every observed agent as a native, labelled tile and keeps status, warning, selection, and metric in the tile contract", () => {
    const { agents } = gridFixture();
    render(panel());
    const tiles = screen.getAllByRole("button", { name: /^Select / });
    expect(tiles).toHaveLength(49);
    for (const agent of agents) {
      const current = tile(agent.label);
      expect(current.tagName).toBe("BUTTON");
      expect(current).toHaveAttribute("type", "button");
      expect(current).toHaveAttribute("aria-pressed");
      expect(current).toHaveClass("agentGridTile", `agentGridStatus-${agent.status}`);
      expect(current).toHaveAttribute("title", expect.stringContaining(agent.label));
      expect(current).toHaveAttribute("title", expect.stringMatching(new RegExp(agent.status, "i")));
      expect(current).toHaveAttribute("title", expect.stringMatching(/context/i));
    }
    expect(tile("Build worker 1")).toHaveClass("agentGridWarning");
    expect(tile("Primary agent")).toHaveClass("agentGridSelected");
  });

  it("selects a tile with a pointer or keyboard and updates the desktop inspector", async () => {
    const user = userEvent.setup();
    render(panel());
    const selected = tile("Build worker 1");
    await user.click(selected);
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveClass("agentGridSelected");
    expect(screen.getByRole("region", { name: "Agent inspector for Build worker 1" })).toBeInTheDocument();

    const enterTarget = tile("Build worker 2");
    enterTarget.focus();
    await user.keyboard("{Enter}");
    expect(enterTarget).toHaveAttribute("aria-pressed", "true");
    const spaceTarget = tile("Build worker 3");
    spaceTarget.focus();
    await user.keyboard(" ");
    expect(spaceTarget).toHaveAttribute("aria-pressed", "true");
  });

  it("omits filtered agents and lanes with no visible agents", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.clear(screen.getByRole("searchbox", { name: "Filter agents" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "Build worker");
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(16);
    const lanes = [...document.querySelectorAll<HTMLElement>(".agentGridLane")];
    expect(lanes.map((lane) => lane.getAttribute("aria-label"))).toEqual(["Build"]);
    expect(screen.queryByRole("button", { name: "Select Hidden maximum" })).not.toBeInTheDocument();
  });

  it("scales bars to the largest value in the full session for context, wall time, and calls", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "Build worker");
    expect(Number.parseFloat(bar("Build worker 1").style.width)).toBeCloseTo(25, 4);

    await user.click(screen.getByRole("button", { name: "Wall time" }));
    expect(Number.parseFloat(bar("Build worker 1").style.width)).toBeCloseTo(5, 4);
    await user.click(screen.getByRole("button", { name: "Tool calls" }));
    expect(Number.parseFloat(bar("Build worker 1").style.width)).toBeCloseTo(20, 4);

    await user.clear(screen.getByRole("searchbox", { name: "Filter agents" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "Zero worker");
    const zeroWidth = Number.parseFloat(bar("Zero worker").style.width);
    expect(Number.isFinite(zeroWidth)).toBe(true);
    expect(zeroWidth).toBe(0);
  });

  it("provides historical/live context labels and persists the selected tile metric per session", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel());
    const toolbar = screen.getByRole("group", { name: "Tile bar metric" });
    expect(within(toolbar).getByRole("button", { name: "Final context" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).getByRole("button", { name: "Wall time" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Tool calls" })).toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Tool calls" }));
    expect(window.localStorage.getItem(`pomegr-agent-grid-metric-${sessionId}`)).toBe("toolCalls");

    rerender(panel({ historical: false }));
    const liveToolbar = screen.getByRole("group", { name: "Tile bar metric" });
    expect(within(liveToolbar).getByRole("button", { name: "Latest context" })).toBeInTheDocument();
    expect(within(liveToolbar).getByRole("button", { name: "Tool calls" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the selected grid tile in the phone inspector sheet and returns focus on close", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(panel());
    const selected = tile("Build worker 1");
    await user.click(selected);
    const sheet = await screen.findByRole("dialog", { name: "Build worker 1" });
    expect(sheet).toBeInTheDocument();
    const close = within(sheet).getByRole("button", { name: "Back" });
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Build worker 1" })).not.toBeInTheDocument());
    expect(selected).toHaveFocus();
  });
});
