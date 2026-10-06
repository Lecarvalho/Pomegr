import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

// vinext bakes a build ID and a deployment ID into the bundles and draws both at random when the
// configuration names none, so two builds of one commit would differ in every content hash. The
// commit pins them; a new commit still gets new IDs, which the client uses to detect a deployment
// it was not built for. Outside a Git checkout the IDs stay random.
function commitId(): string | null {
  try {
    const id = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const commit = commitId();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  generateBuildId: () => commit,
  deploymentId: commit ?? undefined,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
