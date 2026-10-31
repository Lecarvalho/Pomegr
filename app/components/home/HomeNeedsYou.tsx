"use client";

import Link from "next/link";
import { useId } from "react";
import { CommandIcon, type CommandIconName } from "../command-center/CommandIcon";
import { NEEDS_LINES_SHOWN, type NeedsKind, type NeedsLine } from "./home-model";
import card from "./HomeCard.module.css";
import styles from "./HomeNeedsYou.module.css";

const GLYPHS: Record<NeedsKind, CommandIconName> = { session: "session", review: "check", stalled: "timer", blocked: "stop", queue: "history" };

/**
 * What the owner has to do now, one line for each thing, grouped by kind and repository, in a card with a count. Fixed rules in `home-model.ts` pick and
 * word every line. The card ends with a closing line: that nothing else waits, or how many more things do.
 */
export function HomeNeedsYou({ lines, total }: { lines: readonly NeedsLine[]; total: number }) {
  const headingId = useId();
  const shown = lines.slice(0, NEEDS_LINES_SHOWN);
  const more = total - shown.length;
  return <section className={`${card.card} ${styles.needs}`} aria-labelledby={headingId}>
    <header className={card.head}>
      <h2 id={headingId}>Needs you</h2>
      <span className={styles.count}>{total}</span>
    </header>
    <ul className={card.list}>
      {shown.map((line) => <li key={line.key}>
        <Link className={card.item} href={line.href}>
          <span className={styles.glyph} aria-hidden="true"><CommandIcon name={GLYPHS[line.kind]} size="small" /></span>
          <span className={styles.text}>
            <span className={styles.action}>{line.action}{line.detail && <span className={line.detail.urgent ? styles.urgent : styles.detail}> {line.detail.words}</span>}</span>
            <span className={styles.repository}>{line.repository}</span>
          </span>
          <CommandIcon name="chevron" size="small" className={`commandIcon ${styles.chevron}`} />
        </Link>
      </li>)}
    </ul>
    {more > 0 ? <p className={`${card.closing} ${styles.more}`}>{more} more {more === 1 ? "thing needs" : "things need"} you.</p>
      : <p className={`${card.closing} ${styles.closing}`}><CommandIcon name="check" size="small" />Nothing else is waiting on you.</p>}
  </section>;
}
