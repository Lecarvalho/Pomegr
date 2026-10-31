"use client";

import Link from "next/link";
import { useId } from "react";
import type { TaskHome, TaskHomeAttentionState } from "../../../shared/task-contract";
import { CommandIcon, type CommandIconName } from "../command-center/CommandIcon";
import card from "../home/HomeCard.module.css";
import needs from "../home/HomeNeedsYou.module.css";
import { taskBoardHref } from "./task-board-href";
import styles from "./TasksOverview.module.css";

const ATTENTION_LABELS: Record<TaskHomeAttentionState, string> = { needs_review: "Needs review", stalled: "Stalled", blocked: "Blocked by agent" };
// The glyphs Home draws for the same three kinds of thing.
const GLYPHS: Record<TaskHomeAttentionState, CommandIconName> = { needs_review: "check", stalled: "timer", blocked: "stop" };

/**
 * What waits for the owner on any board, in Home's card: one soft row for each task, with the amber glyph tile, the title, then the ID, the
 * repository, and the state. Each row is one link to the task's board. A task of a repository the inventory does not list is not drawn or counted.
 */
export function TasksOverviewNeeds({ home, names, enter }: { home: TaskHome; names: ReadonlyMap<string, string>; enter: number }) {
  const headingId = useId();
  const items = home.attention.filter((item) => names.has(item.repositoryId));
  const total = home.attentionTotal - (home.attention.length - items.length);
  return <section className={`${card.card} ${needs.needs} ${styles.needs} ${styles.enter}`} style={{ "--enter": enter } as React.CSSProperties} aria-labelledby={headingId}>
    <header className={card.head}><h2 id={headingId}>Needs you</h2></header>
    {items.length === 0 ? <p className={`${card.closing} ${styles.needsEmpty}`}>Nothing waits for you.</p> : <ul className={`${card.list} ${styles.needsList}`}>
      {items.map((item) => <li key={`${item.repositoryId}:${item.taskId}`}>
        <Link className={card.item} href={taskBoardHref(item.repositoryId)}>
          <span className={needs.glyph} aria-hidden="true"><CommandIcon name={GLYPHS[item.state]} size="small" /></span>
          <span className={needs.text}>
            <span className={styles.needTitle} title={item.title}>{item.title}</span>
            <span className={styles.needMeta}><span className={styles.needId}>{item.taskId}</span> · {names.get(item.repositoryId)} · <span className={styles.needState}>{ATTENTION_LABELS[item.state]}</span></span>
          </span>
          <CommandIcon name="chevron" size="small" className={`commandIcon ${needs.chevron}`} />
        </Link>
      </li>)}
    </ul>}
    {total > items.length && <p className={`${card.closing} ${needs.more}`}>Showing the newest {items.length} of {total}.</p>}
  </section>;
}
