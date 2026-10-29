"use client";

import { useId, type MouseEvent } from "react";
import type { AgentChatChoices } from "../../../shared/agent-chat-contract";
import { CHOSEN_LABEL, RECOMMENDED_LABEL, type ChoiceState } from "./agent-chat-choices";

/** Taps send the label as the owner's own message. `byKeyboard` is true for a click the keyboard made, so the caller can keep focus in the field. */
export type ChooseChoice = (label: string, byKeyboard: boolean) => void;

const Chip = ({ children }: { children: string }) => <span className="commandChip">{children}</span>;

/**
 * What Aril offers under an answer: quick replies, or one multiple-choice question with its options. Choices that can be tapped are
 * Quiet buttons; once the owner has answered, or a newer answer came, they are quiet text and the one picked is marked.
 */
export function AgentChatChoicesView({ choices, state, onChoose }: { choices: AgentChatChoices; state: ChoiceState; onChoose?: ChooseChoice }) {
  const questionId = useId();
  const past = state.mode === "past";
  const choose = (label: string) => (event: MouseEvent<HTMLButtonElement>) => onChoose?.(label, event.detail === 0);
  const picked = (label: string) => state.picked === label;

  if ("replies" in choices) {
    return <ul className={`agentChatReplies${past ? " isPast" : ""}`} aria-label={past ? "Quick replies, answered" : "Quick replies"}>
      {choices.replies.map((label) => <li key={label}>
        {past
          ? <span className={`agentChatReply isPast${picked(label) ? " isPicked" : ""}`}>{label}{picked(label) && <Chip>{CHOSEN_LABEL}</Chip>}</span>
          : <button type="button" className="commandQuietAction agentChatReply" disabled={state.mode === "waiting"} onClick={choose(label)}>{label}</button>}
      </li>)}
    </ul>;
  }

  return <div className="agentChatQuestion" role="group" aria-labelledby={questionId}>
    <p id={questionId} className="agentChatQuestionText">{choices.question}</p>
    <ul className={`agentChatChoices${past ? " isPast" : ""}`}>
      {choices.options.map((option, index) => {
        const body = <>
          <span className="agentChatChoiceLabel">{option.label}{index === 0 && <Chip>{RECOMMENDED_LABEL}</Chip>}{past && picked(option.label) && <Chip>{CHOSEN_LABEL}</Chip>}</span>
          <span className="agentChatChoiceDetail">{option.detail}</span>
        </>;
        return <li key={option.label}>
          {past
            ? <span className={`agentChatChoice isPast${picked(option.label) ? " isPicked" : ""}`}>{body}</span>
            : <button type="button" className="commandQuietAction agentChatChoice" disabled={state.mode === "waiting"} onClick={choose(option.label)}>{body}</button>}
        </li>;
      })}
    </ul>
  </div>;
}
