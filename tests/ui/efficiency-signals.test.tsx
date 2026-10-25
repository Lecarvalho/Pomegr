import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SignalsEfficiencySection } from "../../app/components/dashboard/signals/SignalsEfficiencySection";

describe("efficiency signal semantics", () => {
  it("keeps agent actions centered and content-width on phone", () => {
    const styles = readFileSync(join(process.cwd(), "app/components/dashboard/SignalsTab.module.css"), "utf8");
    expect(styles).toMatch(/:global\(\.signalsInsight\) > :global\(\.commandQuietAction\)\s*\{[^}]*flex:\s*0 0 auto;[^}]*align-self:\s*center;/);
    expect(styles).toMatch(/@media \(max-width: 760px\)\s*\{\s*:global\(\.signalsInsight\) > :global\(\.commandQuietAction\)\s*\{\s*width:\s*auto;/);
  });

  it("labels efficiency signals as deterministic attention evidence and only navigates normalized agents", () => {
    const onNavigateAgent = vi.fn();
    render(<SignalsEfficiencySection
      insights={[{ id: "signal", level: "warning", title: "Repeated reads", detail: "Same target.", agentId: "primary" }, { id: "unscoped", level: "info", title: "Context changed", detail: "Recorded." }]}
      readiness="ready"
      onNavigateAgent={onNavigateAgent}
    />);

    expect(screen.queryByText(/flow score/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not a quality assessment/i)).not.toHaveLength(0);
    const showAgent = screen.getByRole("button", { name: "Show agent" });
    expect(showAgent).toHaveClass("commandQuietAction");
    expect(showAgent).not.toHaveClass("commandTextLink");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    showAgent.click();
    expect(onNavigateAgent).toHaveBeenCalledWith("primary");
  });
});
