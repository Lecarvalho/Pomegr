import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignalsEfficiencySection } from "../../app/components/dashboard/signals/SignalsEfficiencySection";

describe("efficiency signal semantics", () => {
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
});
