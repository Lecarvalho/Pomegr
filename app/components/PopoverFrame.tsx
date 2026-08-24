import type { ReactNode, RefObject } from "react";
import { CloseButton } from "./CloseButton";

export function PopoverFrame({ id, ariaLabel, eyebrow, title, closeLabel, onClose, summary, children, actions, className = "", containerRef }: {
  id: string;
  ariaLabel: string;
  eyebrow: string;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  summary?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className={`agentPopover ${className}`.trim()} id={id} role="dialog" aria-label={ariaLabel} ref={containerRef}>
      <div className="agentPopoverHeader">
        <div><span className="label">{eyebrow}</span><strong>{title}</strong></div>
        <div className="agentPopoverActions">{actions}<CloseButton label={closeLabel} onClick={onClose} /></div>
      </div>
      {summary !== undefined && <p className="agentPopoverIntro">{summary}</p>}
      {children}
    </div>
  );
}
