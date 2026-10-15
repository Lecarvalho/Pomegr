import styles from "./HomeUpdateIllustration.module.css";

// Artwork for the current What's new announcement: a repository's task board, cropped to In progress and Ready.
type Card = { id: string; title: string; chip: string; tone?: "live" | "queued"; run: string };

const IN_PROGRESS: Card[] = [
  { id: "T-4", title: "Add a dark theme", chip: "In progress", tone: "live", run: "Claude Code · medium" },
  { id: "T-3", title: "Write the import guide", chip: "In progress", tone: "live", run: "Codex · low" },
];
const NEXT: Card = { id: "T-5", title: "Cache the search results", chip: "Queued · next", tone: "queued", run: "Codex · high" };
const GROUP: Card[] = [
  { id: "T-6", title: "Add an export button", chip: "Queued", tone: "queued", run: "Claude Code · medium" },
  { id: "T-7", title: "Translate the empty states", chip: "Queued", tone: "queued", run: "Claude Code · low" },
];

function MiniCard({ card }: { card: Card }) {
  return <div className={`${styles.card}${card.tone === "live" ? ` ${styles.live}` : ""}`}>
    <div className={styles.top}>
      <span className={styles.id}>{card.id}</span>
      <span className={`${styles.chip}${card.tone ? ` ${styles[card.tone]}` : ""}`}>{card.chip}</span>
    </div>
    <span className={styles.title}>{card.title}</span>
    <span className={styles.run}>{card.run}</span>
  </div>;
}

export function HomeUpdateIllustration() {
  return <div className={styles.frame}>
    <div className={styles.lane}>
      <div className={styles.header}><strong>In progress</strong><span>2</span></div>
      {IN_PROGRESS.map((card) => <MiniCard key={card.id} card={card} />)}
    </div>
    <div className={styles.lane}>
      <div className={styles.header}><strong>Ready</strong><span>3</span></div>
      <MiniCard card={NEXT} />
      <div className={styles.group}>
        <div className={styles.caption}>
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M4 2v8M8 2v8" /></svg>
          <span>Parallel · <span className={styles.count}>2</span></span>
        </div>
        {GROUP.map((card) => <MiniCard key={card.id} card={card} />)}
      </div>
    </div>
  </div>;
}
