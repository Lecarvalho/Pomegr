"use client";

import { useMemo } from "react";
import { useTaskHome } from "../../tasks-home-store";
import type { RepositoryInventorySnapshot } from "../../../shared/monitor-contract";
import { CommandPage } from "../command-center/CommandPage";
import { useTaskEditAvailability } from "./task-desktop";
import { overviewTotals, splitOverviewBoards, type OverviewTotals } from "./tasks-overview-model";
import { TasksOverviewBoards } from "./TasksOverviewBoards";
import { TasksOverviewNeeds } from "./TasksOverviewNeeds";
import styles from "./TasksOverview.module.css";

type Repository = RepositoryInventorySnapshot["repositories"][number];

const DESCRIPTION = "What waits for you, then every repository's board at a glance.";

export function TasksHomeSkeleton() {
  return <div className="taskHomeSkeleton" aria-label="Loading tasks"><span /><span /></div>;
}

/** Open (not Done), in review, and done, summed over the boards that answered. A board that did not is named, never counted. */
function Totals({ totals }: { totals: OverviewTotals }) {
  return <div className={styles.totalsBlock}>
    <ul className={styles.totals} aria-label="Totals across all boards">
      <li className={styles.total}><b className={styles.totalNumber}>{totals.open}</b> open</li>
      <li className={styles.total}><b className={`${styles.totalNumber} ${styles.isReview}`}>{totals.review}</b> in review</li>
      <li className={styles.total}><b className={`${styles.totalNumber} ${styles.isDone}`}>{totals.done}</b> done</li>
    </ul>
    {totals.unavailable > 0 && <p className={styles.totalsNote}>Without {totals.unavailable} {totals.unavailable === 1 ? "board that is" : "boards that are"} unavailable.</p>}
  </div>;
}

export function TasksHome({ repositories }: { repositories: Repository[] }) {
  const home = useTaskHome();
  const access = useTaskEditAvailability();
  const names = useMemo(() => new Map(repositories.map((repository) => [repository.id, repository.displayName])), [repositories]);
  const ready = home.readiness === "ready";
  const totals = useMemo(() => (ready ? overviewTotals(home, new Set(names.keys())) : null), [home, names, ready]);
  const { cards, quiet } = useMemo(() => splitOverviewBoards(home, repositories), [home, repositories]);
  return <CommandPage title="Tasks" description={DESCRIPTION} busy={home.readiness === "loading"} action={totals ? <Totals totals={totals} /> : undefined}>
    <div className={`taskHome ${styles.overview}`}>
      {home.readiness === "loading" && <TasksHomeSkeleton />}
      {home.readiness === "unavailable" && <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>}
      {home.readiness === "desktop_only" && <section className="panel taskBoardNotice" aria-label="Tasks">
        <span className="commandChip">Desktop only</span>
        <p>Task boards are available in the Pomegr desktop app on this computer.</p>
      </section>}
      {ready && <>
        <TasksOverviewNeeds home={home} names={names} enter={0} />
        <TasksOverviewBoards cards={cards} quiet={quiet} access={access} enter={1} />
      </>}
    </div>
  </CommandPage>;
}
