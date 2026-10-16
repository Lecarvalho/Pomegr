"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./LandingPage.module.css";

// The conversation plays in steps: 1 your message, 2 Aril typing, 3 Aril's answer, 4 the
// proposal, 5 Apply pressed, 6 applied and the new card in Ready, 7 Aril typing again, 8 Aril's
// follow-up, 9 the queue moves the card to In progress, 10 its session's terminal opens, 11 to
// 14 the terminal's lines. The server renders the finished scene, so the figure reads completely
// without script and under reduced motion.
const TERMINAL = [
  "session started · T-44",
  "reading src/export/stream.ts",
  "writing src/export/csv-writer.ts",
  "running tests",
];
const FINAL = 10 + TERMINAL.length;
const TIMELINE = [600, 1500, 1900, 1500, 1700, 1100, 900, 1300, 1700, 900, ...TERMINAL.map(() => 750)];
const HOLD_MS = 6500;

export function ArilChat() {
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(FINAL);

  useEffect(() => {
    const node = root.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timers: number[] = [];
    const clear = () => { timers.forEach(window.clearTimeout); timers = []; };
    const play = () => {
      clear();
      setStep(0);
      let at = 0;
      TIMELINE.forEach((delay, index) => {
        at += delay;
        timers.push(window.setTimeout(() => setStep(index + 1), at));
      });
      timers.push(window.setTimeout(play, at + HOLD_MS));
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) play();
      else { clear(); setStep(FINAL); }
    }, { threshold: 0.35 });
    observer.observe(node);
    return () => { observer.disconnect(); clear(); };
  }, []);

  const shown = (from: number) => (step >= from ? styles.shown : "");

  return (
    <div ref={root} className={styles.arilScene}>
      <div className={styles.chat} aria-label="Sample conversation with Aril">
        <div className={styles.chatHead}>
          <Spark />
          <strong>Aril</strong>
          <span>Task-board agent</span>
        </div>
        <div className={styles.chatBody}>
          <p className={`${styles.bubble} ${shown(1)}`}>Split the export work so the writer lands first.</p>
          <div className={styles.answerSlot}>
            <p className={`${styles.typing} ${step === 2 ? styles.shown : ""}`} aria-hidden="true"><i /><i /><i /></p>
            <p className={`${styles.answer} ${shown(3)}`}>The CSV writer unblocks streaming, so I would add it ahead of <span className={styles.nowrap}>T-43</span>.</p>
          </div>
          <div className={`${styles.proposal} ${shown(4)}`}>
            <strong>Add the CSV writer before T-43</strong>
            <ol>
              <li><span>Create task</span>Write the CSV writer</li>
              <li><span>Move</span>T-43 after it</li>
            </ol>
            <div className={styles.proposalActions}>
              <b className={`${step === 5 ? styles.pressed : ""} ${step >= 6 ? styles.applied : ""}`}>{step >= 6 ? "Applied" : "Apply changes"}</b>
              <span>Dismiss</span>
            </div>
            <p>Nothing changes until you apply.</p>
          </div>
          <div className={styles.answerSlot}>
            <p className={`${styles.typing} ${step === 7 ? styles.shown : ""}`} aria-hidden="true"><i /><i /><i /></p>
            <p className={`${styles.answer} ${shown(8)}`}>Done. T-44 is first in Ready, so the queue starts it next.</p>
          </div>
        </div>
        <div className={styles.composer}>Ask about this board…</div>
      </div>
      <div className={styles.miniBoard} aria-label="Sample board, Ready column">
        <p className={styles.miniHead}>Ready <span>{step >= 6 && step < 9 ? 3 : 2}</span></p>
        <div className={`${styles.miniSlot} ${step >= 6 && step < 9 ? styles.shown : ""}`}><div><div className={styles.miniNew}><span>T-44 · New</span>Write the CSV writer</div></div></div>
        <div className={styles.miniCard}><span>T-43</span>Stream large exports</div>
        <div className={styles.miniCard}><span>T-42</span>Paginate the audit log</div>
      </div>
      <div className={`${styles.miniBoard} ${styles.runningColumn}`} aria-label="Sample board, In progress column">
        <p className={styles.miniHead}>In progress <span>{step >= 9 ? 1 : 0}</span></p>
        <div className={`${styles.miniSlot} ${shown(9)}`}><div><div className={styles.miniNew}><span>T-44 · Running</span>Write the CSV writer</div></div></div>
        <div className={`${styles.terminal} ${shown(10)}`} aria-label="Sample session terminal">
          <p className={styles.terminalBar}><i /><i /><i /><span>T-44 · session</span></p>
          <div className={styles.terminalBody}>
            {TERMINAL.map((line, index) => (
              <p key={line} className={shown(11 + index)}><b>›</b> {line}{index === TERMINAL.length - 1 ? <span className={styles.cursor} /> : null}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Spark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" /></svg>;
}
