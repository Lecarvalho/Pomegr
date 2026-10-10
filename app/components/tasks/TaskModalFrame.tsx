"use client";

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CommandIcon } from "../command-center/CommandIcon";

// The shared frame of the task modal (design contract G115-G123 and G153): a modal dialog holding a header with the
// title, a body, and a footer bar. The New task and Task forms fill it; it owns no task behavior of its own.

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

type ChromeProps = {
  /** The id of the `h2`, which names the dialog. */
  titleId: string;
  title: string;
  /** After the title in the title group: the task ID and state chip of the Task form. */
  titleExtra?: ReactNode;
  /** `{repository} · in {column}`; null or absent leaves the space empty so Close stays at the end. */
  subtitle?: string | null;
  closeRef?: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
};

/** The visible panel without the dialog behavior, so `/design-system` can draw it as static data. */
export function TaskModalChrome({ titleId, title, titleExtra, subtitle, closeRef, onClose, footer, children }: ChromeProps) {
  return <div className="taskModal">
    <header className="taskModalHeader">
      <div className="taskModalTitleGroup">
        <h2 id={titleId}>{title}</h2>
        {titleExtra}
      </div>
      <span className="taskModalSubtitle">{subtitle ?? ""}</span>
      <button ref={closeRef} type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <div className="taskModalBody">{children}</div>
    <div className="taskModalFooter">{footer}</div>
  </div>;
}

/**
 * A modal dialog over the page. The native modal `<dialog>` makes the page behind inert and keeps Tab inside, and a
 * select list opened inside it renders inside it too (`CommandSelect`). Focus moves in on open (the Close action, or
 * `initialFocus`); Escape and Close ask `onClose`, unless a control inside already handled the key. A click on the
 * scrim does nothing, so text typed into the form is never lost to a stray click. There is no entrance or exit motion.
 * Whoever opened the dialog returns focus to its opener once it is gone.
 */
export function TaskModalFrame({ title, titleExtra, subtitle, initialFocus, onClose, footer, children }: Omit<ChromeProps, "titleId" | "closeRef"> & {
  /** The control that takes focus on open; defaults to Close. */
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const showDialog = useCallback((node: HTMLDialogElement | null) => {
    dialog.current = node;
    if (!node || node.open) return;
    if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", "");
  }, []);
  useEffect(() => { (initialFocus?.current ?? closeRef.current)?.focus({ preventScroll: true }); }, [initialFocus]);

  // The browser already keeps Tab in a modal dialog; this wraps explicitly at the ends and gives up if focus does not move.
  const wrapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const target = event.shiftKey ? items[items.length - 1] : items[0];
    const edge = event.shiftKey ? items[0] : items[items.length - 1];
    if (!target || document.activeElement !== edge) return;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) event.preventDefault();
  };
  const keyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Tab" && !event.defaultPrevented) { wrapTab(event); return; }
    // An open list or a feature name being edited has handled Escape already.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return <dialog ref={showDialog} className="taskModalScrim" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
    onKeyDown={keyDown} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <TaskModalChrome titleId={titleId} title={title} titleExtra={titleExtra} subtitle={subtitle} closeRef={closeRef} onClose={onClose} footer={footer}>{children}</TaskModalChrome>
  </dialog>;
}
