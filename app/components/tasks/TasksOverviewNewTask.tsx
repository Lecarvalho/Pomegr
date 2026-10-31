"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { refreshTaskHome } from "../../tasks-home-store";
import { useTasks } from "../../tasks-store";
import { useTaskEditAvailability } from "./task-desktop";
import { taskBoardHref } from "./task-board-href";
import { TaskModal } from "./TaskModal";
import styles from "./TasksOverview.module.css";

// The board is read only once the owner asks for the dialog, so a page of many quiet repositories reads none. The dialog opens when the board answers,
// so its subtitle names the first column from the start and never changes.
function NewTaskDialog({ repositoryId, repositoryName, onClose }: { repositoryId: string; repositoryName: string; onClose(): void }) {
  const router = useRouter();
  const { board, refresh } = useTasks(repositoryId);
  if (board.readiness !== "ready") return null;
  return <TaskModal mode="new" repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh}
    onCreated={() => { void refreshTaskHome(); }}
    // A follow-up that failed is worded on the board, where the new card is.
    onFollowUpFailed={() => { onClose(); router.push(taskBoardHref(repositoryId)); }}
    onClose={onClose} />;
}

/**
 * **+ New task** on a board with no task. It opens the same new-task dialog the board does, in the desktop app and on a paired device. Any other client
 * is not drawn the action, and so is a client that does not yet know which it is, so the action never appears and then goes.
 */
export function TasksOverviewNewTask({ repositoryId, repositoryName }: { repositoryId: string; repositoryName: string }) {
  const access = useTaskEditAvailability();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (access !== "desktop" && access !== "paired") return null;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} type="button" className={styles.newTask} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      + New task <span className="commandVisuallyHidden">in {repositoryName}</span>
    </button>
    {open && <NewTaskDialog repositoryId={repositoryId} repositoryName={repositoryName} onClose={close} />}
  </>;
}
