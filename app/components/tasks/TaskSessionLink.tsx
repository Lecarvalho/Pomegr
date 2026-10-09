import Link from "next/link";
import { taskSessionHref } from "./task-presentation";

/** "Open session" (D75): the Text link role to the session view, built like the Sessions list builds its row link. */
export function TaskSessionLink({ sessionId, className }: { sessionId: string; className?: string }) {
  const href = taskSessionHref(sessionId);
  return href === null ? null : <Link className={`commandTextLink${className ? ` ${className}` : ""}`} href={href}>Open session</Link>;
}
