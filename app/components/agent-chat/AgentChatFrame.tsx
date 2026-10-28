"use client";

import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { CommandIcon } from "../command-center/CommandIcon";

export const PANEL_LABEL = "Aril, the Pomegr agent";

/** The panel: a non-modal region docked to the right edge, below the shell header (or expanded over the content area), or a full-screen sheet on a phone. */
export function AgentChatPanelFrame({ id, open = true, isStatic = false, expanded = false, panelRef, onKeyDown, children }: {
  id?: string;
  open?: boolean;
  /** Draws in the page's flow instead of fixed to the window; for the design-system reference. */
  isStatic?: boolean;
  /** Covers the content area, with the log and the composer in a centered column. */
  expanded?: boolean;
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children?: ReactNode;
}) {
  return <section ref={panelRef} id={id} className={`agentChatPanel${isStatic ? " isStatic" : ""}${expanded ? " isExpanded" : ""}`} aria-label={PANEL_LABEL} hidden={!open} onKeyDown={onKeyDown}>{children}</section>;
}

export function AgentChatHeader({ searchOpen, onToggleSearch, searchRef, searchControls, expanded, onToggleExpanded, onClose, disabled = false }: {
  searchOpen: boolean;
  onToggleSearch(): void;
  searchRef?: Ref<HTMLButtonElement>;
  /** The ID of the search region the action opens. */
  searchControls?: string;
  expanded: boolean;
  onToggleExpanded(): void;
  onClose(): void;
  disabled?: boolean;
}) {
  return <header className="agentChatHeader">
    <span className="agentChatGlyph"><CommandIcon name="spark" /></span>
    <h2 className="agentChatTitle">Aril</h2>
    <span className="agentChatSpacer" />
    <button ref={searchRef} type="button" className="commandIconAction" aria-label="Search" title="Search" aria-pressed={searchOpen} aria-controls={searchOpen ? searchControls : undefined} disabled={disabled} onClick={onToggleSearch}><CommandIcon name="search" /></button>
    <button type="button" className="commandIconAction agentChatExpand" aria-label={expanded ? "Dock" : "Expand"} title={expanded ? "Dock" : "Expand"} aria-pressed={expanded} onClick={onToggleExpanded}><CommandIcon name={expanded ? "dock" : "expand"} /></button>
    <button type="button" className="commandIconAction" aria-label="Close Aril" title="Close Aril" data-close="" onClick={onClose}><CommandIcon name="close" /></button>
  </header>;
}

/** The light dim over the page behind the open panel. A click on it closes the panel; the keyboard has Close and Escape, so it is out of the tab order. */
export function AgentChatScrim({ isStatic = false, onClick }: { isStatic?: boolean; onClick?(): void }) {
  return <button type="button" className={`agentChatScrim${isStatic ? " isStatic" : ""}`} tabIndex={-1} aria-hidden="true" onClick={onClick} />;
}

export type AgentChatLauncherState = { answering: boolean; fresh: boolean };

/** The Aril button at the bottom right; shown only while the panel is closed. */
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
