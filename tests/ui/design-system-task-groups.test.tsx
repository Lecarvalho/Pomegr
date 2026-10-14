import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return { ...actual, useClientAccess: () => ({ mode: "unknown", canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});

import { DesignSystemView } from "../../app/components/design-system/DesignSystemView";

const sectionOf = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
const sample = (root: HTMLElement, label: string) => within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;

// The reference page draws the parallel-group pieces from the shipped components; the samples keep the surface page honest.
describe("the design-system samples of the Ready lane's parallel groups", { timeout: 20_000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws the group frame, its caption and its compact cards, with no step text", () => {
    render(<DesignSystemView />);
    const lane = sample(sectionOf("Task cards and board"), "Ready lane, parallel group");
    const group = lane.querySelector(".taskReadyGroup") as HTMLElement;
    expect(group.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 2");
    expect(group.querySelector(".taskReadyActions")).toBeNull();
    expect([...group.querySelectorAll("li.taskReadyCard")].map((card) => card.getAttribute("data-task-id"))).toEqual(["T-2", "T-3"]);
    expect(lane.querySelector(".taskReadyLink")).toBeNull();
    expect(lane.textContent).not.toMatch(/Step|One at a time|Single tasks/);
  });

  it("draws the whole-group actions and Run in parallel in the desktop lane", () => {
    render(<DesignSystemView />);
    const lane = sample(sectionOf("Task cards and board"), "Ready lane, desktop app");
    const toolbar = within(lane).getByRole("toolbar", { name: "Parallel group of T-2 and T-3" });
    expect([...toolbar.querySelectorAll("[data-group-move]")].map((arrow) => arrow.getAttribute("data-group-move"))).toEqual(["up", "down"]);
    expect(within(toolbar).getByRole("button", { name: "Ungroup" })).toHaveClass("commandQuietAction", "taskReadyUngroup");
    expect(lane.querySelector(".designSystemRevealLink .taskReadyLink .taskReadyLinkAction")).toHaveTextContent("Run in parallel");
  });

  it("draws the join target on the group and no drop line", () => {
    render(<DesignSystemView />);
    const lane = sample(sectionOf("Task cards and board"), "Ready lane, join target");
    expect(lane.querySelector(".taskReadyGroup")).toHaveClass("isJoinTarget");
    expect(lane.querySelector(".isDropBefore, .isDropAfter")).toBeNull();
  });

  it("draws a held member: one card waiting, its sibling started", () => {
    render(<DesignSystemView />);
    const lane = sample(sectionOf("Task cards and board"), "Ready lane, a member held");
    expect(lane.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 1 · T-3 started");
    expect(lane.querySelector('[data-task-id="T-2"] .taskCardWaiting')?.textContent).toMatch(/ · T-3 started$/);
  });

  it("draws Take out of group on a waiting member's card, and a feature line of the name only", () => {
    render(<DesignSystemView />);
    const board = sectionOf("Task cards and board");
    expect(within(sample(board, "Card, desktop app, in a parallel group")).getByRole("button", { name: "Take T-3 out of its parallel group" })).toHaveClass("commandQuietAction", "taskMoveLeave");
    expect(sample(board, "Card outside Ready, feature line").querySelector(".taskCardFeature")?.textContent).toBe("Upload reliability");
  });
});
