import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { claudeCapabilities, agent, repositorySession } from "./dashboard-test-fixtures";

describe("reported signal tooltips", () => {
  it("shows a session signal description on desktop hover", async () => {
    const user = userEvent.setup();
    const signaledSession = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      signal: {
        label: "Review complete",
        tone: "positive" as const,
        reportedAt: "2026-08-08T12:00:05.000Z",
        description: "All requested checks passed.",
      },
    };

    render(<LiveClockProvider running={false}><SessionHero session={signaledSession} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    const trigger = screen.getByRole("button", { name: "Review complete" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(screen.getByRole("tooltip")).toHaveClass("tooltipPopover", "signalTooltip");
    expect(screen.getByRole("tooltip")).toHaveTextContent("All requested checks passed.");
    await user.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("toggles an agent signal description on touch and dismisses it", () => {
    const signaledAgent = {
      ...agent,
      signal: {
        label: "Approved",
        tone: "positive" as const,
        reportedAt: "2026-08-08T12:00:05.000Z",
        description: "All requested checks passed.",
      },
    };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[signaledAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const trigger = screen.getByRole("button", { name: "Approved" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("All requested checks passed.");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
