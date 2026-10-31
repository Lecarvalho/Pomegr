"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { TaskHomeBoard } from "../../../shared/task-contract";
import { refreshTaskHome } from "../../tasks-home-store";
import { CommandSwitch } from "../command-center/CommandSwitch";
import { QUEUE_SETTINGS_FAILURE_MESSAGE, setDesktopQueue, type TaskEditAvailability } from "./task-desktop";
import { taskBoardHref } from "./task-board-href";
import { STAGES, boardDetail, flowSegments, movingLine, queueIsOn, queueWord, type OverviewCard, type OverviewQuiet, type StageTone } from "./tasks-overview-model";
import { TasksOverviewNewTask } from "./TasksOverviewNewTask";
import { relativeTime, sessionListTime } from "../../dashboard-utils";
import styles from "./TasksOverview.module.css";

const TONES: Record<StageTone, string> = { backlog: styles.toneBacklog, ready: styles.toneReady, progress: styles.toneProgress, review: styles.toneReview, done: styles.toneDone };
const WORD_TONES = { on: styles.isOn, off: "", paused: styles.isPaused, blocked: styles.isBlocked } as const;

/**
 * The queue of one board: its state in words, and the switch the Board's Queue control is, with the same action and the same rules. The desktop app and a
 * paired device draw the switch; any other client reads the word only. On stays pressed while the queue is blocked or paused, and a paused queue also
 * offers to try again, as pressing On does on the Board. The switch changes only when the committed home says so, so it is disabled while the action runs.
 */
function CardQueue({ repositoryId, queue, name, editable }: { repositoryId: string; queue: TaskHomeBoard["queue"]; name: string; editable: boolean }) {
  const wordId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const word = queueWord(queue);
  const set = async (on: boolean) => {
    setBusy(true);
    setFailed(false);
    const result = await setDesktopQueue(repositoryId, on);
    if (result.ok) await refreshTaskHome();
    else setFailed(true);
    setBusy(false);
  };
  return <>
    <div className={styles.queue}>
      <span id={wordId} className={`${styles.queueWord} ${WORD_TONES[word.tone]}`}>{word.text}</span>
      {editable && queue.status === "paused" && <button type="button" className={styles.retry} disabled={busy} onClick={() => { void set(true); }}>Retry <span className="commandVisuallyHidden">the queue of {name}</span></button>}
      {editable && <CommandSwitch small checked={queueIsOn(queue.status)} disabled={busy} aria-label={`Queue of ${name}`} aria-describedby={wordId} onChange={(on) => { void set(on); }} />}
    </div>
    {failed && <p className={styles.failure} role="status">{QUEUE_SETTINGS_FAILURE_MESSAGE}</p>}
  </>;
}

function BoardCard({ card: { repository, board }, access }: { card: OverviewCard; access: TaskEditAvailability }) {
  const headingId = useId();
  const segments = flowSegments(board.counts);
  const line = movingLine(board);
  const editable = access === "desktop" || access === "paired";
  return <article className={styles.board} aria-labelledby={headingId}>
    <div className={styles.boardHead}>
      <div className={styles.boardTitle}>
        <h3 id={headingId} title={repository.displayName}>{repository.displayName}</h3>
        <p className={styles.boardSub}>{boardDetail(board)}{board.updatedAt && <> · changed <time dateTime={board.updatedAt} title={sessionListTime(board.updatedAt)}>{relativeTime(board.updatedAt)}</time></>}</p>
      </div>
      <CardQueue repositoryId={repository.id} queue={board.queue} name={repository.displayName} editable={editable} />
    </div>
    <div className={styles.flow} role="img" aria-label={STAGES.map(({ name }, index) => `${board.counts[index]} ${name}`).join(", ")}>
      {segments.map((segment) => <div key={segment.stage} className={`${styles.segment} ${TONES[segment.tone]}`} style={{ width: segment.width }} data-stage={segment.stage} />)}
    </div>
    <dl className={styles.counts}>
      {STAGES.map(({ name, tone }, index) => {
        const count = board.counts[index] ?? 0;
        return <div key={name} className={styles.countCell}>
          <dt>{name}</dt>
          <dd className={`${styles.count}${count === 0 ? ` ${styles.isZero}` : tone === "review" ? ` ${styles.isReview}` : ""}`}>{count}</dd>
        </div>;
      })}
    </dl>
    <div className={styles.foot}>
      <span className={styles.now}>
        {line.moving && <span className={styles.pulse} aria-hidden="true" />}
        <span className={styles.nowText}>{line.text}</span>
      </span>
      <Link className={styles.open} href={taskBoardHref(repository.id)}>Open board <span className="commandVisuallyHidden">of {repository.displayName}</span> <span aria-hidden="true">→</span></Link>
    </div>
  </article>;
}

function QuietBoard({ quiet: { repository, unavailable } }: { quiet: OverviewQuiet }) {
  return <li className={styles.quiet}>
    <span className={styles.quietName} title={repository.displayName}>{repository.displayName}</span>
    <span className={styles.quietNote}>{unavailable ? "Board unavailable" : "No tasks yet"}</span>
    {!unavailable && <TasksOverviewNewTask repositoryId={repository.id} repositoryName={repository.displayName} />}
  </li>;
}

/** The stage colors, once, in the section header. */
function Legend() {
  return <ul className={styles.legend} aria-label="Stages">
    {STAGES.map(({ name, tone }) => <li key={name} className={`${styles.legendItem} ${TONES[tone]}`}><span className={styles.swatch} aria-hidden="true" />{name}</li>)}
  </ul>;
}

export function TasksOverviewBoards({ cards, quiet, access, enter }: { cards: OverviewCard[]; quiet: OverviewQuiet[]; access: TaskEditAvailability; enter: number }) {
  const headingId = useId();
  return <section className={styles.enter} style={{ "--enter": enter } as React.CSSProperties} aria-labelledby={headingId}>
    <div className={styles.boardsHead}>
      <h2 id={headingId}>Boards</h2>
      {cards.length > 0 && <Legend />}
    </div>
    {cards.length > 0 && <div className={styles.grid}>
      {cards.map((card) => <BoardCard key={card.repository.id} card={card} access={access} />)}
    </div>}
    {quiet.length > 0 && <ul className={styles.quietGrid} aria-label="Boards with no tasks">
      {quiet.map((entry) => <QuietBoard key={entry.repository.id} quiet={entry} />)}
    </ul>}
  </section>;
}
