import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { Dashboard } from "../../app/Dashboard";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

afterEach(() => { resetSessionDomainStoreForTests(); vi.restoreAllMocks(); });

describe("session ID copy", () => {
  it("copies the full native session ID when the header ID chip is clicked", async () => {
    const summary = sessionSummaryFixture({ sessionId: "claude:3f2b9c1e-7a4d-4e8b-9c21-5d6f7a8b9c0d" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/session-domain") ? json(summary) : new Response(null, { status: 404 }));
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard initialSessionId={summary.sessionId} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
      const chip = await screen.findByRole("button", { name: "3f2b9…b9c0d" });
      expect(chip).toHaveClass("commandChip", "sessionIdChip");
      expect(chip).toHaveAttribute("title", "Copy session ID 3f2b9c1e-7a4d-4e8b-9c21-5d6f7a8b9c0d");
      await user.click(chip);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("3f2b9c1e-7a4d-4e8b-9c21-5d6f7a8b9c0d"));
      expect(chip).toHaveClass("positive");
      expect(chip).toHaveAttribute("title", "Session ID copied");
      expect(screen.getByText("Session ID copied.")).toHaveAttribute("role", "status");
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
  });
});
