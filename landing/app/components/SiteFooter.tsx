import { PomegrBrand } from "./PomegrBrand";
import styles from "./SiteChrome.module.css";

const REPOSITORY = "https://github.com/Lecarvalho/pomegr";
const REPO_FILE = `${REPOSITORY}/blob/main`;

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <PomegrBrand />
      <nav aria-label="Legal and project links">
        <a href={`${REPO_FILE}/LICENSE`} target="_blank" rel="noreferrer">License</a>
        <a href={`${REPO_FILE}/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer">Notices</a>
        <a href={REPOSITORY} target="_blank" rel="noreferrer">Source</a>
        <a href={`${REPO_FILE}/TRADEMARKS.md`} target="_blank" rel="noreferrer">Trademark policy</a>
      </nav>
    </footer>
  );
}
