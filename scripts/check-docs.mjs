#!/usr/bin/env node
// Documentation checker (WEB-04): `npm run check:docs`.
//
//   node scripts/check-docs.mjs [--json] [--root <repository>]
//
// One command validates every documentation rule that can be checked without rendering:
//
//   1. Public documentation. The publication manifest (docs/site.json) and the pages and
//      images it selects are validated by the landing loader itself (`inspectDocsContent`:
//      manifest, front matter, routes, headings, links, anchors, images and alt text, the
//      supported Markdown syntax), so the website build and this checker share ONE
//      implementation. The search index built from the same content is checked against it.
//   2. The public tree. Every Markdown file under docs/public/ must be selected by the
//      manifest, and every other file there must be an image a selected page references.
//   3. The public boundary. No public page, selected or not, links to a file outside
//      docs/public/ (internal documentation, plans, source files) or to an internal
//      documentation page on GitHub. Internal pages may link public pages.
//   4. Maintained Markdown. Relative links, anchors, images, and non-empty alt text across
//      docs/**, root *.md, landing/*.md, and .agents/skills/** (see docs-check-links.mjs).
//
// Dependency direction: this root script imports landing's loader; landing never imports
// anything outside landing/ (both directions are enforced by .dependency-cruiser.cjs). The
// loader needs landing's own dependencies, so a missing `npm ci --prefix landing` is reported
// as a setup error (exit 2) rather than a crash. Exit codes: 0 passed, 1 documentation
// failures, 2 the checker could not run.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLinkChecker, discoverMarkdown, extractLinks, isExternalTarget, relativeTo, splitTarget } from "./docs-check-links.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PRINTED_FAILURES = 200;
const MARKDOWN_FILE = /\.md$/i;

/** The checker could not run (for example, landing's dependencies are not installed). */
export class CheckDocsSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckDocsSetupError";
  }
}

// Literal specifiers keep the import visible to dependency-cruiser.
const importLandingModules = () => Promise.all([import("../landing/scripts/docs-content.mjs"), import("../landing/scripts/docs-search.mjs")]);

async function loadLandingModules(importModules) {
  try {
    const [content, search] = await importModules();
    return { content, search };
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0];
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package/.test(message)) {
      throw new CheckDocsSetupError(
        `The public documentation rules live in landing/scripts and need the landing dependencies (${message}). Run "npm ci --prefix landing" from the repository root, then retry.`,
      );
    }
    throw new CheckDocsSetupError(`Cannot load the landing documentation loader: ${message}`);
  }
}

const failure = (file, line, rule, message) => ({ file, line, rule, message });

// ---------------------------------------------------------------- public documentation

/** Loader issues look like `docs/public/x.md:12: message`, `docs/site.json: message`, or a bare sentence. */
function issueToFailure(issue) {
  const match = /^(docs\/[^\s:]+)(?::(\d+))?:\s+([\s\S]+)$/.exec(issue);
  if (match) return failure(match[1], match[2] ? Number(match[2]) : null, "public-content", match[3]);
  return failure("docs/public/", null, "public-content", issue);
}

/** The search index must be derived from the content: same revision and pages, bounded size and text. */
function checkSearchIndex(content, search) {
  const failures = [];
  const fail = (message) => failures.push(failure("docs/public/", null, "search-index", message));
  const index = search.buildSearchIndex(content);
  const bytes = Buffer.byteLength(search.serializeSearchIndex(index));
  if (bytes > search.SEARCH_INDEX_MAX_BYTES) fail(`the search index is ${bytes} bytes, above the ${search.SEARCH_INDEX_MAX_BYTES} byte bound; shorten pages or revisit the index`);
  if (index.revision !== content.revision) fail("the search index does not carry the content revision");
  const routes = content.pages.map((page) => page.route).join("\n");
  if (index.pages.map((page) => page.route).join("\n") !== routes) fail("the search index does not list exactly the published pages in reading order");
  for (const page of index.pages) {
    if (page.text.length > search.SEARCH_TEXT_LIMIT) fail(`${page.route}: the search text is longer than ${search.SEARCH_TEXT_LIMIT} characters`);
  }
  return { failures, bytes };
}

// ---------------------------------------------------------------- public tree and boundary

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(join(directory, entry.name), `${name}/`));
    else files.push(name);
  }
  return files.sort();
}

/** Every file in docs/public/ is a selected page or an image a selected page references. */
function checkPublicTree(publicRoot, content, routePrefix) {
  const failures = [];
  const selected = new Set(content.pages.map((page) => page.source));
  const referenced = new Set(content.images.map((image) => image.route.slice(routePrefix.length)));
  const files = listFiles(publicRoot);
  for (const file of files) {
    const at = `docs/public/${file}`;
    if (MARKDOWN_FILE.test(file)) {
      if (!selected.has(file)) failures.push(failure(at, null, "unselected-page", "public page is not selected by docs/site.json; add it to a group when it is ready, or move the draft to an active plan"));
    } else if (!referenced.has(file)) {
      failures.push(failure(at, null, "unreferenced-asset", "file is not an image referenced by a selected public page; reference it or delete it"));
    }
  }
  return { failures, files: files.length };
}

function isInside(directory, path) {
  const rel = relative(directory, path);
  return rel === "" || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel));
}

// The directories under docs/ that never ship: the alternation of nonPublicDocsPattern in
// landing/scripts/assert-artifact-boundary.mjs, so this check catches what the build would reject
// (tests/docs-check.test.mjs keeps the two lists equal).
const NON_PUBLIC_DOCS = "internal|plans|mockups|design|user-guide";
const INTERNAL_GITHUB_PATH = new RegExp(`/docs/(?:${NON_PUBLIC_DOCS})(?:/|$)`);
const INTERNAL_REPOSITORY_PATH = new RegExp(`^docs/(?:${NON_PUBLIC_DOCS})(?:/|$)`);

/** No public page (selected or not) may link outside docs/public/ or to internal documentation. */
function checkPublicBoundary(root, publicRoot) {
  const failures = [];
  const pages = listFiles(publicRoot).filter((file) => MARKDOWN_FILE.test(file));
  for (const page of pages) {
    const absolute = join(publicRoot, page);
    const from = `docs/public/${page}`;
    for (const link of extractLinks(readFileSync(absolute, "utf8"))) {
      const target = link.target.trim();
      if (!target) continue;
      const fail = (message) => failures.push(failure(from, link.line, "public-boundary", message));
      if (isExternalTarget(target)) {
        let url = null;
        try {
          url = new URL(target, "https://placeholder.invalid");
        } catch {
          // Malformed URLs are the loader's concern.
        }
        if (url && /^(?:www\.)?github\.com$|^raw\.githubusercontent\.com$/.test(url.hostname) && INTERNAL_GITHUB_PATH.test(url.pathname)) {
          fail(`public pages may not link internal documentation (${JSON.stringify(target)})`);
        }
        continue;
      }
      const { pathPart } = splitTarget(target);
      if (!pathPart) continue;
      const resolved = pathPart.startsWith("/") ? join(root, pathPart) : resolve(dirname(absolute), pathPart);
      if (isInside(publicRoot, resolved)) continue;
      const repositoryPath = relativeTo(root, resolved);
      const internal = INTERNAL_REPOSITORY_PATH.test(repositoryPath);
      fail(
        internal
          ? `public pages may not link internal documentation (${JSON.stringify(target)} resolves to ${repositoryPath})`
          : `public pages may link only other public pages and images; ${JSON.stringify(target)} resolves outside docs/public/ (${repositoryPath})`,
      );
    }
  }
  return { failures, pages: pages.length };
}

// ---------------------------------------------------------------- run

/**
 * Run every check against a repository root. Resolves to `{ ok, summary, failures }`;
 * rejects with `CheckDocsSetupError` when the landing loader cannot be imported.
 * `importModules` exists so tests can exercise the missing-dependency path.
 */
export async function checkDocs({ root = REPOSITORY_ROOT, importModules = importLandingModules } = {}) {
  const base = resolve(root);
  const landing = await loadLandingModules(importModules);
  const { inspectDocsContent, createSlugger, decodeCharacterReferences, DOCS_ROUTE_PREFIX } = landing.content;
  const publicRoot = join(base, "docs", "public");
  const failures = [];
  const summary = {};

  const { content, issues } = inspectDocsContent({ landingRoot: join(base, "landing") });
  failures.push(...issues.map(issueToFailure));
  if (content) {
    const search = checkSearchIndex(content, landing.search);
    failures.push(...search.failures);
    const tree = checkPublicTree(publicRoot, content, DOCS_ROUTE_PREFIX);
    failures.push(...tree.failures);
    Object.assign(summary, {
      publicPages: content.pages.length,
      publicImages: content.images.length,
      publicFiles: tree.files,
      revision: content.revision.slice(0, 12),
      searchIndexBytes: search.bytes,
      searchIndexMaxBytes: landing.search.SEARCH_INDEX_MAX_BYTES,
    });
  }

  let boundaryPages = 0;
  try {
    const boundary = checkPublicBoundary(base, publicRoot);
    failures.push(...boundary.failures);
    boundaryPages = boundary.pages;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A missing docs/public/ is already reported by the loader.
  }
  summary.boundaryPages = boundaryPages;

  const stats = { links: 0, files: 0, anchors: 0, images: 0 };
  const files = discoverMarkdown(base);
  const checker = createLinkChecker({ root: base, createSlugger, decodeCharacterReferences });
  for (const file of files) failures.push(...checker.checkFile(file, stats));
  Object.assign(summary, { markdownFiles: files.length, links: stats.links, relativeFileTargets: stats.files, anchors: stats.anchors, images: stats.images });

  failures.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
  const seen = new Set();
  const distinct = failures.filter((item) => {
    const key = `${item.file}\u0000${item.line}\u0000${item.rule}\u0000${item.message}`;
    return seen.has(key) ? false : seen.add(key);
  });
  summary.failures = distinct.length;
  return { ok: distinct.length === 0, summary, failures: distinct };
}

// ---------------------------------------------------------------- command line

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

function formatSummary(summary) {
  const lines = ["check:docs"];
  if (summary.publicPages !== undefined) {
    lines.push(`  public docs   ${summary.publicPages} pages, ${summary.publicImages} images, revision ${summary.revision}, search index ${kib(summary.searchIndexBytes)} of ${kib(summary.searchIndexMaxBytes)}`);
    lines.push(`  public tree   ${summary.publicFiles} files, each a selected page or a referenced image`);
  } else {
    lines.push("  public docs   not validated (see the failures below)");
  }
  lines.push(`  boundary      ${summary.boundaryPages} public pages scanned for links that leave docs/public/`);
  lines.push(`  Markdown      ${summary.markdownFiles} files, ${summary.links} links (${summary.relativeFileTargets} relative targets, ${summary.anchors} anchors, ${summary.images} images)`);
  lines.push(`  result        ${summary.failures === 0 ? "passed" : `${summary.failures} failure${summary.failures === 1 ? "" : "s"}`}`);
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = { json: false, root: REPOSITORY_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--root" && argv[index + 1]) options.root = resolve(argv[(index += 1)]);
    else throw new CheckDocsSetupError(`Unknown or incomplete argument ${JSON.stringify(argument)}. Usage: node scripts/check-docs.mjs [--json] [--root <repository>]`);
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
    const result = await checkDocs({ root: options.root });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const item of result.failures.slice(0, MAX_PRINTED_FAILURES)) console.error(`${item.file}${item.line ? `:${item.line}` : ""}: ${item.rule}: ${item.message}`);
      if (result.failures.length > MAX_PRINTED_FAILURES) console.error(`... and ${result.failures.length - MAX_PRINTED_FAILURES} more (run with --json for all of them)`);
      console.log(formatSummary(result.summary));
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof CheckDocsSetupError)) throw error;
    if (options?.json) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`check:docs could not run: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
