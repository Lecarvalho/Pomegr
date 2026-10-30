import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CommandTableSection, SettingsRailSection } from "../../app/components/design-system/DesignSystemLayoutSamples";
import { forbidNetwork, sectionOf } from "./design-system-helpers";

// The Command table (sorting, groups, pages, empty states) and the Settings tab rail.
describe("Design-system reference page, tables and settings", () => {
  forbidNetwork();

  it("renders the shipped command table: sortable headers, groups, pages and empty states", async () => {
    const user = userEvent.setup();
    render(<CommandTableSection />);
    const tableSection = sectionOf("Command table");
    const sampleTable = within(tableSection).getByRole("table", { name: "Sample sessions" });
    const agentsHeader = within(sampleTable).getByRole("columnheader", { name: "Agents" });
    expect(agentsHeader).not.toHaveAttribute("aria-sort");
    expect(within(sampleTable).getByRole("columnheader", { name: "Status" })).not.toHaveClass("commandTableSortable");
    const groupedTable = within(tableSection).getByRole("table", { name: "Grouped sample sessions" });
    expect(within(groupedTable).getByRole("button", { name: /^pomegr/ })).toHaveClass("commandQuietAction", "commandSessionGroupToggle");
    expect(within(groupedTable).getByRole("button", { name: /^catalogus/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(groupedTable).getByRole("button", { name: "Show all 7 in pomegr" })).toHaveClass("commandTextLink");
    await user.click(within(agentsHeader).getByRole("button"));
    expect(agentsHeader).toHaveAttribute("aria-sort", "descending");
    await user.click(within(agentsHeader).getByRole("button"));
    expect(agentsHeader).toHaveAttribute("aria-sort", "ascending");
    const pages = within(tableSection).getByRole("navigation", { name: "Sample session pages" });
    expect(within(pages).getByText("Showing 1–4 of 9")).toBeInTheDocument();
    await user.click(within(pages).getByRole("button", { name: "Next" }));
    expect(within(pages).getByText("Showing 5–8 of 9")).toBeInTheDocument();
    expect(within(pages).getByRole("button", { name: "Go to page 2" })).toHaveAttribute("aria-current", "page");
    expect(within(pages).getByRole("button", { name: "Next" })).toHaveClass("commandSecondaryAction");
    expect(within(tableSection).getByText("No rows to display.")).toHaveClass("commandUnavailableNote");
    expect(within(tableSection).getByRole("heading", { name: "No sessions match these filters" })).toBeInTheDocument();
  });

  it("renders the Settings tab rail with its pane, and switches the pane with the tab", async () => {
    const user = userEvent.setup();
    render(<SettingsRailSection />);
    const railSection = sectionOf("Settings tab rail");
    expect(within(railSection).getByRole("tab", { name: "Appearance", selected: true })).toBeInTheDocument();
    await user.click(within(railSection).getByRole("tab", { name: "Storage" }));
    expect(within(railSection).getByRole("tab", { name: "Storage", selected: true })).toHaveClass("active");
    expect(within(railSection).getByRole("tabpanel")).toHaveTextContent(/Retention and cleanup threshold/);
  });
});
