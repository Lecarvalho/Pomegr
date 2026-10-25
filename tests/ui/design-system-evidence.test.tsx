import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as agentSamples from "../../app/components/design-system/DesignSystemAgentSamples";
import * as repositorySamples from "../../app/components/design-system/DesignSystemRepositorySamples";

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

it("renders the inspector sheet frame inline without modal effects", async () => {
  const user = userEvent.setup();
  const { container } = render(<><button>Before sample</button><agentSamples.InspectorSheetSection /><button>After sample</button></>);
  const frame = container.querySelector(".designSystemInspectorSheetFrame") as HTMLElement;
  expect(frame).toHaveClass("agentInspectorSheet");
  expect(frame.querySelector(".inspectorSheetHeader strong")).toHaveTextContent("Review the chart diff");
  expect(frame.querySelector(".agentInspector-sheet")).not.toBeNull();
  expect(frame.querySelector(".inspectorFacts")).toHaveTextContent("small-model");
  expect(within(frame).getByRole("button", { name: "Back" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(container.inert).not.toBe(true);
  const after = screen.getByRole("button", { name: "After sample" });
  const last = within(frame).getByRole("button", { name: "Activities for this agent" });
  last.focus();
  await user.tab();
  expect(after).toHaveFocus();
}, 5_000);

it("renders revision evidence with fixed strings and the shipped allocation breakdown", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { container } = render(<repositorySamples.RevisionEvidenceSection />);
  expect(container.querySelectorAll(".repositoryOverviewFacts > div")).toHaveLength(4);
  expect(container.querySelectorAll(".repositoryOverviewCards > .repositoryOverviewCard")).toHaveLength(3);
  expect(container.querySelector(".repositoryInventorySummary")).toHaveTextContent("25 Oct 2026, 12:00 UTC");
  expect(container.querySelectorAll(".repositoryCategoryGrid > .repositoryCategory")).toHaveLength(3);
  for (const title of ["Loaded initially", "Deferred until needed", "Reserved capacity"]) {
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  }
  expect(screen.getByRole("img", { name: "12K loaded initially, 6,000 deferred until needed, and 2,000 reserved for automatic compaction" })).toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
}, 5_000);

it("keeps roster sample choices in memory without reading or writing localStorage", () => {
  window.localStorage.setItem("pomegr-agent-roster-selected-design-system-roster", "review");
  window.localStorage.setItem("pomegr-agent-roster-open-design-system-roster", '["direct"]');
  window.localStorage.setItem("pomegr-agent-activity-show-finished-design-system-roster", "false");
  window.localStorage.setItem("pomegr-agent-grid-metric-design-system-roster", "toolCalls");
  const read = vi.spyOn(Storage.prototype, "getItem");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const { container, unmount } = render(<agentSamples.AgentRosterSection />);
  expect(container.querySelector('.rosterPrimary')).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: /^Direct subagents/ })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "Select Focus tests" }));
  expect(screen.getByRole("region", { name: /Agent inspector for Focus tests/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Direct subagents/ }));
  fireEvent.click(screen.getByRole("button", { name: /Hide finished/ }));
  fireEvent.click(screen.getByRole("button", { name: "Grid" }));
  expect(screen.getByRole("button", { name: "Latest context", pressed: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Tool calls" }));
  unmount();
  render(<agentSamples.AgentRosterSection />);
  expect(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
}, 5_000);
