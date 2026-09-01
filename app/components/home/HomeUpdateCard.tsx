"use client";

import { useId } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import styles from "./HomeUpdateCard.module.css";

type HomeUpdateCardProps = {
  title: string;
  description: string;
  details: string;
  onDismiss(): void;
};

export function HomeUpdateCard({ title, description, details, onDismiss }: HomeUpdateCardProps) {
  const headingId = useId();
  return <aside className={styles.card} aria-labelledby={headingId}>
    <h2 id={headingId}>What’s new</h2>
    <div className={styles.content}>
      <h3>{title}</h3>
      <p>{description}</p>
      <details>
        <summary>About this update<CommandIcon name="arrow" size="small" /></summary>
        <p>{details}</p>
      </details>
    </div>
    <button type="button" className={styles.dismiss} aria-label="Dismiss this update" onClick={onDismiss}><CommandIcon name="close" size="small" /></button>
  </aside>;
}
