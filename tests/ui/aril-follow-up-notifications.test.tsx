import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptNotificationRecords, NotificationCenter } from "../../app/components/command-center/NotificationCenter";
import { AGENT_CHAT_OPEN_EVENT } from "../../app/components/agent-chat/agent-chat-presentation";
import { normalizeNotificationSnapshot } from "../../app/notifications-client";
import type { NotificationRecord } from "../../shared/notification-contract";

// Grant follow-ups in the notification tray (T-183): the same line as the chat, and a link to that repository's chat.
const REPO = `repo-${"e".repeat(24)}`;
const record = (overrides: Record<string, unknown> = {}) => ({ id: "f".repeat(32), kind: "aril_follow_up", category: "aril", severity: "info", lifecycle: "resolved",
  priority: 50, occurredAt: "2026-10-26T12:00:00.000Z", timeBasis: "observed", deliveryEligible: true, action: "open_aril_chat", provider: null,
  data: { repositoryId: REPO, conversationId: "chat-0123456789ab", messageId: "m-3", items: [{ kind: "grant_merge_refused", task: "T-7", provider: null }], more: 0, ended: null },
  ...overrides });
const snapshot = (occurrences: unknown[]) => ({ version: 1, revision: 1, generatedAt: "2026-10-26T12:00:00.000Z",
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences, activeSessionOverflow: 0 });

afterEach(() => vi.restoreAllMocks());

describe("a grant follow-up notification", () => {
  it("is parsed only inside its public allowlist", () => {
    expect(normalizeNotificationSnapshot(snapshot([record()]))?.occurrences[0].data).toEqual(record().data);
    for (const bad of [{ provider: "claude" }, { category: "attention" }, { action: "open_session" }, { data: { ...record().data, text: "raw" } },
      { data: { ...record().data, repositoryId: "repo-x" } }]) {
      expect(normalizeNotificationSnapshot(snapshot([record(bad)]))).toBeNull();
    }
  });

  it("shows the chat line in the Aril group and its link opens that repository's chat at the follow-up", () => {
    const parsed = normalizeNotificationSnapshot(snapshot([record()]))!.occurrences as NotificationRecord[];
    const entries = adaptNotificationRecords(parsed);
    expect(entries[0]).toMatchObject({ group: "Aril", title: "Grant follow-up", description: "Could not merge T-7. T-7 needs you.",
      href: `/tasks?repository=${REPO}&aril=chat-0123456789ab&message=m-3`, linkLabel: "Open chat" });
    const opened = vi.fn();
    window.addEventListener(AGENT_CHAT_OPEN_EVENT, opened);
    const onClose = vi.fn();
    render(<NotificationCenter entries={entries} isUnread={() => true} unreadCount={1} hasUnreadAttention={false} markAllRead={() => {}}
      sourceStatus="ready" activeSessionOverflow={0} onClose={onClose} />);
    const link = screen.getByRole("link", { name: "Open chat" });
    expect(link).toHaveAttribute("href", entries[0].href);
    fireEvent.click(link);
    window.removeEventListener(AGENT_CHAT_OPEN_EVENT, opened);
    expect(onClose).toHaveBeenCalledWith(false);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ repositoryId: REPO, conversationId: "chat-0123456789ab", messageId: "m-3" });
  });
});
