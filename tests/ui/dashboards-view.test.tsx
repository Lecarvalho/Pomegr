import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DashboardsView } from "../../app/components/command-center/CommandViews";

function titles() {
  return within(screen.getByRole("table", { name: "Built-in dashboards" })).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
}

describe("Dashboards view", () => {
  it("uses the shared table and keeps all destinations and the preview available", () => {
    const view = render(<DashboardsView />);
    const table = screen.getByRole("table", { name: "Built-in dashboards" });
    expect(table).toHaveClass("commandTable", "commandDashboardTable");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
    for (const [title, href] of [["Session overview", "/sessions"], ["Agent operations", "/agents"], ["Usage & cache evidence", "/usage-limits"], ["Repository activity", "/repositories"]]) {
      expect(within(table).getByRole("link", { name: "Open " + title })).toHaveAttribute("href", href);
    }
    expect(within(table).getAllByText("Live data")).toHaveLength(4);
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open sessions" })).toHaveAttribute("href", "/sessions");
    expect(screen.getByRole("button", { name: "Create dashboard" })).toBeDisabled();
    expect(view.container.querySelector(".commandDashboardRow")).toBeNull();
  });

  it("preserves search and empty-state behavior without sorting controls", async () => {
    const user = userEvent.setup();
    render(<DashboardsView />);
    const originalOrder = titles();
    await user.click(screen.getByRole("columnheader", { name: "Dashboard" }));
    expect(titles()).toEqual(originalOrder);
    const search = screen.getByRole("searchbox", { name: "Find a dashboard" });
    await user.type(search, "account");
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toMatch(/^Usage & cache evidence/);
    expect(screen.getByText("1 dashboards")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "no matching dashboard");
    expect(screen.getByRole("heading", { name: "No dashboards match" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await user.clear(search);
    expect(titles()).toEqual(originalOrder);
    expect(within(screen.getByRole("table")).queryByRole("button")).not.toBeInTheDocument();
  });
});
