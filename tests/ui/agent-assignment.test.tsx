import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

describe("agent assignment hierarchy", () => {
  it("shows the assignment first and preserves the codename as secondary identity", async () => {
    const user = userEvent.setup();
    const assignedAgent: Agent = {
      ...agent,
      id: "agent-erdos",
      parentId: "primary",
      assignment: "Trace cli title",
      label: "Erdos",
      role: "explore",
    };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[assignedAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const group = screen.getByRole("button", { name: /Direct subagents/ });
    if (group.getAttribute("aria-expanded") === "false") await user.click(group);
    const row = screen.getByRole("row", { name: "Trace cli title — Erdos agent, cache TTL 1h" });
    expect(within(row).getByRole("button", { name: "Select Trace cli title" })).toHaveTextContent("Trace cli title");
    expect(row).toHaveTextContent("Erdos");
    expect(row).toHaveTextContent("explore");
  });

  it("does not repeat an assignment that matches the codename", () => {
    const duplicateAgent: Agent = { ...agent, assignment: "Primary agent" };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[duplicateAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const row = screen.getByRole("row", { name: "Primary agent agent, cache TTL 1h" });
    expect(within(row).getAllByText("Primary agent")).toHaveLength(1);
    expect(within(row).queryByText("Primary agent", { selector: ".rosterMetaIdentity" })).not.toBeInTheDocument();
  });
});
