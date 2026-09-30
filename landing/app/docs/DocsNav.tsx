"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DocsNavigationGroup } from "../../scripts/docs-content.mjs";
import styles from "./docs.module.css";

// The documentation sidebar. It is always visible beside the page on wide screens; on a phone a
// real button discloses it in place. It is a client component only for that disclosure and for
// reading the current route: the page list comes from the generated navigation, never from hand
// written links.

const PANEL_ID = "docs-nav-panel";

interface DocsNavProps {
  navigation: readonly DocsNavigationGroup[];
  /** Id of the focusable main element a phone visitor lands on after choosing a page. */
  contentId: string;
}

const withoutTrailingSlash = (path: string | null) => (path && path.length > 1 ? path.replace(/\/+$/, "") : (path ?? ""));

export function DocsNav({ navigation, contentId }: DocsNavProps) {
  const current = withoutTrailingSlash(usePathname());
  // The menu remembers the page it was opened on, so it closes by itself on any navigation
  // (including Back) without an effect that sets state.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === current;
  const toggle = useRef<HTMLButtonElement>(null);

  function choosePage() {
    if (!open) return;
    setOpenOn(null);
    // The clicked link is about to be hidden; keep focus in the document instead of losing it to the body.
    document.getElementById(contentId)?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpenOn(null);
    toggle.current?.focus();
  }

  return (
    <nav className={styles.nav} aria-label="Documentation" onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        type="button"
        className={styles.navToggle}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpenOn(open ? null : current)}
      >
        <span>Documentation menu</span>
        <svg className={styles.navChevron} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div id={PANEL_ID} className={styles.navPanel} data-open={open ? "true" : "false"}>
        {navigation.map((group) => {
          const titleId = `docs-nav-group-${group.id}`;
          return (
            <div key={group.id} className={styles.navGroup}>
              <p id={titleId} className={styles.navGroupTitle}>{group.title}</p>
              <ul className={styles.navList} aria-labelledby={titleId}>
                {group.pages.map((page) => (
                  <li key={page.route}>
                    <Link
                      href={page.route}
                      className={styles.navLink}
                      aria-current={page.route === current ? "page" : undefined}
                      onClick={choosePage}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
