import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(repositoryRoot, ".electron-builder-cache");
const cachePackagePath = path.join(cacheRoot, "package.json");
const cachePackage = Object.freeze({ private: true, type: "commonjs" });
const cachePackageText = `${JSON.stringify(cachePackage, null, 2)}\n`;

async function assertOrdinaryPath(filename, expectedKind) {
  let details;
  try { details = await lstat(filename); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("DESKTOP_BUILDER_CACHE_INSPECTION_FAILED");
  }
  if (details.isSymbolicLink()) throw new Error("DESKTOP_BUILDER_CACHE_PATH_INVALID");
  if (expectedKind === "directory" ? !details.isDirectory() : !details.isFile()) {
    throw new Error("DESKTOP_BUILDER_CACHE_PATH_INVALID");
  }
  return true;
}

if (await assertOrdinaryPath(cacheRoot, "directory")) {
  if (await assertOrdinaryPath(cachePackagePath, "file")) {
    let existing;
    try { existing = await readFile(cachePackagePath, "utf8"); } catch {
      throw new Error("DESKTOP_BUILDER_CACHE_INSPECTION_FAILED");
    }
    if (existing !== cachePackageText) throw new Error("DESKTOP_BUILDER_CACHE_SCOPE_INVALID");
  } else {
    await writeFile(cachePackagePath, cachePackageText, { flag: "wx" });
  }
} else {
  await mkdir(cacheRoot);
  await writeFile(cachePackagePath, cachePackageText, { flag: "wx" });
}

console.log("Pomegr Electron builder cache: CommonJS tool scope ready.");
