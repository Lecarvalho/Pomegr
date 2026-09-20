import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SignalsDomain } from "../../shared/session-domain-contract";
import { SignalsCacheEvidenceSection } from "../../app/components/dashboard/signals/SignalsCacheEvidenceSection";
import { SignalsLifetimeSection } from "../../app/components/dashboard/signals/SignalsLifetimeSection";

const agents: SignalsDomain["agents"] = [
  { id: "primary", label: "Primary agent", cacheLifetime: "1h", signal: null },
  { id: "worker", label: "Worker", cacheLifetime: "30m+", signal: null },
];
const readyEvents: SignalsDomain["cacheEvents"] = { status: "ready", items: [{ id: "event-1", agentId: "primary", kind: "refill", observedAt: "2026-09-19T12:00:00.000Z", promptInputTokens: 2_000, cacheReadPercent: 10, cacheWriteTokens: 1_000, previousCacheReadPercent: null, gapMs: null, relatedEventId: null }], possibleFullRefills: [{ agentId: "worker", count: 1, reasons: [], toolChangeAttributions: [], occurrences: [{ observedAt: "2026-09-19T13:00:00.000Z", reason: null, providerStatus: "previous_cache_entry_unavailable", cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime: "1h", elapsedMs: 3_600_000 }, messageChangeSequence: null, toolChangeAttribution: { cause: "remote_control_connected", changes: [{ tool: "ListAgents", kind: "definition_changed" }] } }] }] };
const readyDrops: SignalsDomain["cacheReadDrops"] = { status: "ready", items: [{ agentId: "primary", count: 2, occurrences: [{ id: "drop-model", observedAt: "2026-09-19T14:00:00.000Z", previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000, kind: "model_change" }, { id: "drop-possible", observedAt: "2026-09-19T15:00:00.000Z", previousCacheReadPercent: 80, cacheReadPercent: 4, gapMs: 1_000 }] }] };

function renderEvidence(overrides: Partial<React.ComponentProps<typeof SignalsCacheEvidenceSection>> = {}) {
  return render(<SignalsCacheEvidenceSection agents={agents} cacheEvents={readyEvents} cacheReadDrops={readyDrops} historical={false} activityTargets={new Map([["event-1", { agent: "primary", request: "request-1" }]])} onOpenActivity={vi.fn()} {...overrides} />);
}

describe("Signals cache evidence", () => {
  it("presents evidence newest-first with observed, inferred, and attributed qualifications", () => {
    renderEvidence();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Possible cache refill · inference");
    expect(screen.getByText(/Provider count observed/)).toBeInTheDocument();
    expect(screen.getByText(/Inference: 1h cache lifetime elapsed/)).toBeInTheDocument();
    expect(screen.getByText(/Attributed: remote control connected/)).toBeInTheDocument();
    expect(screen.getByText(/No refill, expiry, or causation claim/)).toBeInTheDocument();
  });
  it("opens Activities only for an explicit supported association", () => {
    const onOpenActivity = vi.fn(); renderEvidence({ onOpenActivity });
    fireEvent.click(screen.getByRole("button", { name: "Open in Activities" }));
    expect(onOpenActivity).toHaveBeenCalledWith({ agent: "primary", request: "request-1" });
    expect(screen.getAllByRole("button", { name: "Open in Activities" })).toHaveLength(1);
  });
  it("keeps unsupported evidence informative and noninteractive", () => {
    renderEvidence({ activityTargets: new Map() });
    expect(screen.queryByRole("button", { name: "Open in Activities" })).not.toBeInTheDocument();
    expect(screen.getByText("Observed cache refill")).toBeInTheDocument();
  });
  it("has honest unavailable and historical-empty states", () => {
    const { rerender } = renderEvidence({ cacheEvents: { status: "unavailable", items: [], possibleFullRefills: [] }, cacheReadDrops: { status: "unavailable", items: [] } });
    expect(screen.getByText("Comparable cache evidence is unavailable.")).toBeInTheDocument();
    rerender(<SignalsCacheEvidenceSection agents={agents} cacheEvents={{ status: "ready", items: [], possibleFullRefills: [] }} cacheReadDrops={{ status: "ready", items: [] }} historical activityTargets={new Map()} onOpenActivity={vi.fn()} />);
    expect(screen.getByText("No cache evidence was recorded for this session.")).toBeInTheDocument();
  });
});

describe("Signals cache lifetime", () => {
  it("shows normalized lifetimes and documents the minimum without treating it as expiry", () => {
    render(<SignalsLifetimeSection agents={agents} readiness="ready" />);
    expect(screen.getByText("1h")).toBeInTheDocument(); expect(screen.getByText("≥30m")).toBeInTheDocument();
    expect(screen.getByText("≥30m is a documented minimum, not a recorded expiry.")).toBeInTheDocument();
  });
  it("does not invent lifetimes when context evidence is unavailable", () => {
    render(<SignalsLifetimeSection agents={agents} readiness="unavailable" />);
    expect(screen.getAllByText("unavailable")).toHaveLength(2);
    expect(screen.getByText("Context evidence is unavailable, so cache lifetimes are unavailable.")).toBeInTheDocument();
  });
});
