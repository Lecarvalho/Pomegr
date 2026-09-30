import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
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
const generatedPublicDocs = join(landingRoot, "public", "docs");
const docsRoutePattern = /^\/docs\/(?:get-started|using-pomegr|concepts|help)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const docsImageRoutePattern = /^\/docs\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/;
// Public pages may name an example repository path when describing a screenshot. Only the exact
// matched text is exempt, and only inside the generated docs content (and, in the artifact, only in
// files that carry the content revision), never elsewhere.
const allowedDocsMentions = new Set(["app/Dashboard.tsx"]);

const forbiddenText = [
  { label: "local state API", pattern: /\/api\/state\b/i },
  { label: "local sessions API", pattern: /\/api\/sessions\b/i },
  { label: "monitor source", pattern: /monitor[\\/]server\.mjs/i },
  { label: "desktop source", pattern: /desktop[\\/]main\.mjs/i },
  { label: "Dashboard component source", pattern: /app[\\/]Dashboard(?:\.[cm]?[jt]sx?)?/i },
  { label: "local security modules", pattern: /shared[\\/]local-(?:auth|service)/i },
  { label: "parent source import", pattern: /\.\.[\\/](?:app|desktop|monitor|shared|web)[\\/]/i },
  { label: "absolute repository source path", pattern: /C:[\\/]Workspace[\\/]repos[\\/]Pomegr[\\/](?!landing[\\/])/i },
  { label: "non-public documentation path", pattern: nonPublicDocsPattern },
];

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
    for (const text of stringValues(page)) {
      for (const { label, pattern } of forbiddenText) {
        for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
          if (!allowedDocsMentions.has(match[0])) failures.push(`generated docs content (${page.route}) contains ${label}: ${match[0]}`);
        }
      }
    }
  }

  for (const file of hasPublicDocs ? walk(generatedPublicDocs) : []) {
    const rel = relative(generatedPublicDocs, file).split(sep).join("/");
    const route = `/docs/${rel}`;
    if (!declared.has(route)) failures.push(`public/docs/${rel} is not an image referenced by the generated docs content; run npm run docs:prepare`);
    else if (sha256File(file) !== declared.get(route)) failures.push(`public/docs/${rel} does not match the generated docs content; run npm run docs:prepare`);
  }
  for (const route of declared.keys()) {
    if (!existsSync(join(landingRoot, "public", ...route.slice(1).split("/")))) failures.push(`public${route} is missing; run npm run docs:prepare`);
  }
  return content;
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

function isInsideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function auditArtifact(docsContent) {
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

    let contents = readFileSync(path, "utf8");
    // Bundled documentation content (recognized by its revision) may name the allowlisted example paths.
    if (docsContent && contents.includes(docsContent.revision)) {
      for (const mention of allowedDocsMentions) contents = contents.replaceAll(mention, "");
    }
    for (const { label, pattern } of forbiddenText) {
      if (pattern.test(contents)) failures.push(`${rel} contains ${label}`);
    }
  }
  auditDistDocsImages(docsContent, files, client);

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
  const digest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  if (!failures.length) console.log(`landing/dist boundary verified: ${inventory.length} files, sha256 ${digest}`);
}

auditSourceImports();
auditContentInputs();
const docsContent = auditGeneratedDocs({ artifact: !sourceOnly });
if (!sourceOnly) auditArtifact(docsContent);

if (failures.length) {
  console.error("Landing deployment boundary check failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (sourceOnly) {
  console.log("landing/ source import and content-input boundary verified");
}
