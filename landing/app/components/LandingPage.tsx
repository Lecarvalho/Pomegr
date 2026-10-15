import type { CSSProperties } from "react";
import { ArilChat } from "./ArilChat";
import { DotGlow } from "./DotGlow";
import { PomegranateSplit } from "./PomegranateSplit";
import { ScrollReveal } from "./ScrollReveal";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { SessionGraph } from "./SessionGraph";
import styles from "./LandingPage.module.css";

const SAMPLE_NOTE = "Illustrative · sample data";
const DOWNLOAD_URL = "/download";

export function LandingPage() {
  return (
    <main className={styles.landing} id="home">
      <ScrollReveal rootId="home" />
      <SiteHeader current="home" />

      <div className={styles.heroZone} id="hero-zone">
        <DotGlow rootId="hero-zone" />
        <PomegranateSplit />
        <div className={styles.page}>
          <section className={styles.hero} aria-labelledby="hero-title">
            <h1 id="hero-title">Your agents don’t sleep. <span>So you can.</span></h1>
            <div className={styles.heroRow}>
              <div>
                <p className={styles.lede}>Local, read-only metrics for every coding-agent session, with a task board and Aril, the task-board agent.</p>
                <p className={`${styles.platformLine} ${styles.label}`}>
                  <span><i />Windows x64 · installer or portable</span>
                  <span><i className={styles.planned} />iOS &amp; Android · planned</span>
                </p>
              </div>
            </div>
          </section>

          <figure className={`${styles.figure} ${styles.figureGhost}`} aria-hidden="true">
            <Ticks />
            <SessionGraph />
          </figure>

          <div className={styles.cta}>
            <a className={styles.primaryAction} href={DOWNLOAD_URL}>Download for Windows <ArrowIcon /></a>
          </div>

          <div className={styles.jobs}>
            <div><span className={styles.label}>Observe</span><h2>Every session, read-only</h2><p>Live and recorded sessions, agents, context, Git changes, and usage limits.</p></div>
            <div><span className={styles.label}>Plan</span><h2>A board that starts work</h2><p>The queue starts one session per task and moves it to Review when it is done.</p></div>
            <div><span className={styles.label}>Ask</span><h2>Aril proposes, you apply</h2><p>An agent for your board that changes nothing until you say so.</p></div>
          </div>
        </div>
      </div>

      <div className={styles.page}>
        <section className={styles.chapter} aria-labelledby="sessions-title">
          <h2 data-reveal className={styles.statement} id="sessions-title">Every session, as it happens. <span>Pomegr quietly reads your agents’ records and shows what matters most.</span></h2>
          <Figure caption="[ fig. 2 — one session, four agents ]" note={SAMPLE_NOTE}>
            <SessionDiagram />
            <Notes items={[
              ["Live and recorded", "Follow a run as it happens, or open last week’s exactly as it was recorded."],
              ["Signals you can trace", "Each signal points to the events that raised it. A heuristic says so."],
              ["Usage limits in view", "See each account window before you start long work."],
            ]} />
          </Figure>
        </section>

        <section className={styles.chapter} aria-labelledby="tasks-title">
          <h2 data-reveal className={styles.statement} id="tasks-title">A kanban to plan and start the next session. <span>Queued tasks start on their own when their turn comes.</span></h2>
          <Figure caption="[ fig. 3 — the queue ]" note="Desktop app · opt-in">
            <QueueDiagram />
            <Notes items={[
              ["Your board, per repository", "Backlog, Ready, In progress, Review, Done. Ready is the queue."],
              ["Starts only what you queue", "Dispatch is opt-in and lives in the desktop app. Observation never needs it."],
              ["Review before Done", "Each card links to its session, so the evidence is one click away."],
            ]} />
          </Figure>
        </section>

        <section className={styles.chapter} aria-labelledby="aril-title">
          <h2 data-reveal className={styles.statement} id="aril-title">Aril, your task specialist, plans. You apply. <span>Ask it about the board and your sessions.</span></h2>
          <Figure caption="[ fig. 4 — a proposal ]" note={SAMPLE_NOTE}>
            <div className={styles.figureBody}><ArilChat /></div>
            <Notes items={[
              ["Reads, never acts", "Aril runs read-only. A board change is always a proposal."],
              ["Knows your board", "It answers from your tasks and what Pomegr observed."],
              ["Starts only on your say", "A start or a queue change needs your confirmation in the desktop app."],
            ]} />
          </Figure>
        </section>

        <div className={styles.close} aria-hidden="true">
          <img data-reveal className={styles.bite} src="/landing/home/pomegranate-bite.png" alt="" width="1200" height="800" />
        </div>

      </div>

      <SiteFooter current="home" />
    </main>
  );
}

function delay(step: number): CSSProperties {
  return { "--delay": `${200 + step * 140}ms` } as CSSProperties;
}

function Ticks() {
  return <span className={styles.ticks} aria-hidden="true" />;
}

function Figure({ caption, note, children }: { caption: string; note: string; children: React.ReactNode }) {
  return (
    <figure data-reveal className={styles.figure}>
      <Ticks />
      <figcaption className={styles.figureHead}>
        <span className={styles.label}>{caption}</span>
        <span className={`${styles.label} ${note === SAMPLE_NOTE ? styles.quiet : ""} ${styles.wideOnly}`}>{note}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function Notes({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className={styles.notes}>
      {items.map(([title, text]) => <div key={title}><strong>{title}</strong><p>{text}</p></div>)}
    </div>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}

const SESSION_LABEL = "A session timeline from sample data: an orchestrator starts three subagents, and one is running tests now";

function SessionDiagram() {
  return (
    <div className={styles.figureBody}>
      <svg className={`${styles.diagram} ${styles.wideOnly}`} viewBox="0 0 1100 300" role="img" aria-label={SESSION_LABEL}>
        <text x="0" y="22">AGENT</text><text x="980" y="22">CONTEXT</text>
        <line className={styles.rule} x1="0" y1="36" x2="1100" y2="36" />
        <text className={styles.textInk} x="0" y="74">Orchestrator</text>
        <rect style={delay(0)} className={styles.bar} x="170" y="62" width="740" height="14" />
        <text className={styles.value} x="980" y="74">64k</text>
        <path pathLength={1} className={styles.mute} d="M260 76 V118 H300 M420 76 V178 H460 M640 76 V238 H680" />
        <text className={styles.textInk} x="0" y="124">Reader</text>
        <rect style={delay(1)} className={styles.bar} x="300" y="112" width="180" height="14" />
        <text className={styles.value} x="980" y="124">38k</text>
        <text className={styles.textInk} x="0" y="184">Retry policy</text>
        <rect style={delay(2)} className={styles.bar} x="460" y="172" width="330" height="14" />
        <text className={styles.value} x="980" y="184">71k</text>
        <text className={styles.textInk} x="0" y="244">Test runner</text>
        <rect style={delay(3)} className={styles.bar} x="680" y="232" width="150" height="14" />
        <rect style={delay(4)} className={styles.barOn} x="830" y="232" width="80" height="14" />
        <text className={styles.value} x="980" y="244">47k</text>
        <line className={styles.now} x1="910" y1="44" x2="910" y2="262" />
        <text className={styles.signalText} x="884" y="282">NOW</text>
        <line className={styles.rule} x1="0" y1="264" x2="1100" y2="264" />
        <text x="170" y="282">10:02</text><text x="355" y="282">10:12</text><text x="540" y="282">10:22</text><text x="725" y="282">10:32</text>
      </svg>
      <svg className={`${styles.diagram} ${styles.narrowOnly}`} viewBox="0 0 340 250" role="img" aria-label={SESSION_LABEL}>
        <text className={styles.textInk} x="0" y="20">Orchestrator</text><rect style={delay(5)} className={styles.bar} x="0" y="30" width="300" height="10" />
        <path pathLength={1} className={styles.mute} d="M30 40 V70 M90 40 V130 M170 40 V190" />
        <text className={styles.textInk} x="40" y="70">Reader</text><rect style={delay(0)} className={styles.bar} x="30" y="78" width="80" height="10" />
        <text className={styles.textInk} x="100" y="130">Retry policy</text><rect style={delay(1)} className={styles.bar} x="90" y="138" width="140" height="10" />
        <text className={styles.textInk} x="180" y="190">Test runner</text><rect style={delay(2)} className={styles.bar} x="170" y="198" width="70" height="10" />
        <rect style={delay(3)} className={styles.barOn} x="240" y="198" width="60" height="10" />
        <line className={styles.now} x1="300" y1="22" x2="300" y2="222" /><text className={styles.signalText} x="282" y="242">NOW</text>
      </svg>
    </div>
  );
}

const QUEUE_LABEL = "The queue: the top card in Ready starts a session, and when the agent reports done the card moves to Review";

function QueueDiagram() {
  return (
    <div className={styles.figureBody}>
      <svg className={`${styles.diagram} ${styles.wideOnly}`} viewBox="0 0 1100 330" role="img" aria-label={QUEUE_LABEL}>
        <text x="0" y="16">BACKLOG</text><text x="285" y="16">READY</text><text x="570" y="16">IN PROGRESS</text><text x="855" y="16">REVIEW</text>
        <rect className={styles.frame} x="0" y="28" width="245" height="290" /><rect className={styles.frame} x="285" y="28" width="245" height="290" />
        <rect className={styles.frame} x="570" y="28" width="245" height="290" /><rect className={styles.frame} x="855" y="28" width="245" height="290" />
        <Card x={14} y={44} id="T-45" title="Show retry counts" />
        <Card x={14} y={110} id="T-44" title="Document export limits" />
        <Card x={299} y={44} id="T-43 · NEXT" title="Stream large exports" on />
        <Card x={299} y={110} id="T-42" title="Paginate the audit log" />
        <Card x={584} y={44} id="T-41" title="Add retry to the worker" />
        <Card x={869} y={44} id="T-39" title="Fix the upload test" />
        <path pathLength={1} className={styles.signalLine} d="M516 72 C545 72 545 210 600 210" /><path className={styles.signalFill} d="M600 205 L610 210 600 215Z" />
        <rect className={styles.cardOn} x="614" y="186" width="187" height="48" />
        <text className={styles.signalText} x="628" y="206">SESSION STARTS</text><text className={styles.textInk} x="628" y="224">queue on · one at a time</text>
        <path className={styles.dash} d="M801 72 H869" />
        <text x="590" y="290">agent reports done → Review</text>
      </svg>
      <svg className={`${styles.diagram} ${styles.narrowOnly}`} viewBox="0 0 340 300" role="img" aria-label={QUEUE_LABEL}>
        <text x="0" y="14">READY</text>
        <rect className={styles.cardOn} x="0" y="24" width="340" height="50" />
        <text className={styles.signalText} x="14" y="44">T-43 · NEXT</text><text className={styles.textInk} x="14" y="64">Stream large exports</text>
        <path pathLength={1} className={styles.signalLine} d="M30 74 V108" /><path className={styles.signalFill} d="M25 108 L30 118 35 108Z" />
        <text className={styles.signalText} x="46" y="100">QUEUE ON · SESSION STARTS</text>
        <text x="0" y="140">IN PROGRESS</text>
        <rect className={styles.card} x="0" y="150" width="340" height="50" />
        <text x="14" y="170">T-43</text><text className={styles.textInk} x="14" y="190">Stream large exports</text>
        <path pathLength={1} className={styles.mute} d="M30 200 V234" /><path className={styles.muteFill} d="M25 234 L30 244 35 234Z" />
        <text x="46" y="226">AGENT REPORTS DONE</text>
        <text x="0" y="266">REVIEW</text><rect className={styles.frame} x="0" y="276" width="340" height="22" />
      </svg>
    </div>
  );
}

function Card({ x, y, id, title, on = false }: { x: number; y: number; id: string; title: string; on?: boolean }) {
  return (
    <g>
      <rect className={on ? styles.cardOn : styles.card} x={x} y={y} width="217" height="56" />
      <text className={on ? styles.signalText : undefined} x={x + 14} y={y + 22}>{id}</text>
      <text className={styles.textInk} x={x + 14} y={y + 44}>{title}</text>
    </g>
  );
}
