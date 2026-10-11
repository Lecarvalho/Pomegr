import type { DocsSearchHeading, DocsSearchIndex, DocsSearchPage } from "../../scripts/docs-search.mjs";

// Plain word-prefix matching over the prepared index; every query word must match, ranked by title, heading, description, then body.
// A one-character word is not matched as a prefix (it would match nearly every page) but still counts toward the phrase bonus.

export const MAX_RESULTS = 8;
export const MAX_HEADINGS_PER_RESULT = 3;
export const MAX_QUERY_LENGTH = 100;
export const MIN_PREFIX_LENGTH = 2;
const MAX_QUERY_WORDS = 8;

const WEIGHT = { title: 12, heading: 8, description: 4, text: 1 } as const;
const PHRASE_BONUS = { title: 10, heading: 6 } as const;

export interface SearchResult {
  page: DocsSearchPage;
  headings: DocsSearchHeading[];
  score: number;
}

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

function containsPhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length < 2) return false;
  for (let start = 0; start + phrase.length <= haystack.length; start += 1) {
    if (phrase.every((token, offset) => haystack[start + offset].startsWith(token))) return true;
  }
  return false;
}

export interface SearchOutcome {
  total: number;
  results: SearchResult[];
}

const queryWords = (query: string) => words(query.slice(0, MAX_QUERY_LENGTH)).slice(0, MAX_QUERY_WORDS);

export const isSearchable = (query: string) => queryWords(query).some((word) => word.length >= MIN_PREFIX_LENGTH);

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
