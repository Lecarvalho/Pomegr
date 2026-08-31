import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { normalizeReportSaveRequest } from "../../desktop/report-save.mjs";
import { agent, claudeCapabilities, repositorySession } from "./dashboard-test-fixtures";
import type { MonitorState } from "../../shared/monitor-contract";

function state(requestCount = 67): MonitorState {
  const data = createEmptyMonitorState({ connected: true, capabilities: claudeCapabilities, view: "history" });
  data.session = {
    ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    id: "claude:report-fixture",
    startedAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T01:00:00.000Z",
    durationMs: 3_600_000,
  };
  data.agents = [agent];
  data.metrics.agents = 1;
  data.readiness = { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "unavailable", usageLimits: "unavailable" };
  data.metrics.tokens.reportEvidence = {
    version: 1, requestCount,
    cache: { status: "ready", refills: 0, reuses: 0, possibleFullRefills: 0, missRefills: 0, transitions: [] },
    context: { status: "ready", automaticCompactions: 0, manualCompactions: 0, snapshotDrops: 0, boundaries: [] },
    limits: { refillTransitions: 100, contextBoundaries: 100 },
  };
  return data;
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
});

async function download(refresh: Response | Error) {
  const saveReport = vi.fn().mockResolvedValue({ status: "saved" });
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
    saveReport, getDesktopState: async () => null,
    onDesktopStateChanged: () => () => {},
  };
  let exporting = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("/api/provider-status")) return new Response(null, { status: 503 });
    if (!exporting) return new Response(JSON.stringify(state()), { status: 200, headers: { "Content-Type": "application/json" } });
    if (refresh instanceof Error) throw refresh;
    return refresh.clone();
  });
  render(<SessionCatalogProvider sessions={[]}><Dashboard initialSessionId="claude:report-fixture" /></SessionCatalogProvider>);
  const button = await screen.findByRole("button", { name: "Download report" });
  exporting = true;
  await userEvent.setup().click(button);
  await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
  const request = saveReport.mock.calls[0][0] as { filename: string; content: string };
  expect(normalizeReportSaveRequest(request)).toEqual(request);
  expect(request.content).toMatch(/^# Pomegr Session Observation Report\n/);
  return request.content;
}

it("exports the fresh committed evidence through the desktop save contract", async () => {
  const report = await download(new Response(JSON.stringify(state(89)), {
    status: 200, headers: { "Content-Type": "application/json", "x-pomegr-revision": "42" },
  }));
  expect(report).toContain("89");
  expect(report).toContain("42");
  expect(report).not.toMatch(/Flow score|Retrospective questions/);
});

it("exports the visible snapshot when refresh returns unchanged or is unavailable", async () => {
  const report = await download(new Response(null, { status: 204 }));
  expect(report).toContain("67");
});

it("does not export a different session returned by a refresh", async () => {
  const unrelated = state(89);
  unrelated.session!.id = "claude:unrelated";
  const report = await download(new Response(JSON.stringify(unrelated), { status: 200 }));
  expect(report).toContain("claude:report-fixture");
  expect(report).not.toContain("claude:unrelated");
});
