"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import type { DocsSearchIndex } from "../../scripts/docs-search.mjs";
import { MAX_QUERY_LENGTH, MIN_PREFIX_LENGTH, isSearchable, searchDocs } from "./search";
import styles from "./search.module.css";

// Docs search at the top of the sidebar panel (also in the phone menu). Results replace `children`; the index loads on first focus and is never read from the content module, which the browser must not bundle.

const INPUT_ID = "docs-search-input";
const STATUS_ID = "docs-search-status";
const RESULTS_ID = "docs-search-results";

let indexRequest: Promise<DocsSearchIndex> | null = null;

function loadIndex(): Promise<DocsSearchIndex> {
  indexRequest ??= import("../../generated/docs-search.json").then(
    (module) => module.default as unknown as DocsSearchIndex,
    (error: unknown) => {
      indexRequest = null;
      throw error;
    },
  );
  return indexRequest;
}

interface DocsSearchProps {
  children: ReactNode;
  onNavigate?: () => void;
}

const plural = (count: number) => (count === 1 ? "1 page matches" : `${count} pages match`);

export function DocsSearch({ children, onNavigate }: DocsSearchProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<DocsSearchIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const requested = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  function requestIndex() {
    if (index || requested.current) return;
    requested.current = true;
    setFailed(false);
    loadIndex().then(setIndex, () => {
      requested.current = false;
      setFailed(true);
    });
  }

  const outcome = useMemo(() => (index && query.trim() ? searchDocs(index, query) : null), [index, query]);
  const trimmed = query.trim();

  let status = "";
  if (trimmed && !isSearchable(trimmed)) status = `Type at least ${MIN_PREFIX_LENGTH} letters.`;
  else if (failed && trimmed) status = "Search is unavailable right now. Use the page list instead.";
  else if (outcome && outcome.total === 0) status = `No pages match “${trimmed}”.`;
  else if (outcome && outcome.total > outcome.results.length) status = `Showing the best ${outcome.results.length} of ${outcome.total} pages.`;
  else if (outcome) status = plural(outcome.total);

  const showResults = outcome !== null && outcome.results.length > 0;

  const resultLinks = () => [...(root.current?.querySelectorAll<HTMLAnchorElement>(`#${RESULTS_ID} a`) ?? [])];

  function choose() {
    setQuery("");
    onNavigate?.();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resultLinks()[0]?.click();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && query !== "") {
      // The first Escape only clears the search; it must not also close the phone menu around it.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      field.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = resultLinks();
    if (links.length === 0) return;
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "ArrowUp" && at === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    if (next < 0) field.current?.focus();
    else if (next < links.length) links[next].focus();
  }

  return (
    <>
      <div ref={root} className={styles.search} onKeyDown={onKeyDown} onFocus={requestIndex}>
        <form role="search" onSubmit={onSubmit}>
          <label className={styles.label} htmlFor={INPUT_ID}>Search documentation</label>
          <input
            ref={field}
            id={INPUT_ID}
            className={styles.field}
            type="search"
            name="q"
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="Pages and sections"
            aria-controls={showResults ? RESULTS_ID : undefined}
            aria-describedby={STATUS_ID}
            onChange={(event) => {
              setQuery(event.target.value);
              requestIndex();
            }}
          />
        </form>
        <p id={STATUS_ID} className={styles.status} role="status" aria-live="polite">{status}</p>
        {outcome && showResults ? (
          <ul id={RESULTS_ID} className={styles.results} aria-label="Search results">
            {outcome.results.map(({ page, headings }) => (
              <li key={page.route} className={styles.result}>
                <p className={styles.group}>{page.group}</p>
                <Link href={page.route} className={styles.pageLink} onClick={choose}>{page.title}</Link>
                {headings.length > 0 ? (
                  <ul className={styles.headings} aria-label={`Matching sections in ${page.title}`}>
                    {headings.map((heading) => (
                      <li key={heading.id}>
                        <Link href={`${page.route}#${heading.id}`} className={styles.headingLink} onClick={choose}>{heading.text}</Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {showResults ? null : children}
    </>
  );
}
