import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { assertPomegrDt08PackagingScope } from "./pomegr-dt-08-scope.mjs";

export default async function removeUnshippedElectronResources(context) {
  const packageJson = JSON.parse(await readFile(path.join(context.packager.projectDir, "package.json"), "utf8"));
  assertPomegrDt08PackagingScope(packageJson);
  const resourcesRoot = path.join(context.appOutDir, "resources");
  const removable = [
    rm(path.join(resourcesRoot, "default_app.asar"), { force: true }),
  ];
  if (context.packager.appInfo.version === "0.0.9") {
    removable.push(rm(path.join(resourcesRoot, "app-update.yml"), { force: true }));
  }
  await Promise.all(removable);
}
