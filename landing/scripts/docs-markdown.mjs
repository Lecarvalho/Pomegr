// Pure Markdown handling for the public documentation loader (WEB-01): front matter, heading
// anchors, link and image resolution, and conversion of marked lexer tokens into the structured
// blocks the website renders. It performs no filesystem access and names no path outside the
// package; `docs-content.mjs` supplies the pages and an image reader. Raw HTML never survives:
// every html token is an error.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { marked } from "marked";

// ---------------------------------------------------------------------------
// Shared constants and primitives

export const PUBLIC_LABEL = "docs/public/";
export const IMAGE_ROUTE_PREFIX = "/docs/images/";
export const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)*";

const MAX_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_ALT_CHARS = 600;
const MAX_HEADING_DEPTH = 4;
const MAX_HREF_CHARS = 2048;
const IMAGE_SOURCE_PATTERN = new RegExp(`^images/(${KEBAB})/([A-Za-z0-9][A-Za-z0-9._-]*)\\.(png|jpg|jpeg|webp|gif)$`);
const FRAGMENT_PATTERN = /^[\p{L}\p{M}\p{N}\p{Pc}-]+$/u;
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const BIDI_CONTROLS = /\p{Bidi_C}/u;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CODE_LANGUAGE = /^[A-Za-z0-9_+-]{1,24}$/;

const IMAGE_SIGNATURES = {
  png: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  gif: (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  webp: (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length > 12 && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
};

// Named character references decoded from text. Numeric references are already resolved
// by the Markdown lexer; unknown names stay literal, as CommonMark specifies.
const NAMED_REFERENCES = Object.fromEntries(
  Object.entries({
    amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0,
    ndash: 0x2013, mdash: 0x2014, hellip: 0x2026, lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d,
    copy: 0xa9, reg: 0xae, trade: 0x2122, rarr: 0x2192, larr: 0x2190, uarr: 0x2191, darr: 0x2193,
    middot: 0xb7, times: 0xd7, deg: 0xb0, plusmn: 0xb1, bull: 0x2022, laquo: 0xab, raquo: 0xbb,
  }).map(([name, codePoint]) => [name, String.fromCodePoint(codePoint)]),
);

function startsWith(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const quote = (value) => JSON.stringify(String(value).length > 80 ? `${String(value).slice(0, 77)}...` : String(value));

// ---------------------------------------------------------------------------
// Text, slugs, and character references

/** Decode the named character references in `NAMED_REFERENCES` in one pass. */
export function decodeCharacterReferences(text) {
  return text.replace(/&([A-Za-z]+);/g, (match, name) => NAMED_REFERENCES[name] ?? match);
}

/**
 * GitHub-compatible heading anchor for already-rendered plain heading text: lowercase,
 * drop everything except letters, marks, numbers, connector punctuation, hyphens and
 * spaces, then turn each space into a hyphen. The renderer, link validation and the
 * future docs checker all use this function.
 */
export function slugifyHeading(text) {
  return String(text).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
}

/** A per-page slug allocator: repeats get `-1`, `-2`, ... and never reuse a prior ID. */
export function createSlugger() {
  const used = new Set();
  const counts = new Map();
  return (text) => {
    const base = slugifyHeading(text);
    let id = base;
    if (used.has(id)) {
      let count = counts.get(base) ?? 0;
      do {
        count += 1;
        id = `${base}-${count}`;
      } while (used.has(id));
      counts.set(base, count);
    }
    used.add(id);
    return id;
  };
}

/** Plain rendered text of marked inline tokens (no markup, references decoded). */
function inlineText(tokens) {
  let out = "";
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
        out += token.tokens?.length ? inlineText(token.tokens) : decodeCharacterReferences(token.text);
        break;
      case "escape":
      case "codespan":
        out += token.text;
        break;
      case "br":
        out += " ";
        break;
      case "html":
      case "checkbox":
        break;
      default:
        out += inlineText(token.tokens);
    }
  }
  return out;
}

const softBreaks = (text) => text.replace(/[ \t]*\n[ \t]*/g, " ");

function plainTextOfInlines(nodes) {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "code") out += node.text;
    else if (node.type === "br") out += " ";
    else if (node.type === "image") out += node.alt;
    else out += plainTextOfInlines(node.children);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Front matter

function parseScalar(value) {
  if (value.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) return { error: "a double-quoted value must be one complete string" };
    try {
      return { value: JSON.parse(value) };
    } catch {
      return { error: "invalid escape in double-quoted value" };
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return { error: "a single-quoted value must be one complete string" };
    return { value: value.slice(1, -1).replaceAll("''", "'") };
  }
  if (value === "" || /^[[{&*!|>%@`#]/.test(value) || / #/.test(value) || value.includes(": ")) {
    return { error: "use a quoted string for this value" };
  }
  return { value };
}

/**
 * Parse the `---` front matter of a public page: only `title` and `description`, each a
 * single-line plain-text string. `markdown` must already use LF line endings.
 */
export function parseFrontMatter(markdown) {
  const issues = [];
  const fail = (message, line) => issues.push({ message, line });
  if (!markdown.startsWith("---\n")) {
    fail("the page must begin with a --- front matter block holding title and description", 1);
    return { metadata: null, body: markdown, bodyLine: 1, issues };
  }
  const lines = markdown.split("\n");
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) {
    fail("the front matter block is not closed with ---", 1);
    return { metadata: null, body: markdown, bodyLine: 1, issues };
  }

  const values = new Map();
  for (let index = 1; index < end; index += 1) {
    const text = lines[index];
    if (text.trim() === "") continue;
    const line = index + 1;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/.exec(text);
    if (!match) {
      fail("unsupported front matter line; use single-line key: value entries", line);
      continue;
    }
    const [, key, rawValue] = match;
    if (key !== "title" && key !== "description") {
      fail(`unknown front matter key ${quote(key)}; only title and description are allowed`, line);
      continue;
    }
    if (values.has(key)) {
      fail(`front matter key "${key}" is repeated`, line);
      continue;
    }
    const parsed = parseScalar(rawValue);
    if (parsed.error) {
      fail(`${key}: ${parsed.error}`, line);
      continue;
    }
    values.set(key, parsed.value.trim());
  }

  const limits = { title: MAX_TITLE_CHARS, description: MAX_DESCRIPTION_CHARS };
  for (const key of ["title", "description"]) {
    const value = values.get(key);
    if (value === undefined) fail(`front matter is missing "${key}"`, 1);
    else if (value === "" || value.length > limits[key] || CONTROL_CHARACTERS.test(value) || BIDI_CONTROLS.test(value) || /[<>]/.test(value)) {
      fail(`${key} must be non-empty single-line plain text of at most ${limits[key]} characters without < or >`, 1);
    }
  }

  const body = lines.slice(end + 1).join("\n");
  const metadata = issues.length ? null : { title: values.get("title"), description: values.get("description") };
  return { metadata, body, bodyLine: end + 2, issues };
}

// ---------------------------------------------------------------------------
// Link and image resolution

/** Resolve a link destination relative to `fromSource`; returns a `{ source, fragment }` or an error. */
function resolveRelativeTarget(fromSource, href) {
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex < 0 ? href : href.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? "" : href.slice(hashIndex + 1);
  if (hashIndex >= 0 && !FRAGMENT_PATTERN.test(fragment)) return { error: `the fragment ${quote(fragment)} is not a heading anchor` };
  if (pathPart === "") return { source: null, fragment };
  if (/[\\%?*:[\]{}<>|"'\s\u0000-\u001f]/.test(pathPart)) {
    return { error: `${quote(href)} must be a plain relative path: no backslashes, encoding, queries, spaces or globs` };
  }
  if (pathPart.startsWith("/")) return { error: `${quote(href)} is root-relative; author local links as relative Markdown paths` };
  if (pathPart.split("/").some((segment) => segment === "")) return { error: `${quote(href)} has an empty path segment` };
  const joined = posix.normalize(posix.join(posix.dirname(fromSource), pathPart));
  if (/^\.\.(?:\/|$)/.test(joined) || posix.isAbsolute(joined)) {
    return { error: `${quote(href)} resolves outside ${PUBLIC_LABEL}` };
  }
  return { source: joined, fragment };
}

// ---------------------------------------------------------------------------
// Markdown -> structured blocks

const SUPPORTED_BLOCKS = "headings, paragraphs, lists, tables, fenced code, blockquotes and images";

export function createConverter(state) {
  const { page, pagesBySource, readImage, imagesByRoute, issues } = state;
  const pageLabel = `${PUBLIC_LABEL}${page.source}`;
  const ctx = { line: page.bodyLine, headingIndex: 0 };
  const fail = (message) => issues.push(`${pageLabel}:${ctx.line}: ${message}`);

  function resolveLink(href) {
    if (typeof href !== "string" || href.trim() === "" || href.length > MAX_HREF_CHARS || /[\x00-\x20\x7f\\]/.test(href)) {
      fail(`unsupported link destination ${quote(href ?? "")}`);
      return null;
    }
    if (href.startsWith("//")) {
      fail(`protocol-relative link ${quote(href)} is not allowed`);
      return null;
    }
    if (SCHEME_PATTERN.test(href)) {
      let url;
      try {
        url = new URL(href);
      } catch {
        fail(`invalid link ${quote(href)}`);
        return null;
      }
      if (url.protocol === "mailto:") {
        if (url.pathname) return { href, external: true };
        fail(`invalid link ${quote(href)}`);
        return null;
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
        fail(`link scheme is not allowed in ${quote(href)}; use https:, http: or mailto:`);
        return null;
      }
      return { href, external: true };
    }
    const target = resolveRelativeTarget(page.source, href);
    if (target.error) {
      fail(target.error);
      return null;
    }
    let targetPage = page;
    if (target.source !== null) {
      if (!target.source.endsWith(".md")) {
        fail(`${quote(href)} must link to a Markdown page selected by the manifest`);
        return null;
      }
      targetPage = pagesBySource.get(target.source);
      if (!targetPage) {
        fail(`${quote(href)} links to ${PUBLIC_LABEL}${target.source}, which the manifest does not select`);
        return null;
      }
    }
    if (target.fragment && !targetPage.ids.has(target.fragment)) {
      fail(`${quote(href)} points to a heading anchor that does not exist in ${targetPage.source}`);
      return null;
    }
    const fragment = target.fragment ? `#${target.fragment}` : "";
    return { href: target.source === null ? fragment : `${targetPage.route}${fragment}`, external: false };
  }

  function resolveImage(href) {
    const generic = `image ${quote(href ?? "")} must be a relative path to an image under ${PUBLIC_LABEL}images/<topic>/`;
    if (typeof href !== "string" || SCHEME_PATTERN.test(href) || href.startsWith("//") || href.includes("#")) {
      fail(generic);
      return null;
    }
    const target = resolveRelativeTarget(page.source, href);
    if (target.error) {
      fail(`image ${target.error}`);
      return null;
    }
    if (target.source === null) {
      fail(generic);
      return null;
    }
    const match = IMAGE_SOURCE_PATTERN.exec(target.source);
    if (!match) {
      fail(`image ${quote(href)} must resolve to ${PUBLIC_LABEL}images/<topic>/<file> with a png, jpg, jpeg, webp or gif extension`);
      return null;
    }
    const route = `${IMAGE_ROUTE_PREFIX}${target.source.slice("images/".length)}`;
    if (!imagesByRoute.has(route)) {
      let data;
      try {
        data = readImage(target.source);
      } catch (error) {
        fail(`image ${quote(href)}: ${error.message}`);
        return null;
      }
      if (!IMAGE_SIGNATURES[match[3]](data)) {
        fail(`image ${quote(href)} does not contain ${match[3]} data`);
        return null;
      }
      imagesByRoute.set(route, { route, relativePath: target.source.slice("images/".length), bytes: data.length, sha256: sha256(data), data });
    }
    return route;
  }

  function pushText(out, text) {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += text;
    else out.push({ type: "text", text });
  }

  function inlines(tokens) {
    const out = [];
    for (const token of tokens ?? []) {
      switch (token.type) {
        case "text":
          if (token.tokens?.length) {
            for (const node of inlines(token.tokens)) {
              if (node.type === "text") pushText(out, node.text);
              else out.push(node);
            }
          } else pushText(out, softBreaks(decodeCharacterReferences(token.text)));
          break;
        case "escape":
          pushText(out, token.text);
          break;
        case "codespan":
          out.push({ type: "code", text: softBreaks(token.text) });
          break;
        case "strong":
        case "em": {
          const children = inlines(token.tokens);
          if (children.length) out.push({ type: token.type, children });
          break;
        }
        case "br":
          out.push({ type: "br" });
          break;
        case "link": {
          if (token.title) fail("link titles are not supported");
          const children = inlines(token.tokens);
          if (plainTextOfInlines(children).trim() === "") fail("a link needs visible text or an image with alt text");
          const resolved = resolveLink(token.href);
          if (resolved) out.push({ type: "link", href: resolved.href, external: resolved.external, children });
          else out.push(...children);
          break;
        }
        case "image": {
          if (token.title) fail("image titles are not supported; describe the image in its alt text");
          const alt = softBreaks(inlineText(token.tokens?.length ? token.tokens : [{ type: "text", text: token.text }])).trim();
          if (alt === "" || alt.length > MAX_ALT_CHARS) fail(`an image needs alt text of 1 to ${MAX_ALT_CHARS} characters`);
          const src = resolveImage(token.href);
          if (src && alt !== "" && alt.length <= MAX_ALT_CHARS) out.push({ type: "image", src, alt });
          break;
        }
        case "html":
          fail(`raw HTML is not allowed (${quote(String(token.text).trim())}); use Markdown`);
          break;
        case "del":
          fail("strikethrough is not supported");
          break;
        default:
          fail(`unsupported inline element "${token.type}"`);
      }
    }
    return out;
  }

  function calloutKind(tokens) {
    const first = tokens.find((token) => token.type !== "space");
    if (first?.type !== "paragraph" || first.tokens?.[0]?.type !== "strong") return null;
    const label = inlineText(first.tokens[0].tokens);
    if (label === "Note:") return "note";
    if (label === "Caution:") return "caution";
    if (label.endsWith(":")) fail(`unsupported callout label ${quote(label)}; use **Note:** or **Caution:**`);
    return null;
  }

  function blocks(tokens, top) {
    const out = [];
    for (const token of tokens) {
      switch (token.type) {
        case "space":
          break;
        case "heading": {
          if (!top) {
            fail("headings must be top-level, not inside lists or blockquotes");
            break;
          }
          const heading = page.headings[ctx.headingIndex];
          ctx.headingIndex += 1;
          if (heading) out.push({ type: "heading", depth: heading.depth, id: heading.id, children: inlines(token.tokens) });
          break;
        }
        case "paragraph":
        case "text": {
          const children = inlines(token.tokens ?? [{ type: "text", text: token.text }]);
          if (children.length) out.push({ type: "paragraph", children });
          break;
        }
        case "list": {
          const items = token.items.map((item) => {
            if (item.task) {
              fail("task lists are not supported in public pages");
              return [];
            }
            return blocks(item.tokens, false);
          });
          out.push({ type: "list", ordered: Boolean(token.ordered), start: token.ordered ? (typeof token.start === "number" ? token.start : 1) : null, items });
          break;
        }
        case "blockquote": {
          const kind = calloutKind(token.tokens);
          const content = blocks(token.tokens, false);
          if (kind) {
            const lead = content[0];
            if (lead?.type === "paragraph") {
              lead.children.shift();
              const next = lead.children[0];
              if (next?.type === "text") next.text = next.text.replace(/^\s+/, "");
              if (next?.type === "text" && next.text === "") lead.children.shift();
              if (lead.children.length === 0) content.shift();
            }
            out.push({ type: "callout", kind, blocks: content });
          } else {
            out.push({ type: "quote", blocks: content });
          }
          break;
        }
        case "code":
          if (token.codeBlockStyle === "indented") fail("indented code blocks are not supported; use a fenced block");
          else if (!CODE_LANGUAGE.test(token.lang ?? "")) fail("a fenced code block must name its language, such as powershell, json or text");
          else out.push({ type: "codeblock", lang: token.lang, text: token.text });
          break;
        case "table": {
          if (token.header.length === 0) {
            fail("a table needs a header row");
            break;
          }
          out.push({
            type: "table",
            align: token.align.map((value) => value ?? null),
            header: token.header.map((cell) => inlines(cell.tokens)),
            rows: token.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
          });
          break;
        }
        case "html":
          fail(`raw HTML is not allowed (${quote(String(token.text).trim())}); use Markdown`);
          break;
        case "hr":
          fail("horizontal rules are not supported");
          break;
        case "def":
          fail("reference-style link definitions are not supported; use inline links");
          break;
        default:
          fail(`unsupported Markdown element "${token.type}"; supported: ${SUPPORTED_BLOCKS}`);
      }
    }
    return out;
  }

  return {
    convert(tokens) {
      const out = [];
      let consumed = 0;
      for (const token of tokens) {
        ctx.line = page.bodyLine + consumed;
        out.push(...blocks([token], true));
        consumed += (token.raw.match(/\n/g) ?? []).length;
      }
      return out;
    },
  };
}

/** Lex a page body and collect its top-level headings and anchors (first pass). */
export function lexPage(page, markdown, issues) {
  const label = `${PUBLIC_LABEL}${page.source}`;
  const front = parseFrontMatter(markdown);
  for (const item of front.issues) issues.push(`${label}:${item.line}: ${item.message}`);
  let tokens = [];
  try {
    tokens = marked.lexer(front.body, { gfm: true, breaks: false });
  } catch {
    issues.push(`${label}: the Markdown could not be parsed`);
  }

  const slug = createSlugger();
  const headings = [];
  let consumed = 0;
  let firstBlock = true;
  let previousDepth = 0;
  let h1Count = 0;
  for (const token of tokens) {
    const line = front.bodyLine + consumed;
    consumed += (token.raw.match(/\n/g) ?? []).length;
    if (token.type === "space") continue;
    if (token.type === "heading") {
      if (token.depth > MAX_HEADING_DEPTH) {
        issues.push(`${label}:${line}: heading levels deeper than ${"#".repeat(MAX_HEADING_DEPTH)} are not supported`);
        continue;
      }
      const text = softBreaks(inlineText(token.tokens)).trim();
      const id = slug(text);
      if (id === "") issues.push(`${label}:${line}: the heading ${quote(text)} has no anchor text`);
      if (token.depth === 1) {
        h1Count += 1;
        if (!firstBlock) issues.push(`${label}:${line}: the single # title must be the first element of the page`);
        if (front.metadata && text !== front.metadata.title) issues.push(`${label}:${line}: the # title ${quote(text)} must equal the front matter title`);
      } else if (token.depth > previousDepth + 1) {
        issues.push(`${label}:${line}: heading level skips from ${previousDepth} to ${token.depth}`);
      }
      previousDepth = token.depth;
      headings.push({ depth: token.depth, id, text });
    }
    firstBlock = false;
  }
  if (h1Count !== 1) issues.push(`${label}: the page needs exactly one # title (found ${h1Count})`);

  return { metadata: front.metadata, tokens, bodyLine: front.bodyLine, headings, ids: new Set(headings.map((heading) => heading.id)) };
}

