import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const clientAccess = vi.hoisted(() => ({ mode: "unknown" as "unknown" | "local" | "lan" }));

vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return { ...actual, useClientAccess: () => ({ mode: clientAccess.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});

import { DesignSystemView } from "../../app/components/design-system/DesignSystemView";
import DesignSystemPage from "../../app/design-system/page";

const ROLE_HEADINGS = ["Primary", "Secondary", "Segmented", "Quiet", "Text link", "Icon"];
const SECTION_HEADINGS = ["Buttons", "Form fields", "Chips and pills", "Panels and dividers", "Typography and tokens"];

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Design-system reference page", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network use is forbidden on the design-system page")));
  });

  afterEach(() => {
    clientAccess.mode = "unknown";
    delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("renders every control section from the real shared classes on the web without touching the network", () => {
    render(<DesignSystemPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Design system" })).toBeInTheDocument();
    for (const name of SECTION_HEADINGS) expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();

    const buttons = screen.getByRole("region", { name: "Buttons" });
    for (const name of ROLE_HEADINGS) {
      const role = within(buttons).getByRole("article", { name: new RegExp(`^${name}\\b`) });
      expect(within(role).getByText("Default")).toBeInTheDocument();
      expect(within(role).getByText("Hover")).toBeInTheDocument();
      expect(within(role).getByText("Disabled")).toBeInTheDocument();
      expect(within(role).getByText("Focus")).toBeInTheDocument();
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

    expect(screen.getByRole("combobox", { name: "Sample scope" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sample scope, disabled" })).toBeDisabled();
    expect(screen.getAllByText("Claude Code")[0]).toHaveClass("providerBadge");
    expect(screen.getAllByText("Codex")[0]).toHaveClass("providerBadge");
    expect(screen.getByText("needs input")).toHaveClass("statusPill", "needs_input");
    expect(screen.getByRole("button", { name: /Live/, pressed: true })).toHaveClass("commandFilterChip");
    expect(screen.getByRole("region", { name: "Sample session totals" })).toHaveClass("sessionKpiStrip");
    expect(screen.getByText("--color-brand-fill")).toBeInTheDocument();
    expect(screen.getByText("--space-4")).toBeInTheDocument();
    expect(screen.queryByText(/Design system unavailable here/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the unavailable view instead of the reference when the desktop bridge is present", () => {
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { getDesktopState: async () => null };
    render(<DesignSystemView />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install plugin" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the unavailable view for paired phone-access clients", () => {
    clientAccess.mode = "lan";
    render(<DesignSystemView />);
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays out of navigation, the LAN allowlist, and monitor clients", () => {
    expect(source("app/components/command-center/CommandCenterShell.tsx")).not.toMatch(/design-system/);
    expect(source("desktop/lan-gateway.mjs")).not.toMatch(/design-system/);
    expect(source("desktop/shell-main.mjs")).not.toMatch(/design-system/);
    const view = source("app/components/design-system/DesignSystemView.tsx");
    expect(view).not.toMatch(/fetch\(|EventSource|\/api\//);
    expect(view).not.toMatch(/agents-client|usage-limits-client|provider-status-client|SessionCatalogContext|next\/link|next\/navigation/);
  });
});
