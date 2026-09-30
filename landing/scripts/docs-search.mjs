// Search index for the public documentation website (WEB-03).
//
// A pure function of the prepared content (`docs-content.mjs` output): it reads no files and
// names no path, so the index can only contain what the published pages already contain, and it
// carries the same `revision` as the pages and the sitemap. `writePreparedDocs` writes it beside
// the content as `generated/docs-search.json`; the browser loads it lazily on first use and the
// Worker never reads it. The matching rules live in `app/docs/search.ts`.
//
// Shape (per page, in reading order): route, group title, title, description, the `##` to `####`
// headings as { id, text }, and a bounded plain-text body. Code blocks, image alt text and the
// single `#` title are left out; the body is cut at a word boundary after SEARCH_TEXT_LIMIT
// characters, so the index stays small however long a page grows.

export const SEARCH_SCHEMA_VERSION = 1;

/** Generated output, relative to the landing root (gitignored, like the content it derives from). */
export const GENERATED_SEARCH_FILE = "generated/docs-search.json";

/** Longest plain-text body kept per page, in characters. */
export const SEARCH_TEXT_LIMIT = 2000;

/** Upper bound for the serialized index; the audit and the tests fail above it. */
export const SEARCH_INDEX_MAX_BYTES = 128 * 1024;

function inlineText(inlines) {
  let text = "";
  for (const inline of inlines) {
    if (inline.type === "text" || inline.type === "code") text += inline.text;
    else if (inline.type === "br") text += " ";
    else if (inline.type === "strong" || inline.type === "em" || inline.type === "link") text += inlineText(inline.children);
    // Images carry alt text only for the reader of the picture; it is not searchable body text.
  }
  return text;
}

function blockText(blocks, parts) {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        parts.push(inlineText(block.children));
        break;
      case "list":
        for (const item of block.items) blockText(item, parts);
        break;
      case "table":
        parts.push(block.header.map(inlineText).join(" "));
        for (const row of block.rows) parts.push(row.map(inlineText).join(" "));
        break;
      case "callout":
      case "quote":
        blockText(block.blocks, parts);
        break;
      // Headings are indexed separately and code blocks are not prose.
      default:
        break;
    }
  }
  return parts;
}

/** Collapse whitespace and cut at the last word boundary that keeps the text within `limit`. */
function bound(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = /\s/.test(flat[limit]) ? limit : cut.lastIndexOf(" ");
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
}

/** Build the search index of a prepared content object (see `DocsContent`). */
export function buildSearchIndex(content) {
  const groupTitles = new Map(content.navigation.map((group) => [group.id, group.title]));
  return {
    schema: SEARCH_SCHEMA_VERSION,
    revision: content.revision,
    pages: content.pages.map((page) => ({
      route: page.route,
      group: groupTitles.get(page.group) ?? page.group,
      title: page.title,
      description: page.description,
      headings: page.headings.filter((heading) => heading.depth >= 2).map((heading) => ({ id: heading.id, text: heading.text })),
      text: bound(blockText(page.blocks, []).join(" "), SEARCH_TEXT_LIMIT),
    })),
  };
}

/** Deterministic serialization: stable key order, compact, LF, no timestamps. */
export function serializeSearchIndex(index) {
  return `${JSON.stringify(index)}\n`;
}
