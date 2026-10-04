import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { normalizeNotificationSnapshot } from "../../app/notifications-client";
import { adaptNotificationRecords, NotificationCenter } from "../../app/components/command-center/NotificationCenter";
import type { NotificationRecord, NotificationSnapshot } from "../../shared/notification-contract";
const row: NotificationRecord = { id: "a".repeat(32), kind: "model_announced", category: "model_news", severity: "info",
  lifecycle: "resolved", priority: 25, occurredAt: "2026-10-03T12:00:00.000Z", timeBasis: "observed",
  deliveryEligible: true, action: "open_providers", provider: "codex", data: { modelId: "gpt-6", label: "GPT-6", evidence: "official_announcement" } };
const snapshot: NotificationSnapshot = { version: 1, revision: 1, generatedAt: row.occurredAt,
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences: [row], activeSessionOverflow: 0 };
describe("model notification boundaries and presentation", () => {
  it("renders announcement and listing as distinct evidence through the unchanged tray", () => {
    const listing: NotificationRecord = { ...row, id: "b".repeat(32), kind: "model_client_listed", data: { ...row.data, evidence: "client_catalog" } };
    const normalized = normalizeNotificationSnapshot({ ...snapshot, occurrences: [row, listing] })!;
    expect(normalized).not.toBeNull();
    const entries = adaptNotificationRecords(normalized.occurrences);
    render(<NotificationCenter entries={entries} isUnread={() => true} unreadCount={2} markAllRead={() => {}}
      sourceStatus="ready" activeSessionOverflow={0} hasUnreadAttention onClose={() => {}} />);
    expect(screen.getByText("GPT-6 announced")).toBeVisible();
    expect(screen.getByText("GPT-6 listed in your client")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "View providers" }).map((link) => link.getAttribute("href"))).toEqual(["/usage-limits", "/usage-limits"]);
    expect(entries.every((entry) => entry.description.includes("account"))).toBe(true);
  });
  it("rejects model identifier coercion, paths, markup, evidence swaps and extra private data", () => {
    for (const patch of [{ modelId: ["gpt-6"] }, { modelId: "C:secret" }, { modelId: "../private" }, { label: "<unsafe>" },
      { evidence: "client_catalog" }, { sourceScope: "private" }]) {
      const bad = structuredClone(snapshot); Object.assign(bad.occurrences[0].data, patch);
      expect(normalizeNotificationSnapshot(bad)).toBeNull();
    }
    expect(normalizeNotificationSnapshot({ ...snapshot, occurrences: [{ ...row, action: "open_session" }] })).toBeNull();
  });
});
