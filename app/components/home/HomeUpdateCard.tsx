"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import styles from "./HomeUpdateCard.module.css";

const AUTO_OPEN_DELAY_MS = 300;

type HomeUpdateCardProps = {
  title: string;
  summary: string;
  description: string;
  highlights: string[];
  illustration?: ReactNode;
  autoOpen?: boolean;
  onAutoOpen?(): void;
  onDismiss(): void;
};

export function HomeUpdateCard({ title, summary, description, highlights, illustration, autoOpen = false, onAutoOpen, onDismiss }: HomeUpdateCardProps) {
  const headingId = useId();
  const dialogTitleId = useId();
  const [open, setOpen] = useState(false);
  const opensByItself = useRef(autoOpen);
  useEffect(() => {
    if (!opensByItself.current) return;
    const timer = setTimeout(() => setOpen(true), AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  // Recorded when it opens, not when it closes, so a reload never shows it a second time.
  useEffect(() => { if (autoOpen) onAutoOpen?.(); }, [autoOpen, onAutoOpen]);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const showDialog = useCallback((node: HTMLDialogElement | null) => {
    dialog.current = node;
    if (!node || node.open) return;
    // Centered over the Home column the card sits in, not the whole window, so the side navigation does not pull it off center.
    const column = trigger.current?.closest("aside")?.getBoundingClientRect();
    if (column && column.width > 0) node.style.setProperty("--dialog-center", `${Math.round(column.left + column.width / 2)}px`);
    node.showModal();
    node.focus();
  }, []);
  return <aside className={styles.card} aria-labelledby={headingId}>
    {illustration && <div className={styles.thumbnail} aria-hidden="true"><div inert>{illustration}</div></div>}
    <div className={styles.content}>
      <h2 id={headingId} className={styles.eyebrow}>What’s new</h2>
      <h3>{title}</h3>
      <p>{summary}</p>
    </div>
    <button ref={trigger} type="button" className={`commandSecondaryAction ${styles.open}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>See what’s new</button>
    <CommandIcon name="chevron" size="small" className={`commandIcon ${styles.chevron}`} />
    <button type="button" className={`commandIconAction ${styles.dismiss}`} aria-label="Dismiss this update" onClick={onDismiss}><CommandIcon name="close" /></button>
    {open && <dialog ref={showDialog} className={styles.dialog} tabIndex={-1} aria-labelledby={dialogTitleId}
      onClose={() => { setOpen(false); trigger.current?.focus(); }}
      onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <button type="button" className={`commandIconAction ${styles.close}`} aria-label="Close" onClick={() => dialog.current?.close()}><CommandIcon name="close" /></button>
      {illustration && <div className={styles.stage} aria-hidden="true"><div inert>{illustration}</div></div>}
      <div className={styles.body}>
        <p className={styles.eyebrow}>What’s new</p>
        <h2 id={dialogTitleId} className={styles.title}>{title}</h2>
        <p className={styles.description}>{description}</p>
        {highlights.length > 0 && <ul className={styles.highlights}>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}
      </div>
      <div className={styles.actions}>
        <button type="button" className="commandPrimaryAction" onClick={() => dialog.current?.close()}>Got it</button>
      </div>
    </dialog>}
  </aside>;
}
