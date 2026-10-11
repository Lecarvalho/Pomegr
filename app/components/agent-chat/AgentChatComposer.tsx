"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { CommandSelect, type CommandSelectOption } from "../command-center/CommandSelect";
import { COUNTER_SHOWN_FROM, MESSAGE_LIMIT, formatCount } from "./agent-chat-presentation";

export type AgentChatComposerProps = {
  value: string;
  onChange(value: string): void;
  /** Sends the trimmed text; the composer has already checked that sending is allowed. */
  onSend(): void;
  onStop(): void;
  runOptions: ReadonlyArray<CommandSelectOption>;
  runValue: string;
  onRunChange(value: string): void;
  /** No repository, so nothing can be asked. */
  disabled?: boolean;
  /** An answer is being written in the open conversation: Stop replaces Send. */
  running: boolean;
  /** A message is on its way, or an answer is being written elsewhere in this repository. */
  busy: boolean;
  runningElsewhere: boolean;
  /** One fixed line for the last refused operation. */
  error: string | null;
  ref?: Ref<AgentChatComposerHandle>;
};

export type AgentChatComposerHandle = {
  /** Puts the caret at the end of the message and focuses the field, without scrolling the page. */
  focus(): void;
};

/** The message field, the Run on choice, and Send, or Stop while an answer is being written. */
export function AgentChatComposer({ value, onChange, onSend, onStop, runOptions, runValue, onRunChange, disabled = false, running, busy, runningElsewhere, error, ref }: AgentChatComposerProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const length = value.length;
  const over = length > MESSAGE_LIMIT;
  const canSend = !disabled && !busy && !runningElsewhere && !running && value.trim() !== "" && !over;

  // One row that grows with the text; the stylesheet caps it at six rows, then it scrolls.
  useLayoutEffect(() => {
    const field = own.current;
    if (!field) return;
    field.style.height = "auto";
    if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight + (field.offsetHeight - field.clientHeight)}px`;
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus() {
      const field = own.current;
      if (!field || field.disabled) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    },
  }), []);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; a key that confirms an IME composition is never a send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return <form className="agentChatComposer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}>
    {error && <p className="agentChatError" role="alert">{error}</p>}
    {runningElsewhere && <p className="agentChatNote">Aril is answering in another conversation.</p>}
    <textarea ref={own} className="agentChatField" aria-label="Message Aril" placeholder="Ask about this board…" rows={1}
      value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} onKeyDown={keyDown} />
    <div className="agentChatComposerRow">
      <CommandSelect className="agentChatRun" aria-label="Run on" options={runOptions} value={runValue} disabled={disabled} onChange={onRunChange} />
      <span className="agentChatSpacer" />
      {length > COUNTER_SHOWN_FROM && <span className={`agentChatCounter${over ? " isOver" : ""}`}>{`${formatCount(length)} / ${formatCount(MESSAGE_LIMIT)}`}</span>}
      {running
        ? <button type="button" className="commandSecondaryAction" onClick={onStop}>Stop</button>
        : <button type="submit" className="commandSecondaryAction" disabled={!canSend}>Send</button>}
    </div>
  </form>;
}
