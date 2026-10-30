import { act, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => (await import("./design-system-helpers")).stubClientAccess(await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>()));

import { DesignSystemView } from "../../app/components/design-system/DesignSystemView";
import DesignSystemPage from "../../app/design-system/page";
import { access, forbidNetwork, source } from "./design-system-helpers";

const SECTION_HEADINGS = ["Buttons", "Form fields", "Request charts", "Events rail", "Agent roster", "Agent grid tile states", "Agent inspector", "Inspector sheet frame", "Revision evidence", "Repository setup row states", "Chips and pills", "Panels and dividers", "Command table", "Settings tab rail", "Task fields", "Task cards and board", "Queue controls", "Start gates and schedule", "Sessions list Task cell", "Assigned sessions", "Promote issues", "GitHub settings", "Home", "Home update", "Agent chat", "Typography and tokens"];
const SAMPLE_SOURCES = [
  "DesignSystemView", "DesignSystemKit", "DesignSystemControlSamples", "DesignSystemFileSamples", "DesignSystemRequestSamples", "DesignSystemShellSamples", "DesignSystemAgentSamples", "DesignSystemAgentGridSample",
  "DesignSystemLayoutSamples", "DesignSystemEventsSample", "DesignSystemTaskFieldsSample", "DesignSystemFeatureModalSample", "DesignSystemTaskBoardSample", "DesignSystemTaskGatesSample", "DesignSystemSessionTaskSample",
  "DesignSystemAssignedSessionsSample", "DesignSystemAgentChatSample", "DesignSystemRepositorySamples",
].map((name) => `app/components/design-system/${name}.tsx`).concat("app/components/design-system/DesignSystemTaskSampleData.ts");

// Page-level behavior only: the page composes every section, hydrates, hides itself where it must, and stays out of navigation.
// Each section's own samples are checked by the other design-system-*.test.tsx files, which mount that section alone.
describe("Design-system reference page", () => {
  forbidNetwork();

  afterEach(() => {
    access.mode = "unknown";
    delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  });

  it("hydrates the server-rendered page, with every section and its SVG titles, without a mismatch or the network", async () => {
    const html = renderToString(<DesignSystemPage />);
    expect(html).toContain(">Possible full refill · request #38</title>");
    expect(html).not.toContain("<title></title>");
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = html;
    const recoverable = vi.fn();
    const root = await act(async () => hydrateRoot(container, <DesignSystemPage />, { onRecoverableError: recoverable }));
    expect(recoverable).not.toHaveBeenCalled();
    expect(within(container).getByRole("heading", { level: 1, name: "Design system" })).toBeInTheDocument();
    for (const name of SECTION_HEADINGS) expect(within(container).getByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(within(container).queryByText(/Design system unavailable here/)).not.toBeInTheDocument();
    act(() => root.unmount());
    container.remove();
    // The one test that draws every section, so it keeps an allowance for a loaded machine.
  }, 30_000);

  it("renders the unavailable view instead of the reference when the desktop bridge is present", () => {
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { getDesktopState: async () => null };
    render(<DesignSystemView />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install plugin" })).not.toBeInTheDocument();
  });

  it("renders the unavailable view for paired phone-access clients", () => {
    access.mode = "lan";
    render(<DesignSystemView />);
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
  });

  it("stays out of navigation, the LAN allowlist, and monitor clients", () => {
    expect(source("app/components/command-center/CommandCenterShell.tsx")).not.toMatch(/design-system/);
    expect(source("desktop/runtime/lan-gateway.mjs")).not.toMatch(/design-system/);
    expect(source("desktop/runtime/shell-main.mjs")).not.toMatch(/design-system/);
    for (const file of SAMPLE_SOURCES) {
      const view = source(file);
      expect(view).not.toMatch(/fetch\(|EventSource|\/api\//);
      expect(view).not.toMatch(/agents-client|usage-limits-client|provider-status-client|SessionCatalogContext|next\/link|next\/navigation/);
    }
  });
});
