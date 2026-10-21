import { TaskSessionLink } from "./TaskSessionLink";
import { taskSessionHref } from "./task-presentation";

/** The started session in the task modal: its catalog title when it names the task, and the link to open it. Nothing when it has neither. */
export function TaskSessionLine({ title, sessionId }: { title: string | null; sessionId: string | null }) {
  const hasLink = sessionId !== null && taskSessionHref(sessionId) !== null;
  if (title === null && !hasLink) return null;
  return <div className="taskModalSession">
    {title !== null && <p className="taskModalSessionTitle">{title}</p>}
    <span className="newTaskHelper">
      {title !== null && <>Title from the session{hasLink && " · "}</>}
      {sessionId !== null && <TaskSessionLink sessionId={sessionId} />}
    </span>
  </div>;
}
