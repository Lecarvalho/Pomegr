import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeNotificationSnapshot } from "../../app/notifications-client";
import { adaptNotificationRecords, NotificationCenter } from "../../app/components/command-center/NotificationCenter";
import type { NotificationRecord, NotificationSnapshot } from "../../shared/notification-contract";

const records: NotificationRecord[] = [
  { id: "a".repeat(32), kind: "usage_window_reset", category: "usage", severity: "info", lifecycle: "resolved", priority: 60,
    occurredAt: "2026-10-03T12:00:00.000Z", timeBasis: "observed", deliveryEligible: true, action: "open_usage_limits", provider: "claude",
    data: { window: "five_hour", origin: "local_observation", otherExhausted: true } },
  { id: "b".repeat(32), kind: "usage_capacity_restored", category: "usage", severity: "info", lifecycle: "resolved", priority: 60,
    occurredAt: "2026-10-03T12:00:00.000Z", timeBasis: "observed", deliveryEligible: true, action: "open_usage_limits", provider: "codex",
    data: { window: "primary", origin: "provider_api", otherExhausted: false } },
  { id: "c".repeat(32), kind: "usage_reset_available", category: "usage", severity: "info", lifecycle: "resolved", priority: 60,
    occurredAt: "2026-10-03T12:00:00.000Z", timeBasis: "observed", deliveryEligible: true, action: "open_usage_limits", provider: "codex",
    data: { availableCount: 2 } },
];
const snapshot: NotificationSnapshot = { version: 1, revision: 3, generatedAt: "2026-10-03T12:00:00.000Z",
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences: records, activeSessionOverflow: 0 };

describe("usage notification boundary and copy", () => {
  it("renders the persistent sign-in observation with the opt-in category and safe action", () => {
    const auth: NotificationRecord = { ...records[0], kind: "usage_authentication_required", provider: "claude",
      category: "provider_news", severity: "warning", priority: 75, data: {} };
    const normalized = normalizeNotificationSnapshot({ ...snapshot, occurrences: [auth] });
    expect(normalized?.occurrences).toEqual([auth]);
    const [entry] = adaptNotificationRecords(normalized!.occurrences);
    expect(entry.group).toBe("Needs attention");
    expect(entry.description).toContain("after a retry");
    expect(entry.href).toBe("/usage-limits");
  });
  it("accepts all real kinds, rebuilds the allowlist, and displays fixed safe usage links", () => {
    const source = structuredClone(snapshot);
    Object.assign(source.occurrences[2].data, { id: "PRIVATE_CREDIT_ID", title: "PRIVATE_TITLE", description: "PRIVATE_BODY", url: "https://private.invalid" });
    const normalized = normalizeNotificationSnapshot(source)!;
    expect(normalized).toEqual(snapshot);
    const entries = adaptNotificationRecords(normalized.occurrences);
    render(<NotificationCenter entries={entries} isUnread={() => true} unreadCount={3} markAllRead={() => {}}
      sourceStatus="ready" activeSessionOverflow={0} onClose={() => {}} hasUnreadAttention />);
    expect(screen.getByText("Claude Code five-hour window rolled over")).toBeInTheDocument();
    expect(screen.getByText(/Observed in the local status line. Another usage window remains exhausted/)).toBeInTheDocument();
    expect(screen.getByText("A Codex primary window has capacity again")).toBeInTheDocument();
    expect(screen.getByText(/no reset has been used/)).toBeInTheDocument();
    for (const link of screen.getAllByRole("link")) expect(link).toHaveAttribute("href", "/usage-limits");
  });

  it("rejects malformed counts, wrong provider/window combinations and action changes", () => {
    for (const mutate of [
      (value: NotificationSnapshot) => Object.assign(value.occurrences[2].data, { availableCount: null }),
      (value: NotificationSnapshot) => Object.assign(value.occurrences[0].data, { window: "primary" }),
      (value: NotificationSnapshot) => { value.occurrences[0].action = "open_session"; },
      (value: NotificationSnapshot) => { value.occurrences[0].category = "attention"; },
    ]) {
      const value = structuredClone(snapshot); mutate(value);
      expect(normalizeNotificationSnapshot(value)).toBeNull();
    }
  });
});
