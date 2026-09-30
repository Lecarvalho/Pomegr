import type { ReactNode } from "react";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { docsContent } from "./content";
import { DocsNav } from "./DocsNav";
import styles from "./docs.module.css";

// Layout ids use the `docs-` prefix and never match a heading slug in the published pages (the
// route tests check this), because page headings carry their GitHub-style slug as the element id.
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
