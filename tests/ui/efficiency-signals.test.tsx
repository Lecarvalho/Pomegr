import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InsightsPanel } from "../../app/components/dashboard/InsightsPanel";
import { SignalsEfficiencySection } from "../../app/components/dashboard/signals/SignalsEfficiencySection";

describe("efficiency signal semantics", () => {
  it("uses a warning triangle instead of a positive check for warning signals", () => {
    const { container } = render(<InsightsPanel insights={[{
      id: "automatic-compaction-primary",
      level: "warning",
      title: "Primary agent context was automatically compacted",
      detail: "Earlier conversation detail was summarized.",
    }]} />);

    expect(container.querySelector(".insight.warning .insightWarningIcon")).toBeInTheDocument();
    expect(container.querySelector(".insight.warning .insightCheckIcon")).not.toBeInTheDocument();
  });

  it("labels Flow score as deterministic attention evidence and only navigates normalized agents", () => {
    const onNavigateAgent = vi.fn();
    render(<SignalsEfficiencySection
      insights={[{ id: "signal", level: "warning", title: "Repeated reads", detail: "Same target.", agentId: "primary" }, { id: "unscoped", level: "info", title: "Context changed", detail: "Recorded." }]}
      flowScore={{ score: 72, repeatedCalls: 3, overlappingTargets: 2 }}
      readiness="ready"
      onNavigateAgent={onNavigateAgent}
    />);

    expect(screen.getByText("Flow score")).toBeInTheDocument();
    expect(screen.getAllByText(/Not a quality assessment/i)).not.toHaveLength(0);
    screen.getByRole("button", { name: "Show agent" }).click();
    expect(onNavigateAgent).toHaveBeenCalledWith("primary");
  });

  it("uses an em dash and unavailable copy when activity evidence is unavailable", () => {
    render(<SignalsEfficiencySection insights={[]} flowScore={{ score: 0, repeatedCalls: null, overlappingTargets: null }} readiness="unavailable" onNavigateAgent={() => undefined} />);
    expect(screen.getByText("Activity evidence is unavailable for this session.")).toBeInTheDocument();
  });
});
