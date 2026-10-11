"use client";

import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { CommandSelect, type CommandSelectOption } from "../command-center/CommandSelect";

export const PANEL_LABEL = "Aril, the Pomegr agent";

/** The floating panel: a non-modal region fixed to the bottom right, or a full-screen sheet on a phone. */
export function AgentChatPanelFrame({ id, open = true, isStatic = false, panelRef, onKeyDown, children }: {
  id?: string;
  open?: boolean;
  /** Draws in the page's flow instead of fixed to the window; for the design-system reference. */
  isStatic?: boolean;
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children?: ReactNode;
}) {
  return <section ref={panelRef} id={id} className={`agentChatPanel${isStatic ? " isStatic" : ""}`} aria-label={PANEL_LABEL} hidden={!open} onKeyDown={onKeyDown}>{children}</section>;
}

export function AgentChatHeader({ historyOpen, onToggleHistory, onNew, onMinimize, disabled = false }: {
  historyOpen: boolean;
  onToggleHistory(): void;
  onNew(): void;
  onMinimize(): void;
  disabled?: boolean;
}) {
  return <header className="agentChatHeader">
    <span className="agentChatGlyph"><CommandIcon name="spark" /></span>
    <h2 className="agentChatTitle">Aril</h2>
    <span className="agentChatCaption">Task-board agent</span>
    <span className="agentChatSpacer" />
    <button type="button" className="commandIconAction" aria-label="Conversations" title="Conversations" aria-pressed={historyOpen} disabled={disabled} onClick={onToggleHistory}><CommandIcon name="history" /></button>
    <button type="button" className="commandIconAction" aria-label="New conversation" title="New conversation" disabled={disabled} onClick={onNew}><CommandIcon name="plus" /></button>
    <button type="button" className="commandIconAction" aria-label="Minimize" title="Minimize" data-minimize="" onClick={onMinimize}><CommandIcon name="collapse" /></button>
  </header>;
}

/** The repository the conversations belong to; drawn only when more than one is listed. */
export function AgentChatRepositoryRow({ options, value, onChange }: { options: ReadonlyArray<CommandSelectOption>; value: string; onChange(value: string): void }) {
  return <div className="agentChatRepository"><CommandSelect aria-label="Repository" options={options} value={value} onChange={onChange} /></div>;
}

export type AgentChatLauncherState = { answering: boolean; fresh: boolean };

/** The Aril button at the bottom right; shown only while the panel is minimized. */
export function AgentChatLauncher({ answering, fresh, isStatic = false, expanded = false, controls, buttonRef, onClick }: AgentChatLauncherState & {
  isStatic?: boolean;
  expanded?: boolean;
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick?(): void;
}) {
  const name = `Open Aril, the Pomegr agent${answering ? ", answering" : ""}${fresh ? ", new answer" : ""}`;
  return <button ref={buttonRef} type="button" className={`agentChatLauncher${isStatic ? " isStatic" : ""}`} aria-label={name} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
    <CommandIcon name="spark" />
    <span>{answering ? "Aril · answering…" : "Aril"}</span>
    {fresh && !answering && <i className="agentChatLauncherDot" aria-hidden="true" />}
  </button>;
}
