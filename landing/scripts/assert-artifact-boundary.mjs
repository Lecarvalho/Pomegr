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

function auditSourceImports() {
  const paths = [
    ...sourceRoots.flatMap((root) => walk(join(landingRoot, root))),
    ...sourceFiles.map((name) => join(landingRoot, name)).filter(existsSync),
  ].filter((path) => codeExtensions.has(extname(path)));

  const importPatterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'();\n]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const path of paths) {
    const contents = readFileSync(path, "utf8");
    for (const importPattern of importPatterns) {
      for (const match of contents.matchAll(importPattern)) {
        const specifier = match[1];
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

function auditArtifact() {
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
  const forbiddenText = [
    { label: "local state API", pattern: /\/api\/state\b/i },
    { label: "local sessions API", pattern: /\/api\/sessions\b/i },
    { label: "monitor source", pattern: /monitor[\\/]server\.mjs/i },
    { label: "desktop source", pattern: /desktop[\\/]main\.mjs/i },
    { label: "Dashboard component source", pattern: /app[\\/]Dashboard(?:\.[cm]?[jt]sx?)?/i },
    { label: "local security modules", pattern: /shared[\\/]local-(?:auth|service)/i },
    { label: "parent source import", pattern: /\.\.[\\/](?:app|desktop|monitor|shared|web)[\\/]/i },
    { label: "absolute repository source path", pattern: /C:[\\/]Workspace[\\/]repos[\\/]Pomegr[\\/](?!landing[\\/])/i },
  ];

  for (const path of files) {
    const rel = relative(dist, path);
    if (forbiddenPath.test(rel)) failures.push(`forbidden local-app artifact path: ${rel}`);
    if (extname(path) === ".map") failures.push(`source map must not ship: ${rel}`);
    if (!textExtensions.has(extname(path)) && !path.endsWith(".vite/manifest.json")) continue;

    const contents = readFileSync(path, "utf8");
    for (const { label, pattern } of forbiddenText) {
      if (pattern.test(contents)) failures.push(`${rel} contains ${label}`);
    }
  }

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
if (!sourceOnly) auditArtifact();

if (failures.length) {
  console.error("Landing deployment boundary check failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else if (sourceOnly) {
  console.log("landing/ source import boundary verified");
}
