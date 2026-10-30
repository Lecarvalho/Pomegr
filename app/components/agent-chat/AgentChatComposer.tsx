"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { AGENT_CHAT_BOUNDS } from "../../../shared/agent-chat-contract";
import type { TaskEffort } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { CommandSelect, type CommandSelectOption } from "../command-center/CommandSelect";
import { AgentChatImageAttach, AgentChatImageStrip } from "./AgentChatImages";
import type { AgentChatImageUrls } from "./agent-chat-images";
import { COUNTER_SHOWN_FROM, MESSAGE_LIMIT, formatCount } from "./agent-chat-presentation";
import { CHAT_EFFORT_OPTIONS, isChatEffort } from "./agent-chat-run";

const NO_IMAGES: readonly string[] = [];
const NO_REPOSITORIES: ReadonlyArray<CommandSelectOption> = [];
const NO_URLS: AgentChatImageUrls = new Map();
const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

export type AgentChatComposerProps = {
  value: string;
  onChange(value: string): void;
  /** Sends the trimmed text; the composer has already checked that sending is allowed. */
  onSend(): void;
  onStop(): void;
  /** The message field gained or lost focus, whatever moved it. The panel asks the desktop to keep a run ready while it has focus; the field itself changes in no way. */
  onFieldFocusChange?(focused: boolean): void;
  /** The named models of each provider, grouped by provider; never a default. */
  modelOptions: ReadonlyArray<CommandSelectOption>;
  modelValue: string;
  onModelChange(value: string): void;
  effort: TaskEffort;
  onEffortChange(effort: TaskEffort): void;
  /** The repositories the chat can belong to, with the one chosen. The choice is drawn only when more than one is listed. */
  repositories?: ReadonlyArray<CommandSelectOption>;
  repositoryId?: string;
  onRepositoryChange?(repositoryId: string): void;
  /** No repository, so nothing can be asked. */
  disabled?: boolean;
  /** An answer is being written in the thread: Stop replaces Send. */
  running: boolean;
  /** A message is on its way. */
  busy: boolean;
  /** One fixed line for the last refused operation. */
  error: string | null;
  /** The images of the message being written, in the order the owner added them. */
  images?: readonly string[];
  imageUrls?: AgentChatImageUrls;
  /** An image is on its way to the desktop app, so the message cannot be sent yet. */
  uploading?: boolean;
  /** One fixed line for the last image that could not be added. */
  imageError?: string | null;
  /** Absent where no image can be added. */
  onAttach?(files: File[]): void;
  onRemoveImage?(imageId: string): void;
  ref?: Ref<AgentChatComposerHandle>;
};

export type AgentChatComposerHandle = {
  /** Puts the caret at the end of the message and focuses the field, without scrolling the page. */
  focus(): void;
};

/** The message field, the repository, model, and effort choices, and Send, or Stop while an answer is being written. */
export function AgentChatComposer({ value, onChange, onSend, onStop, onFieldFocusChange, modelOptions, modelValue, onModelChange, effort, onEffortChange, repositories = NO_REPOSITORIES, repositoryId, onRepositoryChange, disabled = false, running, busy, error, images = NO_IMAGES, imageUrls = NO_URLS, uploading = false, imageError = null, onAttach, onRemoveImage, ref }: AgentChatComposerProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const length = value.length;
  const over = length > MESSAGE_LIMIT;
  const canSend = !disabled && !busy && !running && !uploading && value.trim() !== "" && !over;
  const canAttach = !disabled && onAttach !== undefined;
  const attach = (files: File[]) => { if (canAttach && files.length > 0) onAttach(files); };

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

  return <form className="agentChatComposer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}
    onDragOver={(event) => { if (canAttach && [...event.dataTransfer.types].includes("Files")) event.preventDefault(); }}
    onDrop={(event) => {
      if (!canAttach || event.dataTransfer.files.length === 0) return;
      // A dropped file is never opened or typed as its path.
      event.preventDefault();
      attach(imageFiles(event.dataTransfer.files));
    }}>
    {error && <p className="agentChatError" role="alert">{error}</p>}
    {imageError && <p className="agentChatError" role="alert">{imageError}</p>}
    <textarea ref={own} className="agentChatField" aria-label="Message Aril" placeholder="Ask Aril…" rows={1}
      value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} onKeyDown={keyDown} onFocus={() => onFieldFocusChange?.(true)} onBlur={() => onFieldFocusChange?.(false)}
      onPaste={(event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (!canAttach || files.length === 0) return;
        event.preventDefault();
        attach(files);
      }} />
    <AgentChatImageStrip imageIds={images} urls={imageUrls} label="Images to send" onRemove={onRemoveImage} />
    {uploading && <p className="agentChatNote" role="status">Adding image…</p>}
    <div className="agentChatComposerRow">
      <AgentChatImageAttach disabled={!canAttach || images.length >= AGENT_CHAT_BOUNDS.imagesPerMessage} onAttach={attach} />
      {repositories.length > 1 && repositoryId !== undefined && onRepositoryChange && <CommandSelect className="agentChatRepository" aria-label="Repository" options={repositories} value={repositoryId} onChange={onRepositoryChange} />}
      <span className="agentChatSpacer" />
      <CommandSelect className="agentChatModel" aria-label="Model" groupInValue={false} options={modelOptions} value={modelValue} disabled={disabled} onChange={onModelChange} />
      <CommandSelect className="agentChatEffort" aria-label="Effort" options={CHAT_EFFORT_OPTIONS} value={effort} disabled={disabled} onChange={(next) => { if (isChatEffort(next)) onEffortChange(next); }} />
      {length > COUNTER_SHOWN_FROM && <span className={`agentChatCounter${over ? " isOver" : ""}`}>{`${formatCount(length)} / ${formatCount(MESSAGE_LIMIT)}`}</span>}
      {running
        ? <button key="stop" type="button" className="commandIconAction agentChatSend" aria-label="Stop" title="Stop" onClick={onStop}><CommandIcon name="stop" /></button>
        : <button key="send" type="submit" className="commandIconAction agentChatSend" aria-label="Send" title="Send" disabled={!canSend}><CommandIcon name="send" /></button>}
    </div>
  </form>;
}
