import Link from "next/link";
import { PomegrBrand } from "./PomegrBrand";
import styles from "./SiteChrome.module.css";

const REPOSITORY = "https://github.com/Lecarvalho/pomegr";

export function SiteHeader({ current }: { current: "home" | "about" | "download" }) {
  return (
    <header className={styles.header}>
      <PomegrBrand />
      <nav aria-label="Main navigation">
        <Link href="/" aria-current={current === "home" ? "page" : undefined}>Home</Link>
        <Link href="/about" aria-current={current === "about" ? "page" : undefined}>About</Link>
        <a href={REPOSITORY} target="_blank" rel="noreferrer">Source</a>
        <Link className={styles.headerAction} href="/download" aria-current={current === "download" ? "page" : undefined}>Download for Windows</Link>
      </nav>
    </header>
  );
}
