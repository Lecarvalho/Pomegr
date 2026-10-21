import Link from "next/link";
import { taskSessionHref } from "./task-presentation";

/** The Open session link. With `arrow` it ends with the 12px arrow-up-right glyph that a link to another page carries on the board card. */
export function TaskSessionLink({ sessionId, className, arrow = false }: { sessionId: string; className?: string; arrow?: boolean }) {
  const href = taskSessionHref(sessionId);
  return href === null ? null : <Link className={`commandTextLink${className ? ` ${className}` : ""}`} href={href}>
    Open session
    {arrow && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 11l6-6M6 5h5v5" /></svg>}
  </Link>;
}
