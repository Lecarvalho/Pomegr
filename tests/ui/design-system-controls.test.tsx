import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ButtonsSection, ChipsSection, FormFieldsSection, PanelsSection } from "../../app/components/design-system/DesignSystemControlSamples";
import { StorageUsageSection, TypographySection } from "../../app/components/design-system/DesignSystemShellSamples";
import { forbidNetwork } from "./design-system-helpers";

const ROLE_HEADINGS = ["Primary", "Secondary", "Segmented", "Quiet", "Text link", "Icon"];

// The controls the whole application shares: button roles, form fields, chips and pills, panels, and the tokens.
describe("Design-system reference page, controls", () => {
  forbidNetwork();

  it("draws the six button roles and the split action from the real shared classes", () => {
    render(<ButtonsSection />);
    const buttons = screen.getByRole("region", { name: "Buttons" });
    for (const name of ROLE_HEADINGS) {
      const role = within(buttons).getByRole("article", { name: new RegExp(`^${name}\\b`) });
      expect(within(role).getByText("Default")).toBeInTheDocument();
      expect(within(role).getByText("Disabled")).toBeInTheDocument();
      // Hover and focus are the same control as Default; the Default note describes them.
      expect(within(role).queryByText("Hover")).toBeNull();
      expect(within(role).queryByText("Focus")).toBeNull();
    }
    expect(within(buttons).getAllByRole("button", { name: "Install plugin" })[0]).toHaveClass("commandPrimaryAction");
    expect(within(buttons).getAllByRole("button", { name: "Copy" })[0]).toHaveClass("commandSecondaryAction");
    expect(within(buttons).getAllByRole("button", { name: "Fresh tokens" })[0].parentElement).toHaveClass("commandSegmented");
    expect(within(buttons).getAllByRole("button", { name: "Download report" })[0]).toHaveClass("commandQuietAction");
    expect(within(buttons).getAllByRole("button", { name: "Show 20" })[0]).toHaveClass("commandTextLink");
    expect(within(buttons).getAllByRole("button", { name: "Copy transcript path" })[0]).toHaveClass("commandIconAction");
    expect(within(buttons).getAllByRole("button", { name: "Install plugin" }).some((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(within(buttons).getAllByRole("button", { name: "Full breakdown", pressed: true }).length).toBeGreaterThan(0);
    expect(within(buttons).getByText(/44px/)).toBeInTheDocument();
    expect(within(buttons).getByRole("button", { name: "More ways to create" })).toBeEnabled();
    expect(within(buttons).getByRole("button", { name: "More ways to create, disabled" })).toBeDisabled();
  });

  it("draws the form fields and the chips: selects, provider badges, status pills and filter chips", () => {
    render(<><FormFieldsSection /><ChipsSection /></>);
    expect(screen.getByRole("combobox", { name: "Sample scope" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sample scope, disabled" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Filter sample rows" })).toBeInTheDocument();
    expect(screen.getAllByText("Claude Code").find((element) => element.classList.contains("providerBadge"))).toBeDefined();
    expect(screen.getAllByText("Codex").find((element) => element.classList.contains("providerBadge"))).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Chips and pills" })).getByText("needs input")).toHaveClass("statusPill", "needs_input");
    expect(screen.getByRole("button", { name: /Live/, pressed: true })).toHaveClass("commandFilterChip");
  });

  it("draws the panels, the session totals strip and the tokens, with a storage bar for each reading", () => {
    render(<><PanelsSection /><StorageUsageSection /><TypographySection /></>);
    expect(screen.getByRole("region", { name: "Sample session totals" })).toHaveClass("sessionKpiStrip");
    expect(screen.getByRole("region", { name: "Sample panel" })).toHaveClass("panel");
    expect(screen.getByText("--color-brand-fill")).toBeInTheDocument();
    expect(screen.getByText("--space-4")).toBeInTheDocument();
    expect(screen.getAllByRole("meter").length).toBeGreaterThanOrEqual(2);
  });
});
