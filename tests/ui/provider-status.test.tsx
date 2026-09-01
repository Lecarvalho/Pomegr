import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderServiceStatus, ProviderStatusSnapshot } from "../../shared/monitor-contract";
import { ProviderServiceNotice, ProviderStatusDetails, dismissProviderIncident, dismissedProviderIncidentFor, providerIncidentRank, providerServiceNoticeVisible, providerStatusTone } from "../../app/components/ProviderStatus";
import { ProviderStatusStore, normalizeProviderStatusSnapshot } from "../../app/provider-status-client";

function provider(overrides: Partial<ProviderServiceStatus> = {}): ProviderServiceStatus {
  return {
    provider: "codex", source: "Codex", status: "degraded", readiness: "ready", freshness: "fresh",
    checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusPageUrl: "https://status.openai.com/",
    incidentKey: "status-0123456789abcdef01234567", incidents: [{ id: "status-0123456789abcdef01234567", label: "Elevated errors", status: "investigating", impact: "minor", updatedAt: null, url: "https://status.openai.com/incidents/native-issue-42" }],
    ...overrides,
  };
}

function snapshot(status = provider()): ProviderStatusSnapshot {
  return {
    revision: 4, generatedAt: new Date().toISOString(), providers: [
      { provider: "claude", source: "Claude Code", status: "operational", readiness: "ready", freshness: "fresh", checkedAt: new Date().toISOString(), updatedAt: null, statusPageUrl: "https://status.claude.com/", incidentKey: null, incidents: [] },
      status,
    ],
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("provider service status", () => {
  it("maps only current confirmed health to semantic tones", () => {
    expect(providerStatusTone(provider({ status: "operational", incidents: [], incidentKey: null }))).toBe("okay");
    expect(providerStatusTone(provider({ status: "degraded" }))).toBe("warning");
    expect(providerStatusTone(provider({ status: "maintenance" }))).toBe("warning");
    expect(providerStatusTone(provider({ status: "outage" }))).toBe("critical");
    expect(providerStatusTone(provider({ readiness: "unavailable" }))).toBe("unknown");
    expect(providerStatusTone(provider({ freshness: "stale" }))).toBe("unknown");
    expect(providerStatusTone(undefined)).toBe("unknown");
  });

  it("rejects malformed snapshots and retains a confirmed status across 204 and errors", async () => {
    expect(normalizeProviderStatusSnapshot({ providers: [] })).toBeNull();
    expect(normalizeProviderStatusSnapshot({ ...snapshot(), providers: [provider()] })).toBeNull();
    expect(normalizeProviderStatusSnapshot({ ...snapshot(), revision: -1 })).toBeNull();
    expect(normalizeProviderStatusSnapshot({ ...snapshot(), generatedAt: "not-a-date" })).toBeNull();
    expect(normalizeProviderStatusSnapshot(snapshot({ ...provider(), incidents: [{ ...provider().incidents[0], url: "https://status.openai.com/incidents/native-issue-42?unsafe=yes" }] }))).toBeNull();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("local cache unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = new ProviderStatusStore();

    await store.refresh();
    expect(store.getSnapshot().revision).toBe(4);
    await store.refresh();
    expect(store.getSnapshot().revision).toBe(4);
    await store.refresh();
    expect(store.getSnapshot().providers.find((entry) => entry.provider === "codex")?.status).toBe("degraded");
    expect(store.getSnapshot().providers.every((entry) => entry.readiness === "unavailable")).toBe(true);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/provider-status", "/api/provider-status?revision=4", "/api/provider-status?revision=4"]);
    await store.refresh();
    expect(store.getSnapshot().providers.every((entry) => entry.readiness === "ready")).toBe(true);
  });

  it("marks startup failures unavailable and recomputes freshness on a 204 response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const emptyStore = new ProviderStatusStore();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("unavailable"));
    await emptyStore.refresh();
    expect(emptyStore.getSnapshot().providers.every((entry) => entry.readiness === "unavailable")).toBe(true);

    const store = new ProviderStatusStore();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store.refresh();
    vi.setSystemTime(new Date("2026-08-31T12:16:00Z"));
    await store.refresh();
    expect(store.getSnapshot().providers.every((entry) => entry.freshness === "stale")).toBe(true);
  });

  it("shares one visible poller, pauses while hidden, and refreshes on return", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(snapshot()), { status: 200 }));
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const store = new ProviderStatusStore();
    const unsubscribeOne = store.subscribe(vi.fn());
    const unsubscribeTwo = store.subscribe(vi.fn());
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unsubscribeOne(); unsubscribeTwo();
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  });

  it("restarts polling after an aborted in-flight consumer lifecycle", async () => {
    let resolveFirst: ((response: Response) => void) | null = null;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(first).mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200 }));
    const store = new ProviderStatusStore();
    const unsubscribe = store.subscribe(vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsubscribe();
    const restarted = store.subscribe(vi.fn());
    resolveFirst!(new Response(JSON.stringify(snapshot()), { status: 200 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    restarted();
  });

  it("dismisses a current incident until a new incident or material worsening, and suppresses recovery and history", () => {
    const degraded = provider();
    const dismissed = { key: "status-0123456789abcdef01234567", rank: providerIncidentRank(degraded) };
    expect(providerServiceNoticeVisible(degraded, false, null)).toBe(true);
    expect(providerServiceNoticeVisible(degraded, false, dismissed)).toBe(false);
    expect(providerServiceNoticeVisible({ ...degraded, status: "outage", incidents: [{ ...degraded.incidents[0], impact: "major" }] }, false, dismissed)).toBe(true);
    const outageMajor = { ...degraded, status: "outage" as const, incidents: [{ ...degraded.incidents[0], impact: "major" as const }] };
    expect(providerServiceNoticeVisible({ ...outageMajor, incidents: [{ ...outageMajor.incidents[0], impact: "critical" }] }, false, { key: "status-0123456789abcdef01234567", rank: providerIncidentRank(outageMajor) })).toBe(true);
    expect(providerServiceNoticeVisible({ ...degraded, incidentKey: "incident-b" }, false, dismissed)).toBe(true);
    expect(providerServiceNoticeVisible({ ...degraded, status: "operational", incidents: [], incidentKey: null }, false, dismissed)).toBe(false);
    expect(providerServiceNoticeVisible(degraded, true, null)).toBe(false);
    expect(providerServiceNoticeVisible(degraded, false, null, false)).toBe(false);
    expect(providerServiceNoticeVisible({ ...degraded, readiness: "unavailable" }, false, null)).toBe(true);
    expect(providerServiceNoticeVisible({ ...degraded, freshness: "stale" }, false, null)).toBe(false);
  });

  it("keeps dismissals per session in bounded tab memory", () => {
    const dismissal = { key: "status-0123456789abcdef01234567", rank: 3 };
    dismissProviderIncident("codex:first", dismissal);
    dismissProviderIncident("claude:second", { key: "incident-b", rank: 2 });
    expect(dismissedProviderIncidentFor("codex:first")).toEqual(dismissal);
    expect(dismissedProviderIncidentFor("claude:second")).toEqual({ key: "incident-b", rank: 2 });
    for (let index = 0; index < 24; index += 1) dismissProviderIncident(`codex:bounded-${index}`, dismissal);
    expect(dismissedProviderIncidentFor("codex:first")).toBeNull();
    expect(dismissedProviderIncidentFor("codex:bounded-23")).toEqual(dismissal);
  });

  it("uses an accessible inline dismissal control", () => {
    const dismiss = vi.fn();
    render(<ProviderServiceNotice status={provider()} onDismiss={dismiss} />);
    expect(screen.getByRole("status", { name: "Codex provider service notice" })).toHaveTextContent("Requests may be delayed or fail");
    expect(screen.getByRole("link", { name: "View incident; opens in a new tab" })).toHaveAttribute("href", "https://status.openai.com/incidents/native-issue-42");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss provider service notice" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("provides compact keyboard-accessible details for checked time and the official status link", () => {
    render(<ProviderStatusDetails status={provider({ status: "operational", incidents: [], incidentKey: null })} compact />);
    expect(screen.getByText("No reported issues")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Codex provider service status details" });
    expect(trigger).toHaveClass("dottedInfoPopoverTrigger");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(screen.getByText("Last checked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View status page; opens in a new tab" })).toHaveAttribute("href", "https://status.openai.com/");
  });
});
