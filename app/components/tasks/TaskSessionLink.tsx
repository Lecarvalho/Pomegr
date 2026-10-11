import Link from "next/link";
import { taskSessionHref } from "./task-presentation";

export function TaskSessionLink({ sessionId, className }: { sessionId: string; className?: string }) {
  const href = taskSessionHref(sessionId);
  return href === null ? null : <Link className={`commandTextLink${className ? ` ${className}` : ""}`} href={href}>Open session</Link>;
}
