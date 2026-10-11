// Search index for the public docs: a pure function of the prepared content, so it can only contain what the pages already contain.
// The body is bounded plain text cut at a word boundary after SEARCH_TEXT_LIMIT characters.

export const SEARCH_SCHEMA_VERSION = 1;

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

function bound(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = /\s/.test(flat[limit]) ? limit : cut.lastIndexOf(" ");
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
}

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

export function serializeSearchIndex(index) {
  return `${JSON.stringify(index)}\n`;
}
