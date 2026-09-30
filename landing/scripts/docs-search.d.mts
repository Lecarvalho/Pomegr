// Types for the documentation search index (`landing/generated/docs-search.json`). Import types
// only from runtime code: the browser loads the generated JSON, never `docs-search.mjs`.

import type { DocsContent } from "./docs-content.mjs";

export interface DocsSearchHeading {
  /** The heading's anchor id on its page (a GitHub-style slug). */
  id: string;
  text: string;
}

export interface DocsSearchPage {
  /** `/docs/<group>/<slug>`, the same route the page is served at. */
  route: string;
  /** Display title of the navigation group. */
  group: string;
  title: string;
  description: string;
  /** `##` to `####` headings in document order. */
  headings: DocsSearchHeading[];
  /** Bounded plain-text body: no code blocks, no image alt text. */
  text: string;
}

export interface DocsSearchIndex {
  schema: 1;
  /** The revision of the content the index was built from; equal to `DocsContent.revision`. */
  revision: string;
  /** Pages in reading order. */
  pages: DocsSearchPage[];
}

export const SEARCH_SCHEMA_VERSION: 1;
export const GENERATED_SEARCH_FILE: string;
export const SEARCH_TEXT_LIMIT: number;
export const SEARCH_INDEX_MAX_BYTES: number;

export function buildSearchIndex(content: DocsContent): DocsSearchIndex;
export function serializeSearchIndex(index: DocsSearchIndex): string;
