import type { Metadata } from "next";
import Link from "next/link";
import { docsContent } from "./content";
import styles from "./docs.module.css";

export const metadata: Metadata = { title: "Page not found" };

export default function DocsNotFound() {
  return (
    <div className={styles.notFound}>
      <p className={styles.eyebrow}>Error 404</p>
      <h1>This page is not in the documentation.</h1>
      <p>
        Choose a page from the navigation
        {docsContent.entry ? <>, or start from <Link href={docsContent.entry}>the first page</Link></> : null}.
      </p>
    </div>
  );
}
