import type { Metadata } from "next";
import Link from "next/link";
import { docsContent } from "./content";
import styles from "./docs.module.css";

export const metadata: Metadata = { title: "Page not found" };

// Rendered inside the docs layout when a slug is not a published page, so the navigation stays
// available. The response status is 404, and the framework adds `noindex`.
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
