import type { DocsSearchHeading, DocsSearchIndex, DocsSearchPage } from "../../scripts/docs-search.mjs";

// Matching for the documentation search (WEB-03): plain, deterministic word-prefix matching over
// the prepared index. No fuzzy matching and no dependency, because the index is 17 short pages
// and a visitor types the words they see in a title or heading. Every query word must match
// somewhere in a page (AND), and a page ranks by where each word matches: title, then a heading,
// then the description, then the body text. A one-character word such as the "a" in "Spot a
// compaction" is not matched as a prefix, because it would match nearly every page and heading; it
// still counts toward the phrase bonus, so typing a heading word for word keeps ranking it first.
// This module is pure so the tests can drive it directly.

export const MAX_RESULTS = 8;
export const MAX_HEADINGS_PER_RESULT = 3;
export const MAX_QUERY_LENGTH = 100;
export const MIN_PREFIX_LENGTH = 2;
const MAX_QUERY_WORDS = 8;

const WEIGHT = { title: 12, heading: 8, description: 4, text: 1 } as const;
const PHRASE_BONUS = { title: 10, heading: 6 } as const;

export interface SearchResult {
  page: DocsSearchPage;
  /** Headings that contain at least one query word, strongest first, then in document order. */
  headings: DocsSearchHeading[];
  score: number;
}

/** Lowercase words of a text: letters and digits only, accents folded. */
export function words(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

interface PreparedPage {
  title: string[];
  headings: string[][];
  description: string[];
  text: string[];
}

const prepared = new WeakMap<DocsSearchPage, PreparedPage>();

function prepare(page: DocsSearchPage): PreparedPage {
  let entry = prepared.get(page);
  if (!entry) {
    entry = {
      title: words(page.title),
      headings: page.headings.map((heading) => words(heading.text)),
      description: words(page.description),
      text: words(page.text),
    };
    prepared.set(page, entry);
  }
  return entry;
}

const matches = (haystack: readonly string[], token: string) => haystack.some((word) => word.startsWith(token));

/** Whether `phrase` appears as consecutive words of `haystack`, each query word a prefix of its word. */
function containsPhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length < 2) return false;
  for (let start = 0; start + phrase.length <= haystack.length; start += 1) {
    if (phrase.every((token, offset) => haystack[start + offset].startsWith(token))) return true;
  }
  return false;
}

export interface SearchOutcome {
  /** How many pages contain every query word, before the result limit. */
  total: number;
  /** At most MAX_RESULTS pages, best first. */
  results: SearchResult[];
}

const queryWords = (query: string) => words(query.slice(0, MAX_QUERY_LENGTH)).slice(0, MAX_QUERY_WORDS);

/** Whether `query` holds a word long enough to match; when it does not, the interface asks for more letters. */
export const isSearchable = (query: string) => queryWords(query).some((word) => word.length >= MIN_PREFIX_LENGTH);

/**
 * The pages that contain every word of `query` that is at least MIN_PREFIX_LENGTH characters, best
 * first (ties keep reading order). An empty query, or one with no such word, matches nothing.
 */
export function searchDocs(index: DocsSearchIndex, query: string): SearchOutcome {
  const phrase = queryWords(query);
  const tokens = [...new Set(phrase)].filter((word) => word.length >= MIN_PREFIX_LENGTH);
  if (tokens.length === 0) return { total: 0, results: [] };

  const results: Array<SearchResult & { order: number }> = [];
  index.pages.forEach((page, order) => {
    const fields = prepare(page);
    const headingMatches = fields.headings.map((heading) => tokens.filter((token) => matches(heading, token)).length);
    let score = 0;
    for (const token of tokens) {
      if (matches(fields.title, token)) score += WEIGHT.title;
      else if (fields.headings.some((heading) => matches(heading, token))) score += WEIGHT.heading;
      else if (matches(fields.description, token)) score += WEIGHT.description;
      else if (matches(fields.text, token)) score += WEIGHT.text;
      else return;
    }
    if (containsPhrase(fields.title, phrase)) score += PHRASE_BONUS.title;
    if (fields.headings.some((heading) => containsPhrase(heading, phrase))) score += PHRASE_BONUS.heading;

    const headings = page.headings
      .map((heading, position) => ({ heading, position, hits: headingMatches[position] }))
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.position - b.position)
      .slice(0, MAX_HEADINGS_PER_RESULT)
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.heading);
    results.push({ page, headings, score, order });
  });

  results.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    total: results.length,
    results: results.slice(0, MAX_RESULTS).map(({ page, headings, score }) => ({ page, headings, score })),
  };
}
