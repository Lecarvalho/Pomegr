import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

// Builds and test snapshots share this lock; tests release it before serving their copy.
export async function withProductionBuildLock(repositoryRoot, action) {
  const lockDirectory = path.join(repositoryRoot, ".wrangler");
  await mkdir(lockDirectory, { recursive: true });
  const release = await lockfile.lock(repositoryRoot, {
    lockfilePath: path.join(lockDirectory, "production-build.lock"),
    retries: { retries: 120, minTimeout: 250, maxTimeout: 1_000, factor: 1.2 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
