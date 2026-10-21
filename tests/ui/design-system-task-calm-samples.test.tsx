import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return { ...actual, useClientAccess: () => ({ mode: "unknown", canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});

import { DesignSystemView } from "../../app/components/design-system/DesignSystemView";

const sectionOf = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
const sample = (root: HTMLElement, label: string) => within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;

// The calm task modal and board: the parts the reference page must show next to the states they belong to.
describe("the design-system samples of the calm task modal and board", { timeout: 20_000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws a promoted card with an attention chip in the narrowest lane, with the chip wrapped to a second line", () => {
    render(<DesignSystemView />);
    const card = sample(sectionOf("Task cards and board"), "From a GitHub issue, needs attention");
    expect(card.querySelector(".designSystemNarrowLane")).not.toBeNull();
    expect(card.querySelector(".taskCard")).toHaveClass("isAttention");
    const top = card.querySelector(".taskCardTop") as HTMLElement;
    expect(top.querySelector(".taskIssueChip")).toHaveTextContent("#142");
    expect(top.querySelector(".taskCardChip")).toHaveTextContent("Blocked by agent");
  });

  it("draws the Agent report panel of a done task, the read view with an inline image, and the Observed model differs notice in the Run on row", () => {
    render(<DesignSystemView />);
    const fields = sectionOf("Task fields");
    const done = sample(fields, "Review panel, done with a report");
    expect(within(done).getByRole("heading", { level: 3, name: "Agent report" })).toBeInTheDocument();
    expect(within(done).getAllByText("Passed").length).toBeGreaterThan(0);
    const read = sample(fields, "Task, read view, inline image");
    expect(read.querySelector(".taskRead .taskInlineImage")).toHaveAttribute("alt", "Image 1");
    const settings = sample(fields, "Run settings, observed model differs");
    const runOn = [...settings.querySelectorAll("dt")].find((term) => term.textContent === "Run on")?.closest(".taskRow") as HTMLElement;
    expect(within(runOn).getByText("Observed model differs")).toBeInTheDocument();
    expect(within(runOn).getByText("model-small", { selector: "code" })).toBeInTheDocument();
  });
});
