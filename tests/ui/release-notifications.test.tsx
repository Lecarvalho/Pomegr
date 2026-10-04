import { describe, expect, it } from "vitest";
import { normalizeNotificationSnapshot } from "../../app/notifications-client";
import { adaptNotificationRecords } from "../../app/components/command-center/NotificationCenter";
import type { NotificationRecord, NotificationSnapshot } from "../../shared/notification-contract";

const row: NotificationRecord = { id: "a".repeat(32), kind: "release_published", category: "provider_news", severity: "info",
  lifecycle: "resolved", priority: 30, occurredAt: "2026-10-03T12:00:00.000Z", timeBasis: "observed",
  deliveryEligible: true, action: "open_providers", provider: "claude",
  data: { product: "claude_code", version: "2.1.5", channel: "latest" } };
const snapshot: NotificationSnapshot = { version: 1, revision: 1, generatedAt: row.occurredAt,
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences: [row], activeSessionOverflow: 0 };

describe("release notification boundary", () => {
  it("shows precise published and installation-qualified copy through a fixed local action", () => {
    const normalized = normalizeNotificationSnapshot(snapshot)!;
    const [published] = adaptNotificationRecords(normalized.occurrences);
    expect(published.title).toBe("Claude Code 2.1.5 published");
    expect(published.description).toContain("Stable-channel availability is not confirmed");
    expect(published.href).toBe("/usage-limits");
    const plugin: NotificationRecord = { ...row, id: "b".repeat(32), kind: "installation_update_available", priority: 35,
      provider: null, data: { product: "pomegr_plugin", version: "0.8.0", channel: "main", affectedRepositories: 2 } };
    const [update] = adaptNotificationRecords(normalizeNotificationSnapshot({ ...snapshot, occurrences: [plugin] })!.occurrences);
    expect(update.title).toBe("Pomegr reporting plugin 0.8.0 update available");
    expect(update.description).toContain("2 repositories");
  });
  it("rejects product swaps, malformed versions, private fields and action changes", () => {
    for (const mutate of [
      (copy: NotificationSnapshot) => { copy.occurrences[0].provider = "codex"; },
      (copy: NotificationSnapshot) => { Object.assign(copy.occurrences[0].data, { version: "2.1.5-beta.1" }); },
      (copy: NotificationSnapshot) => { Object.assign(copy.occurrences[0].data, { version: ["2.1.5"] }); },
      (copy: NotificationSnapshot) => { Object.assign(copy.occurrences[0].data, { product: ["claude_code"] }); },
      (copy: NotificationSnapshot) => { Object.assign(copy.occurrences[0].data, { url: "https://example.invalid" }); },
      (copy: NotificationSnapshot) => { copy.occurrences[0].action = "open_session"; },
    ]) {
      const copy = structuredClone(snapshot); mutate(copy);
      expect(normalizeNotificationSnapshot(copy)).toBeNull();
    }
  });
});
