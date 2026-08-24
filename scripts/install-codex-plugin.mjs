#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPluginSource = path.join(repositoryRoot, "plugins", "pomegr");
const pluginRelativePath = path.join("plugins", "pomegr");
const marketplaceRelativePath = path.join(".agents", "plugins", "marketplace.json");
const marketplaceEntry = {
  name: "pomegr",
  source: {
    source: "local",
    path: "./plugins/pomegr",
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "Productivity",
};

function usage() {
  return [
    "Usage: node scripts/install-codex-plugin.mjs --repo <repository> [--dry-run] [--json]",
    "",
    "Install the bundled Pomegr Codex plugin and repo marketplace entry into a Git repository.",
    "Use --dry-run to validate and preview every change without writing files.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { dryRun: false, json: false, repository: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--repo requires a path.");
      options.repository = value;
    }
    else if (argument.startsWith("--repo=")) options.repository = argument.slice("--repo=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && !options.repository) throw new Error("--repo is required.");
  return options;
}

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateTargetRepository(target) {
  const targetStat = await stat(target).catch(() => null);
  if (!targetStat?.isDirectory()) throw new Error(`Target repository does not exist: ${target}`);
  if (!await exists(path.join(target, ".git"))) {
    throw new Error(`Target must be a Git repository root containing .git: ${target}`);
  }
}

async function rejectSymlinkComponents(root, relativeTarget) {
  let current = root;
  for (const segment of relativeTarget.split(path.sep)) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return;
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${current}`);
    }
  }
}

async function collectPluginFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin packages may not contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) files.push(...await collectPluginFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

async function readJson(file, label) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON: ${file}`);
  }
}

function nextMarketplace(existing, marketplacePath) {
  if (existing === null) {
    return {
      name: "pomegr",
      interface: { displayName: "Pomegr" },
      plugins: [marketplaceEntry],
    };
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`Marketplace must contain a JSON object: ${marketplacePath}`);
  }
  if (typeof existing.name !== "string" || !existing.name.trim()) {
    throw new Error(`Marketplace name must be a non-empty string: ${marketplacePath}`);
  }
  if (!Array.isArray(existing.plugins)) {
    throw new Error(`Marketplace plugins must be an array: ${marketplacePath}`);
  }

  const plugins = [...existing.plugins];
  const duplicateIndexes = plugins
    .map((plugin, index) => plugin?.name === "pomegr" ? index : -1)
    .filter((index) => index >= 0);
  if (duplicateIndexes.length > 1) {
    throw new Error(`Marketplace contains duplicate Pomegr entries: ${marketplacePath}`);
  }
  if (duplicateIndexes.length === 1) {
    const current = plugins[duplicateIndexes[0]];
    const currentPolicy = current?.policy && typeof current.policy === "object" && !Array.isArray(current.policy)
      ? current.policy
      : {};
    plugins[duplicateIndexes[0]] = {
      ...current,
      name: "pomegr",
      source: marketplaceEntry.source,
      policy: { ...marketplaceEntry.policy, ...currentPolicy },
      category: typeof current?.category === "string" && current.category ? current.category : marketplaceEntry.category,
    };
  }
  else plugins.push(marketplaceEntry);
  return { ...existing, plugins };
}

async function validateExistingPlugin(destination) {
  if (!await exists(destination)) return;
  const manifestPath = path.join(destination, ".codex-plugin", "plugin.json");
  const manifest = await readJson(manifestPath, "Existing plugin manifest");
  if (manifest?.name !== "pomegr") {
    throw new Error(`Refusing to overwrite a non-Pomegr plugin directory: ${destination}`);
  }
}

async function sameContents(left, right) {
  try {
    const [leftContents, rightContents] = await Promise.all([readFile(left), readFile(right)]);
    return leftContents.equals(rightContents);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function installCodexPlugin({
  targetRepository,
  dryRun = false,
  pluginSource = defaultPluginSource,
} = {}) {
  if (!targetRepository) throw new Error("A target repository is required.");
  const requestedTarget = path.resolve(targetRepository);
  await validateTargetRepository(requestedTarget);
  const target = await realpath(requestedTarget);
  const source = await realpath(path.resolve(pluginSource));
  const destination = path.join(target, pluginRelativePath);
  const marketplacePath = path.join(target, marketplaceRelativePath);

  await rejectSymlinkComponents(target, pluginRelativePath);
  await rejectSymlinkComponents(target, marketplaceRelativePath);
  const sourceManifest = await readJson(path.join(source, ".codex-plugin", "plugin.json"), "Source plugin manifest");
  if (sourceManifest?.name !== "pomegr") throw new Error(`Invalid Pomegr plugin source: ${source}`);
  await validateExistingPlugin(destination);

  const relativeFiles = await collectPluginFiles(source);
  if (!relativeFiles.includes(path.join("mcp", "server.bundle.mjs"))) {
    throw new Error("The Pomegr Codex plugin bundle is missing. Run npm run build:plugin:codex first.");
  }
  if (source !== destination && await exists(destination)) {
    const sourceFiles = new Set(relativeFiles);
    const unmanagedFiles = (await collectPluginFiles(destination)).filter((file) => !sourceFiles.has(file));
    if (unmanagedFiles.length > 0) {
      throw new Error(`Refusing to leave unmanaged files in the Pomegr plugin directory: ${unmanagedFiles.join(", ")}`);
    }
  }

  const fileChanges = [];
  for (const relativeFile of relativeFiles) {
    const sourceFile = path.join(source, relativeFile);
    const destinationFile = path.join(destination, relativeFile);
    const destinationExists = await exists(destinationFile);
    const action = destinationExists
      ? await sameContents(sourceFile, destinationFile) ? "unchanged" : "update"
      : "create";
    fileChanges.push({ action, path: path.join(pluginRelativePath, relativeFile).replaceAll("\\", "/") });
  }

  const currentMarketplace = await readJson(marketplacePath, "Repository marketplace");
  const desiredMarketplace = nextMarketplace(currentMarketplace, marketplacePath);
  const desiredMarketplaceText = `${JSON.stringify(desiredMarketplace, null, 2)}\n`;
  const marketplaceAction = currentMarketplace === null
    ? "create"
    : await readFile(marketplacePath, "utf8") === desiredMarketplaceText ? "unchanged" : "update";

  if (!dryRun) {
    for (const change of fileChanges) {
      if (change.action === "unchanged") continue;
      const relativeFile = change.path.slice("plugins/pomegr/".length);
      const sourceFile = path.join(source, ...relativeFile.split("/"));
      const destinationFile = path.join(destination, ...relativeFile.split("/"));
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await copyFile(sourceFile, destinationFile);
    }
    if (marketplaceAction !== "unchanged") {
      await mkdir(path.dirname(marketplacePath), { recursive: true });
      const temporaryMarketplacePath = `${marketplacePath}.pomegr-${process.pid}.tmp`;
      try {
        await writeFile(temporaryMarketplacePath, desiredMarketplaceText, "utf8");
        await rename(temporaryMarketplacePath, marketplacePath);
      } finally {
        await rm(temporaryMarketplacePath, { force: true }).catch(() => {});
      }
    }
  }

  return {
    dryRun,
    repository: target,
    plugin: {
      destination,
      files: fileChanges,
    },
    marketplace: {
      action: marketplaceAction,
      name: desiredMarketplace.name,
      path: marketplacePath,
    },
  };
}

function renderResult(result) {
  const counts = result.plugin.files.reduce((summary, file) => {
    summary[file.action] += 1;
    return summary;
  }, { create: 0, update: 0, unchanged: 0 });
  const heading = result.dryRun ? "Pomegr Codex plugin dry run" : "Pomegr Codex plugin installed";
  const lines = [
    `${heading}: ${result.repository}`,
    `Plugin files: ${counts.create} create, ${counts.update} update, ${counts.unchanged} unchanged`,
    `Marketplace: ${result.marketplace.action}`,
  ];
  if (result.dryRun) lines.push("No files were written.");
  else lines.push(
    "Register and install the repository plugin with:",
    `codex plugin marketplace add "${result.repository}"`,
    `codex plugin add pomegr@${result.marketplace.name}`,
    "Then restart Codex and start a new task in this repository.",
  );
  return lines.join("\n");
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await installCodexPlugin({
      targetRepository: options.repository,
      dryRun: options.dryRun,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderResult(result));
  } catch (error) {
    console.error(`Pomegr Codex plugin install failed: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
