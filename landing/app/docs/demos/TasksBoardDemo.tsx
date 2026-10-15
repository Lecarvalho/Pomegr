"use client";

import { useState } from "react";
import type { DemoCard, DemoColumn, DemoStep } from "./tasks-board-steps";
import { DEMO_COLUMNS, DEMO_STEPS } from "./tasks-board-steps";
import styles from "./tasks-board-demo.module.css";

// A scripted, synthetic Tasks board for the public guide. Each selection advances one step; nothing is
// stored, fetched, or started.

const TITLE_ID = "docs-demo-tasks-board-title";
const CAPTION_ID = "docs-demo-tasks-board-caption";

type Entry = { kind: "card"; card: DemoCard } | { kind: "group"; group: string; cards: DemoCard[] };

function entriesOf(cards: readonly DemoCard[]): Entry[] {
  const entries: Entry[] = [];
  for (const card of cards) {
    const last = entries[entries.length - 1];
    if (card.group && last?.kind === "group" && last.group === card.group) last.cards.push(card);
    else if (card.group) entries.push({ kind: "group", group: card.group, cards: [card] });
    else entries.push({ kind: "card", card });
  }
  return entries;
}

function Card({ card, changed }: { card: DemoCard; changed: boolean }) {
  return (
    <li className={styles.card} data-changed={changed ? "true" : undefined}>
      <span className={styles.cardId}>{card.id}</span>
      <span className={styles.cardTitle}>{card.title}</span>
      <span className={styles.chip} data-tone={card.chip === "Working" ? "live" : card.chip === "Needs review" ? "attention" : undefined}>{card.chip}</span>
      {card.note ? <span className={styles.cardNote}>{card.note}</span> : null}
    </li>
  );
}

function Column({ name, step, index }: { name: DemoColumn; step: DemoStep; index: number }) {
  const cards = step.columns[name];
  const labelId = `docs-demo-tasks-board-column-${index}`;
  return (
    <section className={styles.column} aria-labelledby={labelId}>
      <p id={labelId} className={styles.columnName}>
        {name} <span className={styles.count}>{cards.length}</span>
      </p>
      {cards.length === 0 ? (
        <p className={styles.emptyColumn}>No cards</p>
      ) : (
        <ul className={styles.cards}>
          {entriesOf(cards).map((entry) =>
            entry.kind === "card" ? (
              <Card key={entry.card.id} card={entry.card} changed={step.changed.includes(entry.card.id)} />
            ) : (
              <li key={`group-${entry.group}`} className={styles.group}>
                <span className={styles.groupCaption}>Parallel · {entry.cards.length}</span>
                <ul className={styles.cards} aria-label={`Parallel group of ${entry.cards.length}`}>
                  {entry.cards.map((card) => <Card key={card.id} card={card} changed={step.changed.includes(card.id)} />)}
                </ul>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function TasksBoardDemo() {
  const [index, setIndex] = useState(0);
  const step = DEMO_STEPS[index];
  const last = index === DEMO_STEPS.length - 1;

  return (
    <section className={styles.demo} aria-labelledby={TITLE_ID} aria-describedby={CAPTION_ID}>
      <div className={styles.header}>
        <p id={TITLE_ID} className={styles.title}>Demo board · sample tasks</p>
        <p className={styles.queue}>
          Queue <span className={styles.chip} data-tone={step.queueOn ? "ink" : undefined}>{step.queueOn ? "On" : "Off"}</span>
        </p>
      </div>

      {/* The step's board re-mounts so the highlight of a changed card plays once. */}
      <div key={index} className={styles.board}>
        {DEMO_COLUMNS.map((name, column) => <Column key={name} name={name} step={step} index={column} />)}
      </div>

      {step.proposal ? (
        <section className={styles.aril} aria-label="Aril">
          <p className={styles.arilName}>Aril</p>
          <p className={styles.arilMessage}>Here is one task for the export work.</p>
          <div className={styles.proposal}>
            <span className={styles.proposalOperation}>{step.proposal.operation}</span>
            <span className={styles.proposalText}>{step.proposal.text}</span>
            {step.proposal.applied ? <span className={styles.chip} data-tone="positive">Applied</span> : null}
          </div>
          {step.proposal.applied ? null : <p className={styles.proposalNote}>Nothing changes until you apply.</p>}
        </section>
      ) : null}

      <div className={styles.footer}>
        <p id={CAPTION_ID} className={styles.caption} aria-live="polite">{step.caption}</p>
        <div className={styles.controls}>
          <span className={styles.stepCount}>Step {index + 1} of {DEMO_STEPS.length}</span>
          {index > 0 && !last ? (
            <button type="button" className={styles.quietAction} onClick={() => setIndex(0)}>Start over</button>
          ) : null}
          <button type="button" className={styles.primaryAction} onClick={() => setIndex(last ? 0 : index + 1)}>{step.action}</button>
        </div>
      </div>
    </section>
  );
}
