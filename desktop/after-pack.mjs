import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { assertTlDt05PackagingScope } from "./tl-dt-05-scope.mjs";

export default async function removeUnshippedElectronResources(context) {
  const packageJson = JSON.parse(await readFile(path.join(context.packager.projectDir, "package.json"), "utf8"));
  assertTlDt05PackagingScope(packageJson);
  const resourcesRoot = path.join(context.appOutDir, "resources");
  await Promise.all([
    rm(path.join(resourcesRoot, "default_app.asar"), { force: true }),
    rm(path.join(resourcesRoot, "app-update.yml"), { force: true }),
  ]);
}
