import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEventFeed, CacheReadDropFeed, CacheRefillOccurrence } from "../../shared/monitor-contract";
import { requestCacheEvidence } from "../../app/components/dashboard/requests-actions/cache-evidence";
import { agent } from "./dashboard-test-fixtures";
import { RequestsActionsPanel, renderPanel, requestFeed, setPhone, snapshot } from "./requests-actions-test-fixtures";

afterEach(() => vi.unstubAllGlobals());

const target = snapshot(2);
const none = { reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null };
const expired = { cause: "cache_lifetime_elapsed" as const, cacheLifetime: "5m" as const, elapsedMs: 600_000 };

function refillFeed(occurrence: Partial<CacheRefillOccurrence>, agentId = "primary"): CacheEventFeed {
  const partial = occurrence.kind === "provider_diagnosed" ? { providerDiagnosedCount: 1 } : occurrence.kind === "lifetime_elapsed" ? { lifetimeElapsedCount: 1 } : null;
  return { status: "ready", items: [], possibleFullRefills: [{
    agentId, count: partial ? 0 : 1, ...partial, reasons: [], toolChangeAttributions: [],
    occurrences: [{ observedAt: target.observedAt, ...none, ...occurrence }],
  }] };
}

function renderRefill(occurrence: Partial<CacheRefillOccurrence>, phone = false) {
  setPhone(phone);
  const view = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), target, snapshot(3)])} contextBoundaries={[]} cacheWriteAvailable historical={false}
    cacheEvents={refillFeed(occurrence)} cacheReadDrops={{ status: "ready", items: [] }} />);
  const bar = view.container.querySelector(".requestsActionsRefill")!.closest(".requestsActionsBar")!;
  return { ...view, bar };
}

describe("request refill evidence tooltip", () => {
  it.each([
    ["an unexplained possible full refill", {}, "No cause was recorded. See the Agents tab for details."],
    ["a recognized reason", { reason: "system_changed" as const }, "Provider diagnostic: system instructions changed."],
    ["a provider status", { providerStatus: "previous_cache_entry_unavailable" as const }, "Provider diagnostic: previous cache entry unavailable."],
    ["a tool-change inference", { reason: "tools_changed" as const, toolChangeAttribution: { cause: "deferred_definitions_loaded" as const, changes: [], addedDefinitionCount: 8 } },
      "Provider diagnostic: tool definitions changed. Inference: tool definitions loaded after a tool search (8 added)."],
    ["an expiry inference", { providerStatus: "previous_cache_entry_unavailable" as const, cacheLifetimeInference: expired }, "Five-minute cache likely expired; 10m elapsed since the preceding request."],
    ["a provider-diagnosed refill", { kind: "provider_diagnosed" as const, reason: "messages_changed" as const }, "Provider diagnostic: message history changed."],
    ["an elapsed-lifetime partial refill", { kind: "lifetime_elapsed" as const, cacheLifetimeInference: expired }, "Five-minute cache likely expired; 10m elapsed since the preceding request."],
  ])("shows %s as a small tooltip on hover and focus", (_name, occurrence, text) => {
    const { bar } = renderRefill(occurrence);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerEnter(bar);
    expect(screen.getByRole("tooltip").textContent).toBe(text);
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining(text.replace(/\.$/, "")));
    fireEvent.pointerLeave(bar);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(bar);
    expect(screen.getByRole("tooltip").textContent).toBe(text);
  });

  it.each([false, true])("opens no dialog, exposes no marker button and carries no link (phone: %s)", (phone) => {
    const { bar, container } = renderRefill({}, phone);
    expect(screen.queryByRole("button", { name: /Cache refill evidence/ })).not.toBeInTheDocument();
    fireEvent.click(bar);
    fireEvent.pointerEnter(bar);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/82563|anthropics/);
    expect(container.querySelector(".requestsActionsRefillTrigger")).toBeNull();
  });

  it.each([false, true])("draws a provider-diagnosed marker with the recorded-refill glyph (phone: %s)", (phone) => {
    const { container, bar } = renderRefill({ kind: "provider_diagnosed", reason: "messages_changed" }, phone);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker).not.toHaveClass("isInferred");
    expect(marker.querySelector(".cacheRefillIcon path[fill]")).toHaveAttribute("fill", "currentColor");
    expect(marker.querySelector("title")).toHaveTextContent("Provider-diagnosed refill · request #2");
    fireEvent.pointerEnter(bar);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/full|infer/i);
  });

  it("shows no tooltip for read-drop evidence", () => {
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{ id: "drop-2", observedAt: target.observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheReadDrops });
    const marker = container.querySelector(".requestsActionsRefill.isInferred")!;
    fireEvent.pointerEnter(marker.closest(".requestsActionsBar")!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hands the matched occurrence to the tooltip and keeps ambiguous timestamps unavailable", () => {
    const occurrence: CacheRefillOccurrence = { observedAt: target.observedAt, kind: "provider_diagnosed", reason: "tools_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null };
    const evidence = requestCacheEvidence([target], refillFeed(occurrence));
    expect(evidence.get(target.id)).toMatchObject({ kind: "provider_diagnosed", occurrence });
    expect(requestCacheEvidence([target, { ...snapshot(3), observedAt: target.observedAt }], refillFeed(occurrence)).size).toBe(0);
  });
});
