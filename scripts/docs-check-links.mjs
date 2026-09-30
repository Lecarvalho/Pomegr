// Relative-link, anchor, image, and alt-text validation for maintained Markdown (WEB-04).
//
// `scripts/check-docs.mjs` drives this module. It checks repository-relative targets only:
// file links (exact case, as on GitHub), `#anchors` (GitHub heading slugs and explicit HTML
// ids), image targets, and non-empty image alt text. `http(s)`, `mailto`, and other schemes
// are never fetched. The heading slug functions are injected by the caller from the landing
// documentation loader, so the repository has exactly one GitHub-style slug implementation.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Directories under the repository root whose Markdown is not maintained documentation: an
 * exported design prototype, and gitignored local orchestration state that exists on one
 * machine only, so a checkout never disagrees with another about what was scanned.
 */
export const SKIP_PREFIXES = Object.freeze(["docs/internal/plans/ia-redesign/prototype/", ".agents/skills/acos/runs/"]);

const MARKDOWN_FILE = /\.md$/i;
const SCHEME = /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i;

export const toPosix = (path) => path.split(sep).join("/");

/** Repository-relative POSIX path of an absolute path. */
export const relativeTo = (root, absolute) => toPosix(relative(root, absolute));

// ---------------------------------------------------------------- file discovery

function walk(directory, found, recursive) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walk(full, found, true);
    } else if (entry.isFile() && MARKDOWN_FILE.test(entry.name)) {
      found.push(full);
    }
  }
}

/**
 * The maintained Markdown of a repository: `docs/**`, root `*.md`, `landing/*.md`, and
 * `.agents/skills/**`, minus `SKIP_PREFIXES`. Sorted, absolute paths.
 */
export function discoverMarkdown(root) {
  const found = [];
  walk(join(root, "docs"), found, true);
  walk(root, found, false);
  walk(join(root, "landing"), found, false);
  walk(join(root, ".agents", "skills"), found, true);
  return [...new Set(found)].filter((file) => !SKIP_PREFIXES.some((prefix) => relativeTo(root, file).startsWith(prefix))).sort();
}

// ---------------------------------------------------------------- Markdown handling

const blank = (text) => text.replace(/[^\n]/g, " ");

/** Blank out front matter, fenced code, HTML comments, and inline code, keeping line numbers stable. */
function stripCode(source) {
  let text = source.replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---(?=\n|$)/, blank);
  const lines = text.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(lines[i].slice(marker[0].length))) fence = null;
      lines[i] = "";
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      lines[i] = "";
    }
  }
  text = lines.join("\n").replace(/<!--[\s\S]*?-->/g, blank);
  return text
    .split("\n")
    .map((line) => line.replace(/(`+)(?:(?!\1).)+?\1/g, blank))
    .join("\n");
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Inline links and images: `[label](dest "title")` and `![alt](dest)`. */
function inlineLinks(text) {
  const found = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== "]" || text[i + 1] !== "(") continue;
    let depth = 0;
    let j = i - 1;
    for (; j >= 0 && i - j < 3000; j -= 1) {
      const c = text[j];
      if (c === "\n" && text[j - 1] === "\n") {
        j = -1;
        break;
      }
      if (text[j - 1] === "\\") continue;
      if (c === "]") depth += 1;
      else if (c === "[") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (j < 0 || text[j] !== "[") continue;
    const label = text.slice(j + 1, i);
    const image = text[j - 1] === "!" && text[j - 2] !== "\\";
    let k = i + 2;
    while (text[k] === " " || text[k] === "\t" || text[k] === "\n") k += 1;
    let dest = "";
    if (text[k] === "<") {
      const close = text.indexOf(">", k);
      if (close < 0) continue;
      dest = text.slice(k + 1, close);
      k = close + 1;
    } else {
      let parens = 0;
      const start = k;
      for (; k < text.length; k += 1) {
        const c = text[k];
        if (c === "\\") {
          k += 1;
          continue;
        }
        if (c === "(") parens += 1;
        else if (c === ")") {
          if (parens === 0) break;
          parens -= 1;
        } else if (/\s/.test(c)) break;
      }
      dest = text.slice(start, k);
    }
    while (text[k] === " " || text[k] === "\t" || text[k] === "\n") k += 1;
    if (text[k] === '"' || text[k] === "'" || text[k] === "(") {
      const closer = text[k] === "(" ? ")" : text[k];
      const end = text.indexOf(closer, k + 1);
      if (end < 0) continue;
      k = end + 1;
      while (text[k] === " " || text[k] === "\t" || text[k] === "\n") k += 1;
    }
    if (text[k] !== ")") continue;
    found.push({ label, image, target: dest, line: lineOf(text, j) });
  }
  return found;
}

/** Reference definitions: `[id]: dest`. */
function referenceDefinitions(text) {
  const found = [];
  const pattern = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/gm;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push({ label: "", image: false, target: match[1].replace(/^<|>$/g, ""), line: lineOf(text, match.index) });
  }
  return found;
}

/** Raw HTML `<a href>` and `<img src alt>`: forbidden in public pages, allowed elsewhere. */
function htmlLinks(text) {
  const found = [];
  for (const match of text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    found.push({ label: "html", image: false, target: match[1] ?? match[2], line: lineOf(text, match.index) });
  }
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
    if (src) found.push({ label: alt ? (alt[1] ?? alt[2]) : "", image: true, target: src[1] ?? src[2], line: lineOf(text, match.index) });
  }
  return found;
}

/** Every link and image of a Markdown source outside code: `{ label, image, target, line }`. */
export function extractLinks(source) {
  const text = stripCode(source);
  return [...inlineLinks(text), ...referenceDefinitions(text), ...htmlLinks(text)];
}

/** Split a relative target into its decoded file path (no query) and fragment. */
export function splitTarget(target) {
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const hash = target.indexOf("#");
  const pathAndQuery = hash < 0 ? target : target.slice(0, hash);
  return { pathPart: decode(pathAndQuery.replace(/\?.*$/, "")), fragment: hash < 0 ? "" : decode(target.slice(hash + 1)) };
}

/** True for a target that is not a repository-relative path (a URL with a scheme, or protocol-relative). */
export const isExternalTarget = (target) => SCHEME.test(target);

// ---------------------------------------------------------------- checker

/** Plain rendered text of a raw heading line, ready for the loader's `slugifyHeading`. */
function headingText(raw, decodeCharacterReferences) {
  let text = raw.trim().replace(/\s+#+\s*$/, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  text = decodeCharacterReferences(text.replace(/<[^>]+>/g, ""));
  text = text.replace(/`/g, "").replace(/\*+/g, "");
  return text.replace(/(^|[^\p{L}\p{N}])_+([^_]+?)_+(?=[^\p{L}\p{N}]|$)/gu, "$1$2");
}

/**
 * Create a link checker for one repository root. `createSlugger` (which applies the loader's `slugifyHeading`) and
 * `decodeCharacterReferences` come from the landing documentation loader.
 */
export function createLinkChecker({ root, createSlugger, decodeCharacterReferences }) {
  const anchorCache = new Map();
  const directoryCache = new Map();

  function anchorsOf(file) {
    if (anchorCache.has(file)) return anchorCache.get(file);
    const anchors = new Set();
    let text = "";
    try {
      text = stripCode(readFileSync(file, "utf8"));
    } catch {
      // A missing file is reported where it is linked.
    }
    const slug = createSlugger();
    const add = (raw) => anchors.add(slug(headingText(raw, decodeCharacterReferences)));
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const atx = /^ {0,3}#{1,6}[ \t]+(.+?)\s*$/.exec(lines[i]);
      if (atx) {
        add(atx[1]);
        continue;
      }
      const setext = /^ {0,3}(=+|-+)\s*$/.test(lines[i]) && i > 0 && /\S/.test(lines[i - 1]);
      if (setext && !/^\s*([#>|]|[-*+] |\d+[.)] )/.test(lines[i - 1]) && !/^ {0,3}(=+|-+)\s*$/.test(lines[i - 1])) add(lines[i - 1]);
    }
    for (const match of text.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) anchors.add(match[1] ?? match[2]);
    for (const match of text.matchAll(/<a\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) anchors.add(match[1] ?? match[2]);
    anchorCache.set(file, anchors);
    return anchors;
  }

  function entriesOf(directory) {
    if (!directoryCache.has(directory)) {
      try {
        directoryCache.set(directory, new Set(readdirSync(directory)));
      } catch {
        directoryCache.set(directory, null);
      }
    }
    return directoryCache.get(directory);
  }

  /** Existence with exact case at every path component, like GitHub (the Windows file system ignores case). */
  function existsExactCase(absolute) {
    if (!existsSync(absolute)) return false;
    const parts = relativeTo(root, absolute).split("/").filter((part) => part && part !== ".");
    if (parts[0] === "..") return true; // outside the repository: existence is all that can be checked
    let current = root;
    for (const part of parts) {
      const entries = entriesOf(current);
      if (!entries || !entries.has(part)) return false;
      current = join(current, part);
    }
    return true;
  }

  /**
   * Check one Markdown file. Adds to `stats` (`links`, `files`, `anchors`, `images`) and
   * returns failures as `{ file, line, rule, message }` with rules `missing-file`,
   * `missing-image`, `missing-anchor`, and `empty-alt`.
   */
  function checkFile(file, stats) {
    const failures = [];
    const from = relativeTo(root, file);
    for (const link of extractLinks(readFileSync(file, "utf8"))) {
      stats.links += 1;
      const fail = (rule, message) => failures.push({ file: from, line: link.line, rule, message });
      if (link.image) {
        stats.images += 1;
        if (!link.label.trim()) fail("empty-alt", `image ${JSON.stringify(link.target || "(empty)")} has no alt text`);
      }
      const target = link.target.trim();
      if (!target || isExternalTarget(target)) continue;
      const { pathPart, fragment } = splitTarget(target);
      let absolute = file;
      if (pathPart) {
        absolute = pathPart.startsWith("/") ? join(root, pathPart) : resolve(dirname(file), pathPart);
        stats.files += 1;
        if (!existsExactCase(absolute)) {
          fail(link.image ? "missing-image" : "missing-file", `${link.image ? "image" : "link"} target ${JSON.stringify(target)} does not exist (names are case-sensitive)`);
          continue;
        }
      }
      if (fragment && MARKDOWN_FILE.test(absolute) && existsSync(absolute) && statSync(absolute).isFile()) {
        stats.anchors += 1;
        const wanted = fragment.toLowerCase();
        const anchors = anchorsOf(absolute);
        if (!anchors.has(fragment) && ![...anchors].some((anchor) => anchor.toLowerCase() === wanted)) {
          fail("missing-anchor", `link ${JSON.stringify(target)} points to a heading anchor that does not exist in ${relativeTo(root, absolute)}`);
        }
      }
    }
    return failures;
  }

  return { checkFile, existsExactCase };
}
