"use client";

import { useEffect, useState } from "react";
import styles from "./LandingPage.module.css";

type TaskState = "empty" | "backlog" | "ready" | "running" | "review" | "done";

const CELLS = 288;
const STEP_MS = 1400;
// Squares from here start empty and fill one by one after the hero pomegranate cracks open.
const SEEDED_FROM = 210;
const SEED_START_MS = 1300;
const SEED_EVERY_MS = 60;
const LEGEND: ReadonlyArray<readonly [TaskState, string]> = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["running", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
];

// Invented sample data: a repository whose finished work fills the first rows, one task in
// progress, a short queue in Ready, and a backlog after it. A fixed sequence keeps the server
// render and the first client render identical. Unseeded, the tail of the backlog is empty.
function sampleBoard(seeded = true): TaskState[] {
  const board: TaskState[] = [];
  let seed = 7;
  for (let index = 0; index < CELLS; index += 1) {
    seed = (seed * 16807) % 2147483647;
    if (index < 190) board.push(seed % 31 === 0 ? "review" : "done");
    else if (index === 190) board.push("running");
    else if (index < 198) board.push("ready");
    else board.push(seeded || index < SEEDED_FROM ? "backlog" : "empty");
  }
  return board;
}

// One queue step: Review settles, the running task goes to Review, the top of Ready starts,
// and the backlog refills Ready. The sample starts again when the running task would leave the
// visible squares: phones show squares 145 to 216, narrower desktops 145 to 288.
function advance(board: TaskState[], visibleEnd: number): TaskState[] {
  const next = [...board];
  const first = (state: TaskState) => next.indexOf(state);
  const review = first("review");
  if (review >= 0 && Math.random() < 0.6) next[review] = "done";
  const running = first("running");
  if (running >= 0) next[running] = "review";
  const ready = first("ready");
  if (ready >= 0) next[ready] = "running";
  const backlog = first("backlog");
  if (backlog >= 0) next[backlog] = "ready";
  return first("running") < 0 || first("running") >= visibleEnd ? sampleBoard() : next;
}

export function TaskField() {
  const [board, setBoard] = useState(() => sampleBoard(false));

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBoard(sampleBoard());
      return;
    }
    const visibleEnd = window.matchMedia("(max-width: 720px)").matches ? 216 : CELLS;
    let seeding = 0;
    let queue = 0;
    const plant = () => setBoard((board) => {
      const empty = board.indexOf("empty");
      if (empty < 0) return board;
      const next = [...board];
      next[empty] = "backlog";
      return next;
    });
    const start = window.setTimeout(() => {
      seeding = window.setInterval(plant, SEED_EVERY_MS);
      queue = window.setInterval(() => setBoard((board) => advance(board, visibleEnd)), STEP_MS);
    }, SEED_START_MS);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(seeding);
      window.clearInterval(queue);
    };
  }, []);

  const counts: Record<string, number> = Object.fromEntries(LEGEND.map(([state]) => [state, board.filter((cell) => cell === state).length]));

  return (
    <>
      <div className={styles.figureBody}>
        <div className={styles.field} aria-hidden="true">
          {board.map((state, index) => <i key={index} className={styles.cell} data-state={state} />)}
        </div>
      </div>
      <div className={styles.figureFoot}>
        <p className={`${styles.legend} ${styles.label}`}>
          {LEGEND.map(([state, label]) => (
            <span key={state}><i className={styles.cell} data-state={state} />{label} <b>{counts[state]}</b></span>
          ))}
        </p>
        <span className={`${styles.label} ${styles.wideOnly}`}>One square · one task · one session</span>
      </div>
    </>
  );
}
