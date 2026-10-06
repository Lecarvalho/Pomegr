import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const landingRoot = realpathSync(resolve(fileURLToPath(new URL("..", import.meta.url))));
const sourceOnly = process.argv.includes("--source-only");
const sourceRoots = ["app", "scripts", "server", "worker"];
const sourceFiles = ["next.config.ts", "vite.config.ts"];
const codeExtensions = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".jsx", ".map", ".mjs", ".svg", ".txt", ".ts", ".tsx", ".xml",
]);
const failures = [];

// Content-input boundary (WEB-01). The build-time docs loader is the only landing module that
// may read outside landing/, and only these two inputs. The list is deliberately independent of
// the loader so widening the loader alone cannot widen the boundary.
const contentLoaderFile = "scripts/docs-content.mjs";
const allowedContentInputs = new Set(["../docs/site.json", "../docs/public"]);
const runtimeRoots = new Set(["app", "server", "worker"]);
const selfFile = "scripts/assert-artifact-boundary.mjs";
const nonPublicDocsPattern = /docs[\\/](?:internal|plans|mockups|design|user-guide)[\\/]/i;
const generatedContentFile = join(landingRoot, "generated", "docs-content.json");
const generatedSearchFile = join(landingRoot, "generated", "docs-search.json");
const generatedPublicDocs = join(landingRoot, "public", "docs");
const docsRoutePattern = /^\/docs\/(?:get-started|using-pomegr|concepts|help)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const docsImageRoutePattern = /^\/docs\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/;
// Public pages may name an example repository path when describing a screenshot. Only the exact
// matched text is exempt, and only inside the generated docs content (and, in the artifact, only in
// files that carry the content revision), never elsewhere.
const allowedDocsMentions = new Set(["app/Dashboard.tsx"]);

// Search index, sitemap and robots (WEB-03). The bounds and shapes are restated here, independently
// of the generator, so growing the generator alone cannot widen what ships.
const searchIndexMaxBytes = 128 * 1024;
const searchTextMaxCharacters = 2000;
const searchIndexKeys = ["pages", "revision", "schema"];
const searchPageKeys = ["description", "group", "headings", "route", "text", "title"];
const searchHeadingKeys = ["id", "text"];
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const publicOrigin = "https://pomegr.com";
const publicSitePages = ["/", "/about", "/download"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The checkout that contains landing/, derived from this package's location instead of one
// machine's path, so the rule holds on every developer machine and in CI. Both separators match, and
// this package's own directory (landing/) is allowed.
function repositoryRootPattern() {
  const segments = resolve(landingRoot, "..").split(/[\\/]+/);
  const lead = segments[0] === "" ? "[\\\\/]" : "";
  const body = segments.filter(Boolean).map(escapeRegExp).join("[\\\\/]+");
  return new RegExp(`${lead}${body}[\\\\/]+(?![\\\\/]*${escapeRegExp(basename(landingRoot))}(?![\\w.-]))`, "i");
}

const dashboardLabel = "Dashboard component source";
const forbiddenText = [
  { label: "local state API", pattern: /\/api\/state\b/i },
  { label: "local sessions API", pattern: /\/api\/sessions\b/i },
  { label: "monitor source", pattern: /monitor[\\/]server\.mjs/i },
  { label: "desktop source", pattern: /desktop[\\/]main\.mjs/i },
  { label: dashboardLabel, pattern: /app[\\/]Dashboard(?:\.[cm]?[jt]sx?)?/i },
  { label: "local security modules", pattern: /shared[\\/]local-(?:auth|service)/i },
  { label: "parent source import", pattern: /\.\.[\\/](?:app|desktop|monitor|shared|web)[\\/]/i },
  { label: "absolute repository source path", pattern: repositoryRootPattern() },
  // Generic home-directory paths: a user name must never reach a public page, asset, or bundle.
  { label: "Windows user-profile path", pattern: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|*?]+[\\/]/i },
  { label: "POSIX home directory path", pattern: /(?<![\w.:~-])\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  { label: "non-public documentation path", pattern: nonPublicDocsPattern },
];
const globalForbiddenText = forbiddenText.map(({ label, pattern }) => ({ label, pattern: new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`) }));

// This package's own directory as plain, forward-slash, and JSON-escaped text. Build tools record it
// (the generated Worker configuration names landing/wrangler.jsonc), wherever the checkout lives.
const landingRootTexts = [...new Set([landingRoot, landingRoot.split(sep).join("/"), landingRoot.split(sep).join("\\\\")])].map((text) => text.toLowerCase());
const homePathLabels = new Set(["Windows user-profile path", "POSIX home directory path"]);

/** Whether the path that starts at `index` is this package's directory or something inside it. */
function startsInsideLanding(text, index) {
  return landingRootTexts.some((root) => text.slice(index, index + root.length).toLowerCase() === root && /^(?:[\\/"'`\s]|$)/.test(text.slice(index + root.length, index + root.length + 1)));
}

/**
 * Every forbidden match in `text`, except in two cases. With `allowExamples`, the Dashboard pattern
 * may match exactly an allowlisted example path that stands alone; a preceding path character, as
 * in ../app/Dashboard.tsx or src/app/Dashboard.tsx, is never the example. A home-directory path
 * that is this package's own location is never reported.
 */
function forbiddenMatches(text, { allowExamples }) {
  const found = [];
  for (const { label, pattern } of globalForbiddenText) {
    for (const match of text.matchAll(pattern)) {
      const alone = !/[\w./\\-]/.test(text[match.index - 1] ?? "");
      if (allowExamples && label === dashboardLabel && alone && allowedDocsMentions.has(match[0])) continue;
      if (homePathLabels.has(label) && startsInsideLanding(text, match.index)) continue;
      found.push({ label, text: match[0] });
    }
  }
  return found;
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = [];

  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      failures.push(`symbolic links are not allowed in the landing boundary: ${relative(landingRoot, path)}`);
      continue;
    }
    if (stat.isDirectory()) entries.push(...walk(path));
    else entries.push(path);
  }

  return entries;
}

function isInsideLanding(path) {
  const rel = relative(landingRoot, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// A specifier may span lines in a multi-line import, so the clause before `from` may contain newlines.
const importPatterns = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'();]*?\s+from\s*)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
];

function sourcePaths() {
  return [
    ...sourceRoots.flatMap((root) => walk(join(landingRoot, root))),
    ...sourceFiles.map((name) => join(landingRoot, name)).filter(existsSync),
  ].filter((path) => codeExtensions.has(extname(path)));
}

function auditSourceImports() {
  for (const path of sourcePaths()) {
    const contents = readFileSync(path, "utf8");
    const rootName = relative(landingRoot, path).split(sep)[0];
    for (const importPattern of importPatterns) {
      for (const match of contents.matchAll(importPattern)) {
        const specifier = match[1];
        if (runtimeRoots.has(rootName) && /^(?:node:)?fs(?:\/promises)?$/.test(specifier)) {
          failures.push(`${relative(landingRoot, path)} imports the filesystem; runtime sources bundle generated content instead of reading files`);
        }
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const candidate = specifier.startsWith("@/")
          ? resolve(landingRoot, specifier.slice(2))
          : resolve(path, "..", specifier);
        if (!isInsideLanding(normalize(candidate))) {
          failures.push(`${relative(landingRoot, path)} imports outside landing/: ${specifier}`);
        }
      }
    }
  }
}

// Blank comments (keeping offsets meaningful enough for a literal scan). A `//` right after a colon,
// quote or backslash is treated as part of a string, not a comment.
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/gm, "$1");
}

/**
 * Only the docs loader may name a path outside landing/, and only its two content inputs.
 * This is a tripwire over string literals (the loader's own path validation and tests are the
 * real enforcement); it also keeps the Worker free of filesystem access and of any reference to
 * non-public documentation.
 */
function auditContentInputs() {
  for (const path of sourcePaths()) {
    const rel = relative(landingRoot, path).split(sep).join("/");
    if (rel === selfFile) continue;
    const raw = readFileSync(path, "utf8");
    if (nonPublicDocsPattern.test(raw)) failures.push(`${rel} references non-public documentation`);

    let text = blankComments(raw);
    for (const importPattern of importPatterns) text = text.replace(importPattern, "");
    text = text.replace(/new URL\(\s*(["'])\.\.\1\s*,\s*import\.meta\.url\s*\)/g, "");
    for (const match of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const literal = match[2];
      if (!/(^|[\\/])\.\.([\\/]|$)/.test(literal)) continue;
      if (rel === contentLoaderFile && allowedContentInputs.has(literal)) continue;
      failures.push(`${rel} names a path outside landing/ (${JSON.stringify(literal)}); only ${contentLoaderFile} may read ${[...allowedContentInputs].join(" and ")}`);
    }
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function* stringValues(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringValues(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* stringValues(item);
}

/** Report every forbidden pattern in any string of a generated value, except the allowlisted example paths. */
function scanGeneratedText(where, value) {
  for (const text of stringValues(value)) {
    for (const match of forbiddenMatches(text, { allowExamples: true })) failures.push(`${where} contains ${match.label}: ${match.text}`);
  }
}

/**
 * Image bytes are scanned as Latin-1 text, so a path or user name in metadata cannot ride along unseen.
 * The mirrored copies under public/docs are scanned; dist/client/docs/images must match them byte for byte.
 */
function scanImageBytes(where, path) {
  for (const match of forbiddenMatches(readFileSync(path).toString("latin1"), { allowExamples: false })) failures.push(`${where} contains ${match.label} in its image data`);
}

/**
 * Audit the generated docs content and the images mirrored beside the landing assets: the JSON must
 * have the expected shape, carry no local-app or non-public text, and declare exactly the images that
 * exist under public/docs, byte for byte. Returns the parsed content, or null when absent.
 */
function auditGeneratedDocs({ artifact }) {
  const hasPublicDocs = existsSync(generatedPublicDocs);
  if (!existsSync(generatedContentFile)) {
    if (artifact || hasPublicDocs) failures.push("missing generated/docs-content.json; run npm run docs:prepare");
    return null;
  }
  let content;
  try {
    content = JSON.parse(readFileSync(generatedContentFile, "utf8"));
  } catch {
    failures.push("generated/docs-content.json is not valid JSON");
    return null;
  }
  if (content?.schema !== 1 || !/^[0-9a-f]{64}$/.test(content.revision ?? "") || !Array.isArray(content.pages) || !Array.isArray(content.images)) {
    failures.push("generated/docs-content.json has an unexpected shape; run npm run docs:prepare");
    return null;
  }

  const declared = new Map();
  for (const image of content.images) {
    if (typeof image?.route !== "string" || !docsImageRoutePattern.test(image.route) || !/^[0-9a-f]{64}$/.test(image.sha256 ?? "")) {
      failures.push(`generated docs content declares an invalid image: ${String(image?.route)}`);
    } else declared.set(image.route, image.sha256);
  }
  for (const page of content.pages) {
    if (typeof page?.route !== "string" || !docsRoutePattern.test(page.route)) {
      failures.push(`generated docs content declares an invalid page route: ${String(page?.route)}`);
      continue;
    }
    scanGeneratedText(`generated docs content (${page.route})`, page);
  }

  for (const file of hasPublicDocs ? walk(generatedPublicDocs) : []) {
    const rel = relative(generatedPublicDocs, file).split(sep).join("/");
    const route = `/docs/${rel}`;
    if (!declared.has(route)) failures.push(`public/docs/${rel} is not an image referenced by the generated docs content; run npm run docs:prepare`);
    else if (sha256File(file) !== declared.get(route)) failures.push(`public/docs/${rel} does not match the generated docs content; run npm run docs:prepare`);
    else scanImageBytes(`public/docs/${rel}`, file);
  }
  for (const route of declared.keys()) {
    if (!existsSync(join(landingRoot, "public", ...route.slice(1).split("/")))) failures.push(`public${route} is missing; run npm run docs:prepare`);
  }
  return content;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === keys.join();

/**
 * Audit the generated search index against the generated content it must derive from: same
 * revision, exactly the published pages in the same order, titles, descriptions and headings
 * identical to the content, a bounded plain-text body, and no forbidden text anywhere. Returns the
 * parsed index, or null when it is absent or unusable.
 */
function auditGeneratedSearch(content) {
  if (!content) return null;
  if (!existsSync(generatedSearchFile)) {
    failures.push("missing generated/docs-search.json; run npm run docs:prepare");
    return null;
  }
  const fail = (message) => failures.push(`generated/docs-search.json ${message}; run npm run docs:prepare`);
  if (lstatSync(generatedSearchFile).size > searchIndexMaxBytes) fail(`is larger than ${searchIndexMaxBytes} bytes`);
  let index;
  try {
    index = JSON.parse(readFileSync(generatedSearchFile, "utf8"));
  } catch {
    fail("is not valid JSON");
    return null;
  }
  if (!hasExactKeys(index, searchIndexKeys) || index.schema !== 1 || !Array.isArray(index.pages)) {
    fail("has an unexpected shape");
    return null;
  }
  if (index.revision !== content.revision) fail("was not built from the generated docs content revision");
  if (index.pages.length !== content.pages.length) {
    fail("does not list exactly the published pages");
    return index;
  }

  content.pages.forEach((page, position) => {
    const entry = index.pages[position];
    if (!hasExactKeys(entry, searchPageKeys) || !Array.isArray(entry.headings) || typeof entry.text !== "string") {
      fail(`has an unexpected entry at position ${position}`);
      return;
    }
    if (entry.route !== page.route) fail(`lists ${String(entry.route)} where the published page is ${page.route}`);
    if (entry.title !== page.title || entry.description !== page.description) fail(`does not match the title and description of ${page.route}`);
    if (entry.text.length > searchTextMaxCharacters || controlCharacters.test(entry.text)) fail(`has an unbounded or unsafe body for ${page.route}`);
    const published = new Map((Array.isArray(page.headings) ? page.headings : []).map((heading) => [heading.id, heading.text]));
    for (const heading of entry.headings) {
      if (!hasExactKeys(heading, searchHeadingKeys) || published.get(heading.id) !== heading.text) {
        fail(`lists a heading that ${page.route} does not publish: ${JSON.stringify(heading?.id)}`);
      }
    }
  });
  scanGeneratedText("generated docs search index", index);
  return index;
}

/**
 * The search index loads lazily as its own client chunk. The built client must carry a copy of it
 * (recognized by its revision), complete and within the size bound.
 */
function auditDistSearchIndex(docsContent, index, files, client) {
  if (!docsContent || !index || index.revision !== docsContent.revision) return;
  const carriers = files.filter((file) => isInsideRoot(client, file) && extname(file) === ".js" && readFileSync(file, "utf8").includes(index.revision));
  if (carriers.length === 0) failures.push("dist/client has no chunk carrying the docs search index; search would not load");
  for (const file of carriers) {
    const name = `dist/client/${relative(client, file).split(sep).join("/")}`;
    const text = readFileSync(file, "utf8");
    if (docsContent.pages.some((page) => !text.includes(page.route))) failures.push(`${name} carries the content revision but not every published page`);
    if (lstatSync(file).size > searchIndexMaxBytes) failures.push(`${name} is larger than the search index bound of ${searchIndexMaxBytes} bytes`);
  }
}

/**
 * sitemap.xml and robots.txt are application routes today, so the artifact holds no copy. If a
 * static copy ever ships, it may list only the public pages under the public origin and must not
 * name any path of its own.
 */
function auditStaticSiteIndexes(docsContent, files, client) {
  const allowed = new Set([...publicSitePages, ...(docsContent?.pages ?? []).map((page) => page.route)]);
  for (const file of files) {
    const rel = relative(client, file).split(sep).join("/");
    if (rel === "sitemap.xml") {
      const locations = [...readFileSync(file, "utf8").matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1].trim());
      for (const location of locations) {
        if (!location.startsWith(publicOrigin) || !allowed.has(location.slice(publicOrigin.length))) {
          failures.push(`dist/client/sitemap.xml lists a page the site does not publish: ${location}`);
        }
      }
    } else if (rel === "robots.txt") {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        if (/^\s*disallow\s*:\s*\S/i.test(line)) failures.push(`dist/client/robots.txt names a path: ${line.trim()}`);
        const sitemap = /^\s*sitemap\s*:\s*(\S*)/i.exec(line);
        if (sitemap && sitemap[1] !== `${publicOrigin}/sitemap.xml`) failures.push(`dist/client/robots.txt points at an unexpected sitemap: ${sitemap[1]}`);
      }
    }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function comparableDeploymentConfig(config) {
  return canonicalJson({
    name: config.name,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    workers_dev: config.workers_dev,
    preview_urls: config.preview_urls,
    routes: config.routes,
    vars: config.vars,
    d1_databases: config.d1_databases?.map(
      ({ binding, database_name, database_id, remote }) => ({
          binding,
          database_name,
          database_id,
          ...(remote === undefined ? {} : { remote }),
      }),
    ),
    ratelimits: config.ratelimits,
  });
}

/** dist/client/docs/images must hold exactly the images the generated docs content declares. */
function auditDistDocsImages(docsContent, files, client) {
  if (!docsContent) return;
  const declared = new Map(docsContent.images.map((image) => [image.route, image.sha256]));
  const imagesRoot = join(client, "docs", "images");
  const seen = new Set();
  for (const file of files) {
    if (!isInsideRoot(imagesRoot, file)) continue;
    const route = `/docs/images/${relative(imagesRoot, file).split(sep).join("/")}`;
    if (!declared.has(route)) failures.push(`dist/client${route} is not an image referenced by the generated docs content`);
    else if (sha256File(file) !== declared.get(route)) failures.push(`dist/client${route} does not match the generated docs content; rebuild landing/dist`);
    else seen.add(route);
  }
  for (const route of declared.keys()) {
    if (!seen.has(route)) failures.push(`dist/client${route} is missing; rebuild landing/dist`);
  }
}

/**
 * Every root-relative `url()` in a built stylesheet must name a file the assets binding serves.
 * A wrong address would only show as a missing font or background in a browser.
 */
function auditDistStylesheetUrls(files, client) {
  for (const file of files) {
    if (extname(file) !== ".css" || !isInsideRoot(client, file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/url\(\s*["']?(\/[^"')?#\s]*)/g)) {
      if (match[1].startsWith("//")) continue;
      const target = join(client, ...decodeURIComponent(match[1]).split("/"));
      if (!isInsideRoot(client, target) || !existsSync(target)) failures.push(`dist/client/${relative(client, file).split(sep).join("/")} refers to ${match[1]}, which the build does not contain`);
    }
  }
}

function isInsideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function auditArtifact(docsContent, searchIndex) {
  const dist = join(landingRoot, "dist");
  const client = join(dist, "client");
  const server = join(dist, "server");
  const generatedConfig = join(server, "wrangler.json");

  for (const required of [client, server, generatedConfig]) {
    if (!existsSync(required)) failures.push(`missing build output: ${relative(landingRoot, required)}`);
  }
  if (failures.length) return;

  const files = walk(dist);
  const forbiddenPath = /(^|[\\/])(dashboard|monitor|desktop|shared|web)([\\/]|-|\.)/i;

  for (const path of files) {
    const rel = relative(dist, path);
    if (forbiddenPath.test(rel)) failures.push(`forbidden local-app artifact path: ${rel}`);
    if (extname(path) === ".map") failures.push(`source map must not ship: ${rel}`);
    if (!textExtensions.has(extname(path)) && !path.endsWith(".vite/manifest.json")) continue;

    const contents = readFileSync(path, "utf8");
    // Bundled documentation content (recognized by its revision) may name the allowlisted example
    // paths. The exemption covers those exact matches only and the text is never altered, so a path
    // around an example (../app/Dashboard.tsx) is still judged by every rule.
    const carriesRevision = Boolean(docsContent) && contents.includes(docsContent.revision);
    for (const match of forbiddenMatches(contents, { allowExamples: carriesRevision })) failures.push(`${rel} contains ${match.label}`);
  }
  auditDistDocsImages(docsContent, files, client);
  auditDistStylesheetUrls(files, client);
  auditDistSearchIndex(docsContent, searchIndex, files, client);
  auditStaticSiteIndexes(docsContent, files, client);

  let wrangler;
  try {
    wrangler = JSON.parse(readFileSync(generatedConfig, "utf8"));
  } catch {
    failures.push("dist/server/wrangler.json is not valid JSON");
    return;
  }
  if (wrangler.main !== "index.js") failures.push("generated deployment main must be dist/server/index.js");
  if (wrangler.no_bundle !== true) failures.push("generated deployment must use the already-built server artifact");
  if (wrangler.assets?.directory !== "../client") failures.push("generated deployment assets must be dist/client");
  try {
    const sourceConfig = JSON.parse(readFileSync(join(landingRoot, "wrangler.jsonc"), "utf8"));
    if (JSON.stringify(comparableDeploymentConfig(wrangler)) !== JSON.stringify(comparableDeploymentConfig(sourceConfig))) {
      failures.push("generated deployment bindings are stale; rebuild landing/dist before deploying");
    }
  } catch {
    failures.push("wrangler.jsonc is not valid JSON");
  }

  const inventory = files
    .map((path) => ({
      path: relative(dist, path).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const digestOf = (entries) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  // The whole-artifact digest identifies this one build: the server bundle carries secrets vinext
  // draws for every build. The client digest covers what browsers receive and is equal for two
  // builds of one commit, so it is the one to compare between audits.
  const clientInventory = inventory.filter((entry) => entry.path.startsWith("client/"));
  if (!failures.length) {
    console.log(`landing/dist boundary verified: ${inventory.length} files, sha256 ${digestOf(inventory)}`);
    console.log(`landing/dist/client: ${clientInventory.length} files, sha256 ${digestOf(clientInventory)}`);
  }
}

auditSourceImports();
auditContentInputs();
const docsContent = auditGeneratedDocs({ artifact: !sourceOnly });
const searchIndex = auditGeneratedSearch(docsContent);
if (!sourceOnly) auditArtifact(docsContent, searchIndex);

if (failures.length) {
  console.error("Landing deployment boundary check failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (sourceOnly) {
  console.log("landing/ source import and content-input boundary verified");
}
