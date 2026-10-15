import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeNotificationSnapshot } from "../../app/notifications-client";
import { adaptNotificationRecords, NotificationCenter } from "../../app/components/command-center/NotificationCenter";
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
  it("shows a Claude Code excerpt under the title and a What's new link to the derived tag page", () => {
    const excerpt = "Added the review command. Fixed a crash on resume.";
    const claude: NotificationRecord = { ...row, data: { product: "claude_code", version: "2.1.5", channel: "latest", excerpt } };
    const codex: NotificationRecord = { ...row, id: "c".repeat(32), provider: "codex", occurredAt: "2026-10-03T11:00:00.000Z",
      data: { product: "codex_cli", version: "0.48.0", channel: "latest" } };
    const normalized = normalizeNotificationSnapshot({ ...snapshot, occurrences: [claude, codex] })!;
    const entries = adaptNotificationRecords(normalized.occurrences);
    render(<NotificationCenter entries={entries} isUnread={() => true} unreadCount={2} markAllRead={() => {}}
      sourceStatus="ready" activeSessionOverflow={0} hasUnreadAttention onClose={() => {}} />);
    expect(screen.getByText(excerpt)).toBeVisible();
    expect(screen.getByText("This is a Codex CLI release; desktop and IDE updates are separate.")).toBeVisible();
    const links = screen.getAllByRole("link", { name: "What's new" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/anthropics/claude-code/releases/tag/v2.1.5",
      "https://github.com/openai/codex/releases/tag/rust-v0.48.0",
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getAllByRole("link", { name: "View providers" }).map((link) => link.getAttribute("href"))).toEqual(["/usage-limits", "/usage-limits"]);
  });
  it("keeps the fixed wording without an excerpt and refuses unsafe or misplaced excerpts", () => {
    const [plain] = adaptNotificationRecords(normalizeNotificationSnapshot(snapshot)!.occurrences);
    expect(plain.description).toContain("Stable-channel availability is not confirmed");
    for (const data of [
      { product: "claude_code", version: "2.1.5", channel: "latest", excerpt: "See https://example.invalid" },
      { product: "claude_code", version: "2.1.5", channel: "latest", excerpt: "<script>x</script>" },
      { product: "claude_code", version: "2.1.5", channel: "latest", excerpt: "x".repeat(281) },
      { product: "claude_code", version: "2.1.5", channel: "latest", excerpt: ["notes"] },
    ]) {
      const copy = structuredClone(snapshot);
      copy.occurrences[0].data = data as NotificationRecord["data"] & { product: "claude_code" };
      expect(normalizeNotificationSnapshot(copy)).toBeNull();
    }
    const codex = structuredClone(snapshot);
    Object.assign(codex.occurrences[0], { provider: "codex", data: { product: "codex_cli", version: "0.48.0", channel: "latest", excerpt: "Notes." } });
    expect(normalizeNotificationSnapshot(codex)).toBeNull();
  });
});
