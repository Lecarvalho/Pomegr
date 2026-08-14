import Link from "next/link";
import { PomegrBrand } from "./PomegrBrand";
import { WaitlistStatusLink } from "./WaitlistStatusLink";
import styles from "./SiteChrome.module.css";

const REPOSITORY = "https://github.com/Lecarvalho/pomegr";

export function SiteHeader({ current }: { current: "home" | "about" }) {
  return (
    <header className={styles.header}>
      <PomegrBrand />
      <nav aria-label="Main navigation">
        {current === "home" ? <Link href="/about">About</Link> : <Link href="/">Home</Link>}
        <a href={REPOSITORY} target="_blank" rel="noreferrer">Source</a>
        <WaitlistStatusLink className={styles.headerAction} />
      </nav>
    </header>
  );
}
