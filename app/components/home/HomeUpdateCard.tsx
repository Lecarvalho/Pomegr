"use client";

import Link from "next/link";
import { useId } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import styles from "./HomeUpdateCard.module.css";

type HomeUpdateCardProps = {
  title: string;
  description: string;
  details: string;
  href: string;
  linkLabel: string;
  onDismiss(): void;
};

export function HomeUpdateCard({ title, description, details, href, linkLabel, onDismiss }: HomeUpdateCardProps) {
  const headingId = useId();
  return <aside className={styles.card} aria-labelledby={headingId}>
    <h2 id={headingId}>What’s new</h2>
    <div className={styles.content}>
      <h3>{title}</h3>
      <p>{description}</p>
      <Link className={styles.link} href={href}>{linkLabel}<CommandIcon name="arrow" size="small" /></Link>
    </div>
    <details>
      <summary>About this update<CommandIcon name="arrow" size="small" /></summary>
      <p>{details}</p>
    </details>
    <button type="button" className={styles.dismiss} aria-label="Dismiss this update" onClick={onDismiss}><CommandIcon name="close" /></button>
  </aside>;
}
