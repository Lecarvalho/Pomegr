// Grant follow-ups: one fixed line, built here from task-log facts, appended to the grant's own conversation. No provider
// runs, and the message never proposes, applies, or starts anything.

import { ARIL_FOLLOW_UP_END_REASONS, ARIL_FOLLOW_UP_ITEMS, arilFollowUpText, normalizeArilFollowUpItem } from "../../shared/aril-follow-up.mjs";
import { MESSAGE_LIMIT } from "./agent-chat-store.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");
const UNAVAILABLE = refused("unavailable");

/**
 * The chat's writer of grant follow-ups. `busy(repositoryId, conversationId)` answers whether that conversation is
 * answering or about to; `provider()` answers the provider a new follow-up conversation keeps for the owner's replies.
 */
export function createGrantFollowUps({ store, now, busy, provider }) {
  return async function grantFollowUp({ repositoryId, grant, items, more, ended } = {}) {
    if (!store) return UNAVAILABLE;
    const facts = Array.isArray(items) && items.length <= ARIL_FOLLOW_UP_ITEMS ? items.map(normalizeArilFollowUpItem) : null;
    if (!REPOSITORY_ID.test(String(repositoryId)) || !Number.isSafeInteger(grant) || grant < 1 || !facts || facts.some((item) => item === null)
      || !Number.isSafeInteger(more) || more < 0 || !(ended === null || ARIL_FOLLOW_UP_END_REASONS.includes(ended)) || (facts.length === 0 && ended === null)) return INVALID;
    const text = arilFollowUpText({ items: facts, more, ended });
    let conversation = (await store.list(repositoryId)).find((entry) => entry.grant === grant) ?? null;
    // `busy` asks again on the runner's next tick.
    if (conversation && busy(repositoryId, conversation.id)) return refused("busy");
    if (conversation && conversation.messages.length >= MESSAGE_LIMIT) return refused("limit");
    if (!conversation) {
      conversation = await store.create(repositoryId, { provider: provider(), model: null, title: "Grant follow-ups", grant });
      if (!conversation) return refused("limit");
    }
    const message = { id: `m-${conversation.messages.length + 1}`, role: "agent", text, at: now().toISOString(), provider: conversation.provider, model: null, status: "complete", grantFollowUp: true };
    if (!await store.save(repositoryId, { ...conversation, updatedAt: message.at, messages: [...conversation.messages, message] })) {
      if (conversation.messages.length === 0) await store.remove(repositoryId, conversation.id);
      return UNAVAILABLE;
    }
    return { ok: true, conversationId: conversation.id, messageId: message.id, text };
  };
}
