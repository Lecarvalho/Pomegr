import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withProductionBuildLock } from "../../scripts/production-build-lock.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function createProductionBuildFixture(root = repositoryRoot) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-production-build-"));
  const outDir = path.join(directory, "dist");
  const close = () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try {
    await withProductionBuildLock(root, () => cp(path.join(root, "dist"), outDir, { recursive: true }));
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    return { outDir, close };
  } catch (error) {
    await close();
    throw error;
  }
}
