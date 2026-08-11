import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packageNameFromLocation(location) {
  const marker = "node_modules/";
  const index = location.lastIndexOf(marker);
  return index < 0 ? "" : location.slice(index + marker.length);
}

function supportsTarget(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (values.includes(`!${target}`)) return false;
  const positive = values.filter((value) => typeof value === "string" && !value.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

function dependencyNames(metadata) {
  return [...new Set([
    ...Object.keys(metadata?.dependencies || {}),
    ...Object.keys(metadata?.optionalDependencies || {}),
  ])];
}

function resolveDependencyLocation(packages, parentLocation, dependencyName) {
  let cursor = parentLocation;
  while (true) {
    const candidate = `${cursor ? `${cursor}/` : ""}node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!cursor) return "";
    const nestedIndex = cursor.lastIndexOf("/node_modules/");
    cursor = nestedIndex < 0 ? "" : cursor.slice(0, nestedIndex);
  }
}

export function runtimeDependencyLocations(lock, options = {}) {
  const packages = lock?.packages || {};
  const locations = new Set();
  const queue = dependencyNames(packages[""]).map((name) => ["", name]);
  while (queue.length) {
    const [parentLocation, dependencyName] = queue.shift();
    const location = resolveDependencyLocation(packages, parentLocation, dependencyName);
    if (!location || locations.has(location)) continue;
    const metadata = packages[location];
    if (options.installedLocations && !options.installedLocations.has(location)) continue;
    if (options.platform && !supportsTarget(metadata.os, options.platform)) continue;
    if (options.arch && !supportsTarget(metadata.cpu, options.arch)) continue;
    locations.add(location);
    for (const name of dependencyNames(metadata)) queue.push([location, name]);
  }
  const electronLocation = "node_modules/electron";
  const electron = packages[electronLocation];
  if (electron
    && (!options.installedLocations || options.installedLocations.has(electronLocation))
    && (!options.platform || supportsTarget(electron.os, options.platform))
    && (!options.arch || supportsTarget(electron.cpu, options.arch))) {
    locations.add(electronLocation);
  }
  return locations;
}

export function productionDependencyNotices(lock, options = {}) {
  const dependencies = new Map();
  const runtimeLocations = runtimeDependencyLocations(lock, options);
  for (const [location, metadata] of Object.entries(lock?.packages || {})) {
    const name = packageNameFromLocation(location);
    if (!name || !metadata?.version || !runtimeLocations.has(location)) continue;
    if (typeof metadata.license !== "string" || !metadata.license.trim()) {
      throw new Error("DESKTOP_DEPENDENCY_LICENSE_MISSING");
    }
    dependencies.set(`${name}@${metadata.version}`, {
      name,
      version: metadata.version,
      license: metadata.license.trim(),
    });
  }
  return [...dependencies.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function renderThirdPartyNotices(lock, options = {}) {
  const rows = productionDependencyNotices(lock, options)
    .map(({ name, version, license }) => `| ${name.replaceAll("|", "\\|")} | ${version} | ${license.replaceAll("|", "\\|")} |`)
    .join("\n");
  return `# Third-party software notices

Threadlight includes the following installed Windows x64 runtime dependencies selected for the packaged application. Packages for other operating systems or CPU architectures are excluded. Each component remains subject to its own license. Package license texts are retained in the packaged dependency where supplied; Electron's distribution also includes its Electron and Chromium license files.

| Package | Version | License |
| --- | --- | --- |
${rows}

This inventory is generated from \`package-lock.json\` by \`npm run desktop:legal\`. It is a notice inventory, not a replacement for the applicable license terms.
`;
}

async function writeText(filename, content) {
  const normalized = content.replaceAll("\r\n", "\n");
  await writeFile(filename, normalized, "utf8");
}

export async function generateLegalNotices(root = repositoryRoot) {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const installedLocations = new Set(Object.keys(lock.packages || {}).filter((location) =>
    location.startsWith("node_modules/") && existsSync(path.join(root, ...location.split("/")))));
  const noticeOptions = { arch: "x64", installedLocations, platform: "win32" };
  const thirdPartyNotices = renderThirdPartyNotices(lock, noticeOptions);
  await writeText(path.join(root, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices);

  const publicLegalRoot = path.join(root, "public", "legal");
  await mkdir(publicLegalRoot, { recursive: true });
  const documents = [
    ["LICENSE", "LICENSE.txt"],
    ["NOTICE", "NOTICE.txt"],
    ["SOURCE.md", "SOURCE.txt"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"],
    ["TRADEMARKS.md", "TRADEMARKS.txt"],
  ];
  for (const [source, destination] of documents) {
    const content = source === "THIRD_PARTY_NOTICES.md"
      ? thirdPartyNotices
      : await readFile(path.join(root, source), "utf8");
    await writeText(path.join(publicLegalRoot, destination), content);
  }
  return Object.freeze({ dependencyCount: productionDependencyNotices(lock, noticeOptions).length });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateLegalNotices();
  console.log(`Threadlight legal notices: ${result.dependencyCount} runtime dependencies documented.`);
}
