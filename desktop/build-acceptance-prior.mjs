import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_PRIOR_ARTIFACT,
  ACCEPTANCE_PRIOR_OUTPUT,
  ACCEPTANCE_PRIOR_VERSION,
} from "./acceptance-prior.mjs";
import { POMEGR_DT_08_PACKAGING_SCOPE, assertPomegrDt08PackagingScope } from "./pomegr-dt-08-scope.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
assertPomegrDt08PackagingScope(packageJson);
if (packageJson.version !== "0.2.4" || ACCEPTANCE_PRIOR_VERSION !== "0.0.9") {
  throw new Error("DESKTOP_ACCEPTANCE_PRIOR_VERSION_PAIR_INVALID");
}

const outputRoot = path.join(repositoryRoot, ACCEPTANCE_PRIOR_OUTPUT);
if (!outputRoot.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("DESKTOP_ACCEPTANCE_OUTPUT_INVALID");
await rm(outputRoot, { force: true, recursive: true });
const { Arch, Platform, build } = await import("electron-builder");

await build({
  projectDir: repositoryRoot,
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  config: {
    directories: { output: ACCEPTANCE_PRIOR_OUTPUT },
    extraMetadata: {
      pomegrPackagingScope: POMEGR_DT_08_PACKAGING_SCOPE,
      version: ACCEPTANCE_PRIOR_VERSION,
    },
    nsis: { artifactName: ACCEPTANCE_PRIOR_ARTIFACT },
  },
});

for (const filename of [
  ".icon-ico",
  "builder-debug.yml",
  "builder-effective-config.yaml",
  "latest.yml",
  `${ACCEPTANCE_PRIOR_ARTIFACT}.blockmap`,
]) {
  await rm(path.join(outputRoot, filename), { force: true, recursive: true });
}

const expected = new Set(["win-unpacked", ACCEPTANCE_PRIOR_ARTIFACT]);
if ((await readdir(outputRoot)).some((filename) => !expected.has(filename))) {
  throw new Error("DESKTOP_ACCEPTANCE_OUTPUT_NOT_ALLOWLISTED");
}
console.log(`Pomegr test-only prior installer: ${ACCEPTANCE_PRIOR_ARTIFACT}`);
