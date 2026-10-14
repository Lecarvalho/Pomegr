import type { DragEvent, ReactNode } from "react";
import type { Task } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { ParallelGlyph } from "./ParallelGlyph";
import { idList, type ReadyParallelGroup } from "./task-ready-groups";

/** What the owner does to a whole group: move it as one block, or end it. */
export type ReadyGroupActions = {
  drag: { onDragStart(event: DragEvent<HTMLLIElement>): void; onDragEnd(): void };
  canMove: { up: boolean; down: boolean };
  onMove(kind: "up" | "down"): void;
  onUngroup(): void;
};

/** One parallel group of the Ready lane: its caption, then its waiting cards in the lane's own order. */
export function ReadyGroup({ group, renderCard, joinTarget = false, actions }: {
  group: ReadyParallelGroup;
  renderCard(task: Task): ReactNode;
  /** The dragged card would join this group. */
  joinTarget?: boolean;
  actions?: ReadyGroupActions;
}) {
  const name = `Parallel group of ${idList(group.tasks.map((task) => task.id))}`;
  return <li className={`taskReadyGroup${joinTarget ? " isJoinTarget" : ""}${actions ? " isMovable" : ""}`} data-ready-group={group.group} data-group-task={group.tasks[0].id}
    draggable={actions ? true : undefined} {...actions?.drag}>
    <div className="taskReadyCaption">
      <span className="taskReadyMode">
        <ParallelGlyph />
        <span>Parallel · <span className="taskReadyCount">{group.tasks.length}</span></span>
        {group.started.length > 0 && <span className="taskReadyStarted"> · <span className="taskReadyCount">{idList(group.started)}</span> started</span>}
      </span>
      {actions && <span className="taskReadyActions" role="toolbar" aria-label={name}>
        {(["up", "down"] as const).map((kind) => <button key={kind} type="button" className="commandIconAction taskMove" data-group-move={kind} data-move={kind}
          aria-label={`Move the group ${kind}`} title={`Move the group ${kind}`} disabled={!actions.canMove[kind]} onClick={() => actions.onMove(kind)}>
          <CommandIcon name="arrow" />
        </button>)}
        <button type="button" className="commandQuietAction taskReadyUngroup" onClick={actions.onUngroup}>Ungroup</button>
      </span>}
    </div>
    <ul className="taskReadyCards" aria-label={name}>{group.tasks.map(renderCard)}</ul>
  </li>;
}

/** The action between two waiting cards of Ready that puts them in one parallel group. */
export function ReadyLink({ ids, onLink }: { ids: readonly string[]; onLink(): void }) {
  return <li className="taskReadyLink" data-ready-link={ids.join(" ")}>
    <button type="button" className="commandQuietAction taskReadyLinkAction" aria-label={`Run ${idList(ids)} in parallel`} onClick={onLink}>
      <ParallelGlyph />Run in parallel
    </button>
  </li>;
}
