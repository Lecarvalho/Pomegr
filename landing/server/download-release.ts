import { z } from "zod";

const REPOSITORY = "https://github.com/Lecarvalho/Pomegr";
const RELEASE_API = "https://api.github.com/repos/Lecarvalho/Pomegr/releases/latest";
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/).max(64),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(z.object({
    name: z.string().max(128),
    size: z.number().int().positive().max(5_000_000_000),
    state: z.literal("uploaded"),
  })).max(100),
});

export function parseDownloadRelease(value: unknown) {
  const release = releaseSchema.parse(value);
  const version = release.tag_name.slice(1);
  function asset(kind: "Setup" | "Portable") {
    const name = `Pomegr-${kind}-${version}-x64.exe`;
    const matches = release.assets.filter((item) => item.name === name);
    if (matches.length !== 1) throw new Error("Incomplete desktop release");
    return {
      name,
      size: matches[0].size,
      url: `${REPOSITORY}/releases/download/${release.tag_name}/${name}`,
    };
  }
  return {
    version,
    notesUrl: `${REPOSITORY}/releases/tag/${release.tag_name}`,
    installer: asset("Setup"),
    portable: asset("Portable"),
  };
}

// Verified published assets, retained so a GitHub outage never leaves empty links.
const fallbackRelease = parseDownloadRelease({
  tag_name: "v0.3.6", draft: false, prerelease: false,
  assets: [
    { name: "Pomegr-Setup-0.3.6-x64.exe", size: 220523016, state: "uploaded" },
    { name: "Pomegr-Portable-0.3.6-x64.exe", size: 220302776, state: "uploaded" },
  ],
});

export async function getDownloadRelease() {
  try {
    const options: RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } } = {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pomegr-landing" },
      signal: AbortSignal.timeout(3000),
      // workerd rejects "error" before fetching. Manual mode leaves redirects
      // unfollowed; the non-OK check below rejects their 3xx responses.
      redirect: "manual",
      cf: { cacheTtl: 900, cacheEverything: true },
    };
    const response = await fetch(RELEASE_API, options);
    if (!response.ok) return fallbackRelease;
    return parseDownloadRelease(await response.json());
  } catch {
    return fallbackRelease;
  }
}

export function formatDownloadSize(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
