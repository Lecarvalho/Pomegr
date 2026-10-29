import type { AgentChatThreadMessage } from "../../../shared/agent-chat-contract";

// The pure rules of the choices under an answer: which ones can still be tapped, and which one the owner picked.

/**
 * How the choices of one answer are drawn. `active` can be tapped. `waiting` is the newest answer while a turn runs: the buttons are
 * disabled. `past` is quiet text, because the owner sent something after the answer, or a newer answer replaced it.
 */
export type ChoiceMode = "active" | "waiting" | "past";
export type ChoiceState = { mode: ChoiceMode; picked: string | null };

export const RECOMMENDED_LABEL = "Recommended";
export const CHOSEN_LABEL = "Chosen";

const keyOf = (message: { conversationId: string; id: string }) => `${message.conversationId}/${message.id}`;

/**
 * The state of the choices under each answer that has some, by message key. Only the newest answer of Aril's own run can be tapped:
 * a grant follow-up line is not an answer, so it does not close the choices before it. Once the owner sent anything after the answer
 * (`pending` is a message on its way), the choices are past, and `picked` is that message when it was one of the labels.
 */
export function choiceStates(messages: readonly AgentChatThreadMessage[], pending: string | null, running: boolean): Map<string, ChoiceState> {
  const states = new Map<string, ChoiceState>();
  // The nearest message after the one being looked at, leaving grant follow-up lines out.
  let next: AgentChatThreadMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "agent" && message.grantFollowUp) continue;
    if (message.role === "agent" && message.choices) {
      const reply = next === null ? pending : next.role === "user" ? next.text : null;
      const past = next !== null || pending !== null;
      const labels = "replies" in message.choices ? message.choices.replies : message.choices.options.map((option) => option.label);
      states.set(keyOf(message), { mode: past ? "past" : running ? "waiting" : "active", picked: reply !== null && labels.includes(reply.trim()) ? reply.trim() : null });
    }
    next = message;
  }
  return states;
}
