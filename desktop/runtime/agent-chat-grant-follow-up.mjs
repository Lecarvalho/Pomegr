// Grant follow-ups: one fixed line, built here from task-log facts, appended to the repository's follow-up conversation. No
// provider runs, and the message never proposes, applies, or starts anything.

import { ARIL_FOLLOW_UP_END_REASONS, ARIL_FOLLOW_UP_ITEMS, arilFollowUpText, normalizeArilFollowUpItem } from "../../shared/aril-follow-up.mjs";
import { MESSAGE_LIMIT, nextMessageId } from "./agent-chat-store.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");
const UNAVAILABLE = refused("unavailable");
const NO_MARK = Object.freeze({ grant: null, through: null, ended: null, messageId: null });

/**
 * The chat's writer of grant follow-ups. `busy(repositoryId, conversationId)` answers whether that conversation is
 * answering or about to; `provider()` answers the provider a new follow-up conversation keeps for the owner's replies.
 * Every grant of a repository writes into one conversation, and a new one only when it is full. A follow-up already written
 * (`grant`, `through`, `ended`) answers its own message again, so a settle the monitor never received writes no second line.
 */
export function createGrantFollowUps({ store, now, busy, provider }) {
  return async function grantFollowUp({ repositoryId, grant, through, items, more, ended } = {}) {
    if (!store) return UNAVAILABLE;
    const facts = Array.isArray(items) && items.length <= ARIL_FOLLOW_UP_ITEMS ? items.map(normalizeArilFollowUpItem) : null;
    if (!REPOSITORY_ID.test(String(repositoryId)) || !Number.isSafeInteger(grant) || grant < 1 || !Number.isSafeInteger(through) || through < 0
      || !facts || facts.some((item) => item === null)
      || !Number.isSafeInteger(more) || more < 0 || !(ended === null || ARIL_FOLLOW_UP_END_REASONS.includes(ended)) || (facts.length === 0 && ended === null)) return INVALID;
    const text = arilFollowUpText({ items: facts, more, ended });
    const held = (await store.index(repositoryId)).filter((entry) => entry.grantFollowUps !== undefined)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const written = held.find(({ grantFollowUps: mark }) => mark.grant === grant && mark.through === through && mark.ended === ended);
    if (written) return { ok: true, conversationId: written.id, messageId: written.grantFollowUps.messageId, text };
    let conversation = held[0] && held[0].messages < MESSAGE_LIMIT ? await store.read(repositoryId, held[0].id) : null;
    // `busy` asks again on the runner's next tick.
    if (conversation && busy(repositoryId, conversation.id)) return refused("busy");
    if (!conversation) {
      conversation = await store.create(repositoryId, { provider: provider(), model: null, title: "Grant follow-ups", grantFollowUps: NO_MARK });
      if (!conversation) return UNAVAILABLE;
    }
    const message = { id: nextMessageId(conversation.messages), role: "agent", text, at: now().toISOString(), provider: conversation.provider, model: null, status: "complete", grantFollowUp: true };
    const grantFollowUps = { grant, through, ended, messageId: message.id };
    if (!await store.save(repositoryId, { ...conversation, updatedAt: message.at, grantFollowUps, messages: [...conversation.messages, message] })) {
      if (conversation.messages.length === 0) await store.remove(repositoryId, conversation.id);
      return UNAVAILABLE;
    }
    return { ok: true, conversationId: conversation.id, messageId: message.id, text };
  };
}
