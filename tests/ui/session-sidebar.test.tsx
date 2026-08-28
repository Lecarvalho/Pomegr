import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/monitor-contract";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

describe("session sidebar", () => {
  const sessions: SessionSummary[] = [
    { id: "live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Pomegr", updatedAt: "2026-08-08T12:00:00.000Z", isLive: true, needsInput: true, activityStatus: "needs_input" },
    { id: "old-1", provider: "claude", source: "Claude Code", title: "Older work", project: "Pomegr", updatedAt: "2026-08-07T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown" },
  ];

  it("selects sessions, expands history, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<LiveClockProvider running={false}><SessionSidebar open sessions={sessions} selectedSessionId={null} currentSessionId="live-1" viewingHistory={false} onClose={onClose} onSelect={onSelect} /></LiveClockProvider>);

    expect(screen.getByRole("link", { name: "Home — open sessions" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: /Live work/ }));
    expect(onSelect).toHaveBeenCalledWith(sessions[0]);

    await user.click(screen.getByRole("button", { name: /^Pomegr1$/ }));
    await user.click(screen.getByRole("button", { name: /Older work/ }));
    expect(onSelect).toHaveBeenLastCalledWith(sessions[1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("disambiguates mixed-provider live and historical sessions", async () => {
    const user = userEvent.setup();
    const mixedSessions: SessionSummary[] = [
      sessions[0],
      { id: "codex:live-2", provider: "codex", source: "Codex", title: "Live work", project: "Pomegr", updatedAt: "2026-08-11T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working" },
      sessions[1],
      { id: "codex:old-2", provider: "codex", source: "Codex", title: "Older work", project: "Pomegr", updatedAt: "2026-08-06T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown" },
    ];

    render(<LiveClockProvider running={false}><SessionSidebar open sessions={mixedSessions} selectedSessionId={null} currentSessionId={null} viewingHistory={false} onClose={vi.fn()} onSelect={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByRole("button", { name: /Live workClaude Code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live workCodex/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Pomegr2$/ }));
    expect(screen.getAllByText("Claude Code")).toHaveLength(2);
    expect(screen.getAllByText("Claude Code").every((label) => label.classList.contains("providerTag") && Boolean(label.querySelector('[data-mark="claude"]')))).toBe(true);
    expect(screen.getAllByText("Codex")).toHaveLength(2);
    expect(screen.getAllByText("Codex").every((label) => label.classList.contains("providerTag") && Boolean(label.querySelector('[data-mark="openai"]')))).toBe(true);
    expect(screen.getAllByRole("button", { name: /Live work/ })).toHaveLength(2);
  });
});
