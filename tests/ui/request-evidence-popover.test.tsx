import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEventFeed, CacheReadDropFeed, CacheRefillOccurrence } from "../../shared/monitor-contract";
import { requestCacheEvidence } from "../../app/components/dashboard/requests-actions/cache-evidence";
import { agent } from "./dashboard-test-fixtures";
import { RequestsActionsPanel, renderPanel, requestFeed, selectedRequest, setPhone, snapshot } from "./requests-actions-test-fixtures";

afterEach(() => vi.unstubAllGlobals());

const ISSUE = { name: "anthropics/claude-code#82563 (opens in a new tab)", href: "https://github.com/anthropics/claude-code/issues/82563" };
const target = snapshot(2);
const none = { reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null };

function refillFeed(occurrence: Partial<CacheRefillOccurrence>, agentId = "primary"): CacheEventFeed {
  return { status: "ready", items: [], possibleFullRefills: [{
    agentId, count: occurrence.kind ? 0 : 1, ...(occurrence.kind ? { providerDiagnosedCount: 1 } : {}), reasons: [], toolChangeAttributions: [],
    occurrences: [{ observedAt: target.observedAt, ...none, ...occurrence }],
  }] };
}

function renderRefill(occurrence: Partial<CacheRefillOccurrence>, phone: boolean) {
  setPhone(phone);
  const view = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), target, snapshot(3)])} contextBoundaries={[]} cacheWriteAvailable historical={false}
    cacheEvents={refillFeed(occurrence)} cacheReadDrops={{ status: "ready", items: [] }} />);
  const trigger = () => screen.getByRole("button", { name: "Cache refill evidence for request #2" });
  return { ...view, trigger };
}

describe("request refill evidence popover", () => {
  it.each([false, true])("opens the Agents-tab refill evidence from the marker, selects the request and closes with Escape (phone: %s)", async (phone) => {
    const user = userEvent.setup();
    const { trigger } = renderRefill({ reason: "tools_changed", toolChangeAttribution: { cause: "deferred_definitions_loaded", changes: [], addedDefinitionCount: 8 } }, phone);
    expect(selectedRequest()).toBe("#3");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger());
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(selectedRequest()).toBe("#2");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", popover.id);
    expect(popover).toHaveTextContent("Possible full refill");
    expect(popover).toHaveTextContent("Providertool definitions changed");
    expect(popover).toHaveTextContent("Inferencetool definitions loaded after a tool search (8 added)");
    expect(within(popover).queryByRole("link", { name: /82563/ })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("is reachable from the keyboard and toggles with Enter and Space", () => {
    const { trigger } = renderRefill({ reason: "system_changed" }, false);
    act(() => trigger().focus());
    expect(trigger()).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Cache refill evidence" })).toHaveTextContent("system instructions changed");
    fireEvent.keyDown(trigger(), { key: " " });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("states that the reason is unavailable and links the upstream issue for an unexplained possible full refill", async () => {
    const user = userEvent.setup();
    const { trigger } = renderRefill({}, false);
    await user.click(trigger());
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(popover).toHaveTextContent("Possible full refill");
    expect(popover).toHaveTextContent("reason unavailable");
    expect(within(popover).getByRole("link", { name: ISSUE.name })).toHaveAttribute("href", ISSUE.href);
  });

  it.each([
    ["a recognized reason", { reason: "messages_changed" as const }],
    ["a provider status", { providerStatus: "previous_cache_entry_unavailable" as const }],
    ["a lifetime inference", { providerStatus: "previous_cache_entry_unavailable" as const, cacheLifetimeInference: { cause: "cache_lifetime_elapsed" as const, cacheLifetime: "5m" as const, elapsedMs: 600_000 } }],
    ["a provider-diagnosed refill", { kind: "provider_diagnosed" as const, reason: "tools_changed" as const }],
  ])("does not link the upstream issue for %s", async (_name, occurrence) => {
    const user = userEvent.setup();
    const { trigger } = renderRefill(occurrence, false);
    await user.click(trigger());
    expect(screen.getByRole("dialog", { name: "Cache refill evidence" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /82563/ })).not.toBeInTheDocument();
  });

  it("shows the expiry inference as the only evidence line", async () => {
    const user = userEvent.setup();
    const { trigger } = renderRefill({ providerStatus: "previous_cache_entry_unavailable", cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime: "5m", elapsedMs: 600_000 } }, false);
    await user.click(trigger());
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(popover).toHaveTextContent("Five-minute cache likely expired; 10m elapsed since the preceding request.");
    expect(popover).not.toHaveTextContent("Impact");
  });

  it.each([false, true])("draws a provider-diagnosed marker with the recorded-refill glyph and shows its reason (phone: %s)", async (phone) => {
    const user = userEvent.setup();
    const { container, trigger } = renderRefill({ kind: "provider_diagnosed", reason: "messages_changed" }, phone);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker).not.toHaveClass("isInferred");
    expect(marker.querySelector(".cacheRefillIcon path[fill]")).toHaveAttribute("fill", "currentColor");
    expect(marker.querySelector("title")).toHaveTextContent("Provider-diagnosed refill · request #2");
    await user.click(trigger());
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(popover).toHaveTextContent("Provider-diagnosed refill");
    expect(popover).toHaveTextContent("Providermessage history changed");
    expect(popover).not.toHaveTextContent(/full|infer/i);
  });

  it("opens no popover for read-drop evidence", () => {
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{ id: "drop-2", observedAt: target.observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheReadDrops });
    expect(container.querySelector(".requestsActionsRefill.isInferred")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cache refill evidence for request/ })).not.toBeInTheDocument();
  });

  it("hands the matched occurrence to the popover and keeps ambiguous timestamps unavailable", () => {
    const occurrence: CacheRefillOccurrence = { observedAt: target.observedAt, kind: "provider_diagnosed", reason: "tools_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null };
    const evidence = requestCacheEvidence([target], refillFeed(occurrence));
    expect(evidence.get(target.id)).toMatchObject({ kind: "provider_diagnosed", occurrence });
    expect(requestCacheEvidence([target, { ...snapshot(3), observedAt: target.observedAt }], refillFeed(occurrence)).size).toBe(0);
  });
});
