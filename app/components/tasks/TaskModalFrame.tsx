"use client";

import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CommandIcon } from "../command-center/CommandIcon";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

type ChromeProps = {
  titleId: string;
  title: string;
  titleExtra?: ReactNode;
  subtitle?: string | null;
  closeRef?: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
};

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

/** The native modal dialog under the task modal and the Queue settings panel: it traps Tab and closes on Escape. */
export function TaskDialog({ className, labelledBy, closeOnScrim = false, onClose, children }: {
  className: string;
  labelledBy: string;
  closeOnScrim?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const pressedScrim = useRef(false);
  const showDialog = useCallback((node: HTMLDialogElement | null) => {
    dialog.current = node;
    if (!node || node.open) return;
    if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", "");
  }, []);

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
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return <dialog ref={showDialog} className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
    onKeyDown={keyDown} onMouseDown={(event) => { pressedScrim.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (closeOnScrim && pressedScrim.current && event.target === event.currentTarget) onClose(); }} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}

/** A modal dialog over the page. */
export function TaskModalFrame({ title, titleExtra, subtitle, initialFocus, closeOnScrim = false, onClose, footer, children }: Omit<ChromeProps, "titleId" | "closeRef"> & {
  initialFocus?: RefObject<{ focus(options?: FocusOptions): void } | null>;
  closeOnScrim?: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { (initialFocus?.current ?? closeRef.current)?.focus({ preventScroll: true }); }, [initialFocus]);
  return <TaskDialog className="taskModalScrim" labelledBy={titleId} closeOnScrim={closeOnScrim} onClose={onClose}>
    <TaskModalChrome titleId={titleId} title={title} titleExtra={titleExtra} subtitle={subtitle} closeRef={closeRef} onClose={onClose} footer={footer}>{children}</TaskModalChrome>
  </TaskDialog>;
}
