"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import styles from "./HomeUpdateCard.module.css";

const AUTO_OPEN_DELAY_MS = 300;

type HomeUpdateCardProps = {
  title: string;
  description: string;
  highlights: string[];
  illustration?: ReactNode;
  autoOpen?: boolean;
  onAutoOpen?(): void;
  onDismiss(): void;
};

/** The What's new line: one quiet action that names the announcement and opens its dialog, and an icon dismiss. The announcement is the dialog. */
export function HomeUpdateCard({ title, description, highlights, illustration, autoOpen = false, onAutoOpen, onDismiss }: HomeUpdateCardProps) {
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
    node.showModal();
    node.focus();
  }, []);
  return <aside className={styles.line} aria-label="What’s new">
    <button ref={trigger} type="button" className={`commandQuietAction ${styles.open}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span className={styles.eyebrow}>What’s new</span><span className={styles.name}>{title}</span>
    </button>
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
