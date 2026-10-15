import Link from "next/link";
import { PomegrBrand } from "./PomegrBrand";
import styles from "./SiteChrome.module.css";

const REPOSITORY = "https://github.com/Lecarvalho/pomegr";

export function SiteHeader({ current }: { current: "home" | "docs" | "download" }) {
  return (
    <header className={styles.header}>
      <PomegrBrand />
      <nav aria-label="Main navigation">
        <Link href="/" aria-current={current === "home" ? "page" : undefined}>Home</Link>
        <Link className={styles.phoneLink} href="/docs" aria-current={current === "docs" ? "page" : undefined}>Docs</Link>
        <a href={REPOSITORY} target="_blank" rel="noreferrer">Source</a>
      </nav>
    </header>
  );
}
