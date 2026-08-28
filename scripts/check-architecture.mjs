import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LINES = 800;
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".agents",
  ".electron-builder-cache",
  ".next",
  ".vinext",
  ".wrangler",
  "build",
  "dist",
  "node_modules",
  "release",
  "release-acceptance",
  "plugins",
  "workers",
]);

// Existing large files are grandfathered at their current size. They may shrink,
// but a change that makes one of them larger fails the verifier.
const GRANDFATHERED_LINE_LIMITS = new Map([
  ["monitor/providers/codex-liveness.mjs", 881],
  ["tests/claude-provider.test.mjs", 861],
  ["tests/codex-liveness.test.mjs", 985],
  ["tests/pomegr-plugin.test.mjs", 822],
]);

const LEGACY_FILENAME = /(?:^|[-_.])(?:backup|copy|legacy|old|orig|tmp|v\d+)(?:[-_.]|$)/i;

function displayPath(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

async function collectSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entryPath);
  }
  return files;
}

async function checkLineBudgets(files) {
  const errors = [];
  for (const filePath of files) {
    const relativePath = displayPath(filePath);
    const normalized = (await readFile(filePath, "utf8")).replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const lineCount = lines.length;
    const grandfathered = GRANDFATHERED_LINE_LIMITS.get(relativePath);
    if (grandfathered !== undefined) {
      if (lineCount > grandfathered) errors.push(`${relativePath} has ${lineCount} lines; grandfathered limit is ${grandfathered}`);
    } else if (lineCount > MAX_LINES) {
      errors.push(`${relativePath} has ${lineCount} lines; new files must stay at or below ${MAX_LINES}`);
    }
  }
  return errors;
}

function checkFilenames(files) {
  return files
    .map(displayPath)
    .filter((relativePath) => LEGACY_FILENAME.test(path.basename(relativePath)))
    .map((relativePath) => `${relativePath} uses a legacy/versioned source filename`);
}

const files = await collectSourceFiles(repositoryRoot);
const errors = [
  ...await checkLineBudgets(files),
  ...checkFilenames(files),
];

if (errors.length) {
  console.error("Architecture checks failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${files.length} source files; max new file size ${MAX_LINES} lines).`);
}
