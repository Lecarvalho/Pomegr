"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Shared phone surface; cache evidence may portal beside it above the modal. */
export function InspectorSheet({ title, subtitle, onClose, action, children }: { title: string; subtitle?: string; onClose: () => void; action?: ReactNode; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== surface.current && !element.matches(".cacheRefillPopover"));
    const inert = siblings.map((element) => element.inert);
    siblings.forEach((element) => { element.inert = true; });
    document.body.style.overflow = "hidden";
    back.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      const popover = document.querySelector<HTMLElement>(".cacheRefillPopover");
      if (event.key === "Escape" && !popover) { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const root = popover || surface.current;
      const controls = root ? [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]')].filter((item) => !item.hidden) : [];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = overflow;
      siblings.forEach((element, index) => { element.inert = inert[index]; });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div ref={surface} className="agentInspectorSheet" role="dialog" aria-modal="true" aria-label={title}>
    <header className="inspectorSheetHeader"><button ref={back} type="button" onClick={onClose} aria-label="Back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg></button><div><strong dir="auto">{title}</strong>{subtitle && <span>{subtitle}</span>}</div>{action}</header>
    {children}
  </div>, document.body);
}
