import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

// vinext draws random build and deployment IDs when none are named; pinning them to the commit keeps two builds of one commit identical.
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
