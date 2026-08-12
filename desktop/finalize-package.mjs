import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedArtifactNames, expectedUpdateArtifactNames } from "./artifact-policy.mjs";
import { assertTlDt05PackagingScope } from "./tl-dt-05-scope.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
assertTlDt05PackagingScope(packageJson);
const releaseRoot = path.resolve(repositoryRoot, packageJson.build.directories.output);
if (!releaseRoot.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("DESKTOP_RELEASE_ROOT_INVALID");

for (const filename of [
  ".icon-ico",
  "builder-debug.yml",
  "builder-effective-config.yaml",
]) {
  await rm(path.join(releaseRoot, filename), { force: true, recursive: true });
}

const expected = new Set(["win-unpacked", ...expectedArtifactNames(packageJson.version), ...expectedUpdateArtifactNames(packageJson.version)]);
const actual = await readdir(releaseRoot);
if (actual.some((filename) => !expected.has(filename)) || actual.some((filename) => filename.includes(".__uninstaller."))) {
  throw new Error("DESKTOP_RELEASE_OUTPUT_NOT_ALLOWLISTED");
}
