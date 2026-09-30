// Build-time loader for the public documentation website (WEB-01).
//
// This is the only landing module that reads outside `landing/`, and it reads exactly
// two inputs: the publication manifest and the Markdown/images that manifest selects
// beneath the public documentation root. `assert-artifact-boundary.mjs` audits that no
// other landing source names a path outside the package. The publication contract is the
// documentation manifest page in the maintainer documentation (documentation-manifest.md).
//
// Markdown handling lives in docs-markdown.mjs (pure, no filesystem). This module adds the
// explicit filesystem readers (`inspectDocsContent`) and writers (`writePreparedDocs`). The
// Worker never imports either module: it bundles only the generated JSON they emit.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIDI_CONTROLS,
  CONTROL_CHARACTERS,
  KEBAB,
  PUBLIC_LABEL,
  createConverter,
  lexPage,
  quote,
  sha256,
} from "./docs-markdown.mjs";

export { IMAGE_ROUTE_PREFIX, createSlugger, decodeCharacterReferences, parseFrontMatter, slugifyHeading } from "./docs-markdown.mjs";

// ---------------------------------------------------------------------------
// Contract constants

export const CONTENT_SCHEMA_VERSION = 1;

/** The only paths outside `landing/` this package may read, relative to the landing root. */
export const CONTENT_INPUTS = Object.freeze({
  manifest: "../docs/site.json",
  publicRoot: "../docs/public",
});

/** Generated outputs, relative to the landing root (both are gitignored). */
export const GENERATED_CONTENT_FILE = "generated/docs-content.json";
export const GENERATED_IMAGES_DIR = "public/docs/images";

export const GROUP_IDS = Object.freeze(["get-started", "using-pomegr", "concepts", "help"]);
export const DOCS_ROUTE_PREFIX = "/docs/";

const MANIFEST_LABEL = "docs/site.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GROUPS = GROUP_IDS.length;
const MAX_PAGES = 200;
const MAX_GROUP_TITLE_CHARS = 60;

const SOURCE_PATTERN = new RegExp(`^(${KEBAB})/(${KEBAB})\\.md$`);

export class DocsContentError extends Error {
  constructor(issues) {
    super(`Documentation content is invalid (${issues.length} ${issues.length === 1 ? "issue" : "issues"}):\n- ${issues.join("\n- ")}`);
    this.name = "DocsContentError";
    this.issues = issues;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function isInside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Manifest

function checkPageSource(source, groupId) {
  if (typeof source !== "string" || source === "") return "must be a non-empty string";
  const match = SOURCE_PATTERN.exec(source);
  if (!match) {
    return `${quote(source)} must be "<group-id>/<topic>.md" with a lowercase kebab-case topic; absolute paths, dot segments, backslashes, encoded characters, queries, fragments and globs are not allowed`;
  }
  if (groupId !== null && match[1] !== groupId) return `${quote(source)} must start with "${groupId}/" inside the "${groupId}" group`;
  return null;
}

/**
 * Validate a parsed `docs/site.json` (version 1). Returns the ordered groups with derived
 * routes, plus every problem found. Unknown fields and unsupported versions are errors.
 */
export function validateManifest(raw) {
  const issues = [];
  const problem = (message) => issues.push(`${MANIFEST_LABEL}: ${message}`);
  const groups = [];

  if (!isPlainObject(raw)) {
    problem("must be a JSON object");
    return { groups, issues };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "groups") problem(`unknown field ${quote(key)}`);
  }
  if (raw.version !== 1) problem("version must be the integer 1");
  if (!Array.isArray(raw.groups)) {
    problem("groups must be an array");
    return { groups, issues };
  }
  if (raw.groups.length > MAX_GROUPS) problem(`at most ${MAX_GROUPS} groups are allowed`);

  const seenGroups = new Set();
  const seenSources = new Set();
  const seenRoutes = new Set();
  let pageCount = 0;

  raw.groups.forEach((group, groupIndex) => {
    const label = `groups[${groupIndex}]`;
    if (!isPlainObject(group)) {
      problem(`${label} must be an object`);
      return;
    }
    for (const key of Object.keys(group)) {
      if (key !== "id" && key !== "title" && key !== "pages") problem(`${label} has unknown field ${quote(key)}`);
    }
    const id = group.id;
    let groupOk = true;
    if (typeof id !== "string" || !GROUP_IDS.includes(id)) {
      problem(`${label}.id must be one of ${GROUP_IDS.join(", ")}`);
      groupOk = false;
    } else if (seenGroups.has(id)) {
      problem(`${label}.id "${id}" is duplicated`);
      groupOk = false;
    } else {
      seenGroups.add(id);
    }
    const title = typeof group.title === "string" ? group.title.trim() : "";
    if (!title || title.length > MAX_GROUP_TITLE_CHARS || CONTROL_CHARACTERS.test(title) || /[<>\n]/.test(title)) {
      problem(`${label}.title must be non-empty plain text of at most ${MAX_GROUP_TITLE_CHARS} characters`);
    }
    if (!Array.isArray(group.pages)) {
      problem(`${label}.pages must be an array`);
      return;
    }

    const pages = [];
    group.pages.forEach((source, pageIndex) => {
      const message = checkPageSource(source, groupOk ? id : null);
      if (message) {
        problem(`${label}.pages[${pageIndex}] ${message}`);
        return;
      }
      const [, , topic] = SOURCE_PATTERN.exec(source);
      const route = `${DOCS_ROUTE_PREFIX}${source.slice(0, -".md".length)}`;
      if (seenSources.has(source)) problem(`${label}.pages[${pageIndex}] ${quote(source)} is listed more than once`);
      else if (seenRoutes.has(route)) problem(`${label}.pages[${pageIndex}] route ${route} is not unique`);
      seenSources.add(source);
      seenRoutes.add(route);
      pageCount += 1;
      pages.push({ source, group: id, topic, route });
    });
    if (groupOk) groups.push({ id, title, pages });
  });

  if (pageCount > MAX_PAGES) problem(`at most ${MAX_PAGES} pages may be selected`);
  return { groups, issues };
}

// ---------------------------------------------------------------------------
// Filesystem access (the only reads this module performs)

function defaultLandingRoot() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

class BoundaryError extends Error {}

function createReader(landingRoot) {
  const manifestPath = resolve(landingRoot, CONTENT_INPUTS.manifest);
  const publicRoot = resolve(landingRoot, CONTENT_INPUTS.publicRoot);
  const listings = new Map();

  const listing = (directory) => {
    if (!listings.has(directory)) listings.set(directory, new Set(readdirSync(directory)));
    return listings.get(directory);
  };

  function open() {
    const docsDirectory = dirname(manifestPath);
    if (dirname(publicRoot) !== docsDirectory) throw new BoundaryError(`${PUBLIC_LABEL} must sit beside ${MANIFEST_LABEL}`);
    const docsReal = realpathSync(docsDirectory);
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new BoundaryError(`${MANIFEST_LABEL} must be a regular file, not a link`);
    if (realpathSync(manifestPath) !== join(docsReal, "site.json")) throw new BoundaryError(`${MANIFEST_LABEL} resolves outside the documentation directory`);
    if (manifestStat.size > MAX_MANIFEST_BYTES) throw new BoundaryError(`${MANIFEST_LABEL} is larger than ${MAX_MANIFEST_BYTES} bytes`);
    const publicStat = lstatSync(publicRoot);
    if (publicStat.isSymbolicLink() || !publicStat.isDirectory()) throw new BoundaryError(`${PUBLIC_LABEL} must be a real directory, not a link`);
    if (realpathSync(publicRoot) !== join(docsReal, "public")) throw new BoundaryError(`${PUBLIC_LABEL} resolves outside the documentation directory`);
    return realpathSync(publicRoot);
  }

  /** Read one regular file beneath the public root; every component must be a real, exact-case entry. */
  function readPublicFile(publicReal, sourcePath, maxBytes) {
    const segments = sourcePath.split("/");
    let current = publicReal;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (!listing(current).has(name)) throw new BoundaryError(`${PUBLIC_LABEL}${sourcePath} does not exist (names are case-sensitive)`);
      const next = join(current, name);
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) throw new BoundaryError(`${PUBLIC_LABEL}${sourcePath} passes through a symbolic link or junction`);
      const last = index === segments.length - 1;
      if (last ? !stat.isFile() : !stat.isDirectory()) throw new BoundaryError(`${PUBLIC_LABEL}${sourcePath} is not a ${last ? "regular file" : "directory"}`);
      if (last && stat.size > maxBytes) throw new BoundaryError(`${PUBLIC_LABEL}${sourcePath} is larger than ${maxBytes} bytes`);
      current = next;
    }
    const real = realpathSync(current);
    if (!isInside(publicReal, real)) throw new BoundaryError(`${PUBLIC_LABEL}${sourcePath} resolves outside ${PUBLIC_LABEL}`);
    return readFileSync(real);
  }

  return { manifestPath, open, readPublicFile };
}

function describeReadError(error, label) {
  if (error instanceof BoundaryError) return error.message;
  if (error instanceof SyntaxError) return `${label} is not valid JSON`;
  return `${label} cannot be read (${error?.code ?? "error"})`;
}

function decodeText(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundaryError(`${label} is not valid UTF-8`);
  }
  text = text.replace(/\r\n?/g, "\n");
  if (CONTROL_CHARACTERS.test(text) || BIDI_CONTROLS.test(text)) {
    throw new BoundaryError(`${label} contains control or bidirectional-override characters`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Loading

/**
 * Read the manifest and the pages and images it selects, validate everything, and build
 * the generated content. Returns `{ content, assets, issues }`; `content` is null and
 * `assets` empty whenever `issues` is non-empty, so invalid input never reaches a build.
 */
export function inspectDocsContent({ landingRoot = defaultLandingRoot() } = {}) {
  const issues = [];
  const reader = createReader(landingRoot);
  const empty = () => ({ content: null, assets: [], issues });

  let publicReal;
  let manifestRaw;
  try {
    publicReal = reader.open();
    manifestRaw = JSON.parse(decodeText(readFileSync(reader.manifestPath), MANIFEST_LABEL));
  } catch (error) {
    issues.push(describeReadError(error, MANIFEST_LABEL));
    return empty();
  }

  const manifest = validateManifest(manifestRaw);
  issues.push(...manifest.issues);
  if (issues.length) return empty();

  // First pass: read and lex every selected page so anchors exist before links resolve.
  const pages = [];
  const pagesBySource = new Map();
  let unreadable = false;
  for (const group of manifest.groups) {
    for (const entry of group.pages) {
      let markdown;
      try {
        markdown = decodeText(reader.readPublicFile(publicReal, entry.source, MAX_PAGE_BYTES), `${PUBLIC_LABEL}${entry.source}`);
      } catch (error) {
        issues.push(describeReadError(error, `${PUBLIC_LABEL}${entry.source}`));
        unreadable = true;
        continue;
      }
      const page = { ...entry, markdown, ...lexPage(entry, markdown, issues) };
      pages.push(page);
      pagesBySource.set(page.source, page);
    }
  }
  // A selected page that cannot be read would make every link to it look unselected.
  if (unreadable) return empty();

  // Second pass: resolve links and images and build the structured blocks.
  const imagesByRoute = new Map();
  const readImage = (sourcePath) => {
    try {
      return reader.readPublicFile(publicReal, sourcePath, MAX_IMAGE_BYTES);
    } catch (error) {
      throw new Error(describeReadError(error, `${PUBLIC_LABEL}${sourcePath}`));
    }
  };
  for (const page of pages) {
    const converter = createConverter({ page, pagesBySource, readImage, imagesByRoute, issues });
    page.blocks = converter.convert(page.tokens);
  }
  if (issues.length) return empty();

  const assets = [...imagesByRoute.values()].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  const navigation = manifest.groups
    .map((group) => ({ id: group.id, title: group.title, pages: group.pages.map((entry) => ({ route: entry.route, title: pagesBySource.get(entry.source).metadata.title })) }))
    .filter((group) => group.pages.length > 0);

  const contentPages = pages.map((page, index) => ({
    route: page.route,
    source: page.source,
    group: page.group,
    title: page.metadata.title,
    description: page.metadata.description,
    headings: page.headings,
    blocks: page.blocks,
    previous: index > 0 ? { route: pages[index - 1].route, title: pages[index - 1].metadata.title } : null,
    next: index < pages.length - 1 ? { route: pages[index + 1].route, title: pages[index + 1].metadata.title } : null,
  }));

  const revision = sha256(
    JSON.stringify({
      schema: CONTENT_SCHEMA_VERSION,
      manifest: manifest.groups.map((group) => ({ id: group.id, title: group.title, pages: group.pages.map((entry) => entry.source) })),
      pages: pages.map((page) => [page.source, sha256(page.markdown)]),
      images: assets.map((asset) => [asset.route, asset.sha256]),
    }),
  );

  const content = {
    schema: CONTENT_SCHEMA_VERSION,
    revision,
    entry: contentPages.length ? contentPages[0].route : null,
    navigation,
    pages: contentPages,
    images: assets.map((asset) => ({ route: asset.route, bytes: asset.bytes, sha256: asset.sha256 })),
  };
  return { content, assets, issues };
}

/** Like `inspectDocsContent`, but throws one `DocsContentError` listing every problem. */
export function loadDocsContent(options) {
  const result = inspectDocsContent(options);
  if (result.issues.length) throw new DocsContentError(result.issues);
  return { content: result.content, assets: result.assets };
}

/** Deterministic serialization: stable key and page order, LF, no timestamps. */
export function serializeDocsContent(content) {
  return `${JSON.stringify(content)}\n`;
}

// ---------------------------------------------------------------------------
// Generated output (inside landing/ only)

function ensureOwnedDirectory(landingRoot, directory) {
  const relativePath = relative(landingRoot, directory);
  if (!isInside(landingRoot, directory)) throw new Error("generated output must stay inside landing/");
  let current = landingRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch {
      mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${relative(landingRoot, current)} must be a real directory; remove it and run the prepare step again`);
  }
}

function writeIfChanged(path, data) {
  try {
    if (Buffer.compare(readFileSync(path), Buffer.from(data)) === 0) return;
  } catch {
    // Missing or unreadable output is simply rewritten.
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function pruneImages(root, wanted, directory = root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${relative(root, path)} is a link inside the generated image directory; remove it`);
    if (entry.isDirectory()) {
      pruneImages(root, wanted, path);
      if (readdirSync(path).length === 0) rmdirSync(path);
    } else if (!wanted.has(relative(root, path).split(sep).join("/"))) {
      unlinkSync(path);
    }
  }
}

/**
 * Write `generated/docs-content.json` and mirror exactly the referenced images into
 * `public/docs/images/`, deleting anything else there. Both locations are gitignored.
 */
export function writePreparedDocs({ landingRoot = defaultLandingRoot(), content, assets }) {
  const contentFile = resolve(landingRoot, GENERATED_CONTENT_FILE);
  const imagesRoot = resolve(landingRoot, GENERATED_IMAGES_DIR);
  ensureOwnedDirectory(landingRoot, dirname(contentFile));
  writeIfChanged(contentFile, serializeDocsContent(content));

  ensureOwnedDirectory(landingRoot, imagesRoot);
  pruneImages(imagesRoot, new Set(assets.map((asset) => asset.relativePath)));
  for (const asset of assets) {
    const destination = join(imagesRoot, ...asset.relativePath.split("/"));
    ensureOwnedDirectory(landingRoot, dirname(destination));
    writeIfChanged(destination, asset.data);
  }
  return { contentFile, imagesRoot };
}
