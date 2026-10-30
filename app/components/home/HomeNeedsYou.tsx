"use client";

import Link from "next/link";
import { useId } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { NEEDS_LINES_SHOWN, type NeedsLine } from "./home-model";
import styles from "./HomeNeedsYou.module.css";

/** What the owner has to do now, one line for each thing, grouped by kind and repository. Fixed rules in `home-model.ts` pick and word every line. */
export function HomeNeedsYou({ lines, total }: { lines: readonly NeedsLine[]; total: number }) {
  const headingId = useId();
  const shown = lines.slice(0, NEEDS_LINES_SHOWN);
  return <section className={styles.needs} aria-labelledby={headingId}>
    <h2 id={headingId}>Needs you</h2>
    <ul className={styles.list}>
      {shown.map((line) => <li key={line.key}>
        <Link className={styles.row} href={line.href}>
          <span className={styles.action}>{line.action}</span>
          {line.detail && <span className={line.detail.urgent ? styles.urgent : styles.detail}>{line.detail.words}</span>}
          <span className={styles.repository}>{line.repository}</span>
          <CommandIcon name="chevron" size="small" className={`commandIcon ${styles.chevron}`} />
        </Link>
      </li>)}
    </ul>
    {total > shown.length && <p className={styles.more}>{total - shown.length} more {total - shown.length === 1 ? "thing needs" : "things need"} you.</p>}
  </section>;
}
