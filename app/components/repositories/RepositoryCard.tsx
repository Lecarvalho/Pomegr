import Link from "next/link";
import type { RepositorySummary } from "../../../shared/monitor-contract";
import { activityBars, activityLabel, providerMarks, repositoryActivityLine, repositoryInitial, repositorySetupCard, repositorySetupHref, tileTint } from "./repository-card-model";
import styles from "./RepositoryCards.module.css";

const TINTS = [styles.tint0, styles.tint1, styles.tint2, styles.tint3];
const BADGES = { Ready: styles.setupReady, "Setup unverified": styles.setupUnverified, "Reporting off": styles.setupOff } as const;
const MARKS = { claude: styles.markClaude, codex: styles.markCodex } as const;

/**
 * One repository: its initial tile and name, how many sessions run now and when it was last active, the providers it has sessions of, 14 days of
 * sessions as bars, its live and session counts, and its setup. The name is the card's one link; a setup that needs the owner adds a fix line
 * whose "Set up →" link opens the tab where it is done.
 */
export function RepositoryCard({ repository, enter }: { repository: RepositorySummary; enter: number }) {
  const setup = repositorySetupCard(repository);
  const bars = activityBars(repository.dailySessions, repository.liveCount > 0);
  const marks = providerMarks(repository);
  return <article className={`${styles.card} ${styles.enter}`} style={{ "--enter": enter } as React.CSSProperties}>
    <div className={styles.head}>
      <span className={`${styles.tile} ${TINTS[tileTint(repository.id)]}`} aria-hidden="true">{repositoryInitial(repository.displayName)}</span>
      <div className={styles.identity}>
        <h3 title={repository.displayName}>
          <Link className={styles.nameLink} href={`/repositories/${repository.id}`} aria-label={`${repository.displayName}, ${setup.summary}`}>{repository.displayName}</Link>
        </h3>
        <p className={styles.activity}>
          {repository.liveCount > 0 && <span className={styles.pulse} aria-hidden="true" />}
          <span>{repositoryActivityLine(repository)}</span>
        </p>
      </div>
      {marks.length > 0 && <ul className={styles.providers} aria-label="Providers">
        {marks.map((mark) => <li key={mark.provider} className={`${styles.mark} ${MARKS[mark.provider]}`} title={mark.name}>
          <span aria-hidden="true">{mark.letter}</span><span className="commandVisuallyHidden">{mark.name}</span>
        </li>)}
      </ul>}
    </div>
    {bars && <div className={styles.bars} role="img" aria-label={activityLabel(bars)}>
      {bars.map((bar, index) => <span key={index} className={`${styles.bar}${bar.count === 0 ? ` ${styles.isEmpty}` : ""}${bar.live ? ` ${styles.isLive}` : ""}`} style={{ height: `${bar.height}px` }} />)}
    </div>}
    <div className={styles.facts}>
      <span className={styles.fact}><b className={repository.liveCount > 0 ? styles.isLive : undefined}>{repository.liveCount}</b> live</span>
      <span className={styles.fact}><b>{repository.sessionCount}</b> {repository.sessionCount === 1 ? "session" : "sessions"}</span>
      <span className={`${styles.setup} ${BADGES[setup.badge]}`}>{setup.badge}</span>
    </div>
    {setup.fix && <div className={styles.fix}>
      <span>{setup.fix.text}</span>
      <Link className={styles.fixLink} href={repositorySetupHref(repository.id, setup.fix)}>Set up <span className="commandVisuallyHidden">{repository.displayName} </span><span aria-hidden="true">→</span></Link>
    </div>}
  </article>;
}
