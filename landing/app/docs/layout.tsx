import type { ReactNode } from "react";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { docsContent } from "./content";
import { DocsNav } from "./DocsNav";
import styles from "./docs.module.css";

// `docs-` ids never match a heading slug, because headings carry their slug as the element id.
const CONTENT_ID = "docs-content";

export default function DocsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href={`#${CONTENT_ID}`}>Skip to documentation content</a>
      <SiteHeader current="docs" />
      <div className={styles.frame}>
        <DocsNav navigation={docsContent.navigation} contentId={CONTENT_ID} />
        <main id={CONTENT_ID} className={styles.main} tabIndex={-1}>{children}</main>
      </div>
      <SiteFooter current="docs" />
    </div>
  );
}
