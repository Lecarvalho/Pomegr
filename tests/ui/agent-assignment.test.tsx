import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

describe("agent assignment hierarchy", () => {
  it("shows the assignment first and preserves the codename as secondary identity", () => {
    const assignedAgent: Agent = {
      ...agent,
      id: "agent-erdos",
      parentId: "primary",
      assignment: "Trace cli title",
      label: "Erdos",
      role: "explore",
    };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[assignedAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const row = screen.getByRole("listitem", { name: "Trace cli title — Erdos agent, cache TTL 1h" });
    expect(within(row).getByText("Trace cli title").tagName).toBe("STRONG");
    expect(within(row).getByText("Erdos")).toHaveClass("agentMetaIdentity");
    expect(within(row).getByText("explore")).toHaveClass("agentMetaKind");
  });

  it("does not repeat an assignment that matches the codename", () => {
    const duplicateAgent: Agent = { ...agent, assignment: "Primary agent" };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[duplicateAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    expect(screen.getAllByText("Primary agent")).toHaveLength(1);
    expect(document.querySelector(".agentMetaIdentity")).not.toBeInTheDocument();
  });
});
