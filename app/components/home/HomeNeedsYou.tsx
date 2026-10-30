"use client";

import Link from "next/link";
import { useId } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { taskBoardHref } from "../tasks/TasksHome";
import { ATTENTION_WORDS, NEEDS_YOU_SHOWN, type NeedsItem } from "./home-model";
import styles from "./HomeNeedsYou.module.css";

/** What waits for the owner now: paused queues, then tasks to review, stalled, or blocked. Fixed rules in `home-model.ts` pick and word every row. */
export function HomeNeedsYou({ items, total }: { items: readonly NeedsItem[]; total: number }) {
  const headingId = useId();
  const shown = items.slice(0, NEEDS_YOU_SHOWN);
  return <section className={styles.needs} aria-labelledby={headingId}>
    <h2 id={headingId}>Needs you<span className={styles.count}>{total}</span></h2>
    <ul className={styles.list}>
      {shown.map((item) => <li key={item.key}>
        <Link className={styles.row} href={taskBoardHref(item.repositoryId)}>
          <span className={styles.repository}>{item.repositoryName}</span>
          {item.kind === "task"
            ? <>
              <span className={styles.taskId}>{item.taskId}</span>
              <span className={styles.title} title={item.title}>{item.title}</span>
              <span className={styles.state}>{ATTENTION_WORDS[item.state]}{item.detail && <> · <span className={item.detail.urgent ? styles.urgent : undefined}>{item.detail.words}</span></>}</span>
            </>
            : <>
              <span className={styles.title}>Queue paused</span>
              <span className={styles.state}>{item.reason}</span>
            </>}
          <CommandIcon name="chevron" size="small" className={`commandIcon ${styles.chevron}`} />
        </Link>
      </li>)}
    </ul>
    {total > shown.length && <Link className={`commandQuietAction ${styles.more}`} href="/tasks">Show all {total}</Link>}
  </section>;
}
