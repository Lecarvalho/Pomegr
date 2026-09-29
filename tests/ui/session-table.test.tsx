import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";
import { installDirectoryFixture } from "./session-directory-test-fixture";

const sessions = [
  { id: "codex:progress", provider: "codex", source: "Codex", title: "Progress available", project: "Pomegr", updatedAt: "2026-08-29T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12_000, progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-29T12:00:00.000Z" }, currentActivity: { label: "Preparing tab4 for header measurement", observedAt: "2026-08-29T12:00:00.000Z", state: "current" }, activityFallback: null },
  { id: "claude:no-progress", provider: "claude", source: "Claude Code", title: "Progress unavailable", project: "Pomegr", updatedAt: "2026-08-29T11:59:00.000Z", isLive: true, needsInput: false, activityStatus: "idle", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 8_000, progress: null, currentActivity: null, activityFallback: null },
] satisfies SessionSummary[];
async function renderDirectory(rows: SessionSummary[]) { installDirectoryFixture(rows); render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>); await screen.findByText(rows[0]?.title || "No sessions observed"); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("sessions table", () => {
  it.each([["working", "In progress", true], ["needs_input", "Needs input", true], ["idle", "Idle", true], ["open", "Open", false], ["stopped", "Stopped", true], ["closed", "Closed", false], ["unknown", "Unknown", false]] as const)("renders %s as %s without deriving it from the live flag", async (activityStatus, label, isLive) => {
    await renderDirectory([{ ...sessions[0], activityStatus, isLive }]);
    expect(within(screen.getByText("Progress available").closest("tr")!).getByText(label)).toBeInTheDocument();
  });
  it("does not display unqualified provider activity and labels retained fallback activity as previous", async () => {
    const historical = { ...sessions[0], isLive: false, activityStatus: "idle" as const, currentActivity: null, activityFallback: { label: "Old task", observedAt: "2026-08-29T12:00:00.000Z", state: "last_observed" as const, source: "tool" as const, actor: "primary" as const } };
    await renderDirectory([historical]);
    expect(screen.queryByText("Preparing tab4 for header measurement")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Previous activity: Old task/ })).toHaveLength(2);
  });
  it("renders current labels as text instead of markup", async () => {
    const label = '<img src=x onerror="alert(1)">';
    await renderDirectory([{ ...sessions[0], currentActivity: { ...sessions[0].currentActivity!, label } }]);
    expect(screen.getAllByText(label, { exact: false })).toHaveLength(2);
    expect(document.querySelector(".commandTableActivity img")).toBeNull();
  });
});
