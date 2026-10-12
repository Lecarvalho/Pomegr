"use client";

import Link from "next/link";
import { useId } from "react";
import { relativeTime, sessionListTime } from "../../dashboard-utils";
import { useTaskHome } from "../../tasks-home-store";
import type { RepositoryInventorySnapshot } from "../../../shared/monitor-contract";
import { DEFAULT_TASK_COLUMNS, type TaskHome, type TaskHomeAttentionState, type TaskHomeBoard } from "../../../shared/task-contract";
import { CommandIcon, CommandPage } from "../command-center/CommandPage";

type Repository = RepositoryInventorySnapshot["repositories"][number];

const DESCRIPTION = "What waits for you across your boards, then one task board for each repository.";
const ATTENTION_LABELS: Record<TaskHomeAttentionState, string> = { needs_review: "Needs review", stalled: "Stalled", blocked: "Blocked by agent" };

export const taskBoardHref = (repositoryId: string) => `/tasks?${new URLSearchParams({ repository: repositoryId })}`;

export function TasksHomeSkeleton() {
  return <div className="taskHomeSkeleton" aria-label="Loading tasks"><span /><span /></div>;
}

function QueueChip({ queue }: { queue: TaskHomeBoard["queue"] }) {
  if (queue.status === "blocked") return <span className="commandChip negative">{queue.blockedBy ? `Blocked by ${queue.blockedBy}` : "Blocked"}</span>;
  if (queue.status === "paused") return <span className="commandChip warning">Paused</span>;
  return <span className={`commandChip${queue.status === "running" ? " taskHomeQueueOn" : ""}`}>{queue.status === "running" ? "On" : "Off"}</span>;
}

function NeedsYou({ home, names }: { home: TaskHome; names: Map<string, string> }) {
  const headingId = useId();
  // A task of a repository the inventory no longer lists has no board to open.
  const items = home.attention.filter((item) => names.has(item.repositoryId));
  const total = home.attentionTotal - (home.attention.length - items.length);
  return <section className="panel taskHomePanel" aria-labelledby={headingId}>
    <div className="taskHomePanelHead"><h2 id={headingId}>Needs you</h2><span className="taskHomeCount">{total}</span></div>
    {items.length === 0 ? <p className="taskHomeEmpty">Nothing waits for you.</p> : <ul className="taskHomeNeeds">
      {items.map((item) => <li key={`${item.repositoryId}:${item.taskId}`}>
        <Link className="taskHomeNeed" href={taskBoardHref(item.repositoryId)}>
          <span className="taskHomeNeedRepository">{names.get(item.repositoryId)}</span>
          <span className="taskHomeNeedId">{item.taskId}</span>
          <span className="taskHomeNeedTitle" title={item.title}>{item.title}</span>
          <span className="commandChip warning">{ATTENTION_LABELS[item.state]}</span>
          <CommandIcon name="chevron" size="small" className="commandIcon taskHomeNeedChevron" />
        </Link>
      </li>)}
    </ul>}
    {total > items.length && <p className="taskHomeEmpty">Showing the newest {items.length} of {total}.</p>}
  </section>;
}

function BoardRow({ repository, board }: { repository: Repository; board: TaskHomeBoard | undefined }) {
  const unavailable = board?.readiness === "unavailable";
  const counts = unavailable ? null : board?.counts ?? DEFAULT_TASK_COLUMNS.map(() => 0);
  const total = counts?.reduce((sum, value) => sum + value, 0) ?? 0;
  const detail = unavailable ? "Board unavailable" : total === 0 ? "No tasks yet" : board && board.openFeatures > 0 ? `${board.openFeatures} open ${board.openFeatures === 1 ? "feature" : "features"}` : "No open feature";
  return <tr className={total === 0 ? "isEmpty" : undefined}>
    <th scope="row">
      <Link className="taskHomeBoardLink" href={taskBoardHref(repository.id)}>{repository.displayName}</Link>
      <span className="taskHomeBoardDetail">{detail}</span>
    </th>
    <td data-label="Queue">{unavailable ? "—" : <QueueChip queue={board?.queue ?? { status: "idle", blockedBy: null, pauseReason: null }} />}</td>
    {DEFAULT_TASK_COLUMNS.map((name, index) => <td className={`taskHomeNumber${counts && counts[index] === 0 ? " isZero" : ""}`} data-label={name} key={name}>{counts ? counts[index] : "—"}</td>)}
    <td className="taskHomeNumber taskHomeChanged" data-label="Last change">
      {board?.updatedAt ? <time dateTime={board.updatedAt} title={sessionListTime(board.updatedAt)}>{relativeTime(board.updatedAt)}</time> : "—"}
    </td>
  </tr>;
}

function Boards({ home, repositories }: { home: TaskHome; repositories: Repository[] }) {
  const headingId = useId();
  const boards = new Map(home.boards.map((board) => [board.repositoryId, board]));
  const changed = (repository: Repository) => Date.parse(boards.get(repository.id)?.updatedAt ?? "") || 0;
  // Boards that changed last come first; the rest keep the inventory's order.
  const rows = [...repositories].sort((left, right) => changed(right) - changed(left));
  return <section className="panel taskHomePanel" aria-labelledby={headingId}>
    <div className="taskHomePanelHead"><h2 id={headingId}>Boards</h2><span className="taskHomeCount">{rows.length}</span></div>
    <div className="taskHomeTableScroller">
      <table className="taskHomeTable">
        <thead><tr>
          <th scope="col">Repository</th>
          <th scope="col">Queue</th>
          {DEFAULT_TASK_COLUMNS.map((name) => <th scope="col" className="taskHomeNumber" key={name}>{name}</th>)}
          <th scope="col" className="taskHomeNumber">Last change</th>
        </tr></thead>
        <tbody>{rows.map((repository) => <BoardRow key={repository.id} repository={repository} board={boards.get(repository.id)} />)}</tbody>
      </table>
    </div>
  </section>;
}

export function TasksHome({ repositories }: { repositories: Repository[] }) {
  const home = useTaskHome();
  const names = new Map(repositories.map((repository) => [repository.id, repository.displayName]));
  return <CommandPage title="Tasks" description={DESCRIPTION} busy={home.readiness === "loading"}>
    <div className="taskHome">
      {home.readiness === "loading" && <TasksHomeSkeleton />}
      {home.readiness === "unavailable" && <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>}
      {home.readiness === "desktop_only" && <section className="panel taskBoardNotice" aria-label="Tasks">
        <span className="commandChip">Desktop only</span>
        <p>Task boards are available in the Pomegr desktop app on this computer.</p>
      </section>}
      {home.readiness === "ready" && <>
        <NeedsYou home={home} names={names} />
        <Boards home={home} repositories={repositories} />
      </>}
    </div>
  </CommandPage>;
}
