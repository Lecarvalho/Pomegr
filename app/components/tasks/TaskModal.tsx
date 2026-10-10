"use client";

import type { Task } from "../../../shared/task-contract";
import { TaskModalEdit } from "./TaskModalEdit";
import { TaskModalNew } from "./TaskModalNew";
import { TaskModalPromote } from "./TaskModalPromote";
import type { TaskIssue } from "./task-issues-desktop";
import type { TaskModalBoard } from "./task-modal-types";

// The one task modal (design contract G115-G298). `mode` picks the form that fills the shared frame: a new task, one
// GitHub issue being promoted into a task, or an existing task. Another mode is one more form component and one more
// case below.

type Shared = {
  repositoryId: string;
  repositoryName: string | null;
  /** The committed board: its features and their tasks fill the Feature fields. */
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onClose(): void;
};

export type TaskModalProps = Shared & (
  | { mode: "new"; onCreated(): void }
  | { mode: "issue"; issue: TaskIssue; onReload(): Promise<void>; onPromoted(taskId: string): void }
  | { mode: "edit"; task: Task; onOpenTask?: (task: Task, opener: HTMLElement) => void; onChanged(): void; onDeleted(): void }
);

export function TaskModal(props: TaskModalProps) {
  switch (props.mode) {
    case "new": {
      const { repositoryId, repositoryName, board, refresh, onCreated, onClose } = props;
      return <TaskModalNew repositoryId={repositoryId} repositoryName={repositoryName} board={board} refresh={refresh} onCreated={onCreated} onClose={onClose} />;
    }
    case "issue": {
      const { repositoryId, repositoryName, issue, board, refresh, onReload, onPromoted, onClose } = props;
      return <TaskModalPromote repositoryId={repositoryId} repositoryName={repositoryName} issue={issue} board={board} refresh={refresh}
        onReload={onReload} onPromoted={onPromoted} onClose={onClose} />;
    }
    case "edit": {
      const { repositoryId, repositoryName, task, board, refresh, onOpenTask, onChanged, onDeleted, onClose } = props;
      return <TaskModalEdit repositoryId={repositoryId} repositoryName={repositoryName} task={task} board={board} refresh={refresh}
        onOpenTask={onOpenTask} onChanged={onChanged} onDeleted={onDeleted} onClose={onClose} />;
    }
  }
}
