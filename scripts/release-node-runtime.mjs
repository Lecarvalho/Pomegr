import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function download(url, maximumBytes, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("POMEGR_RELEASE_NODE_DOWNLOAD_FAILED");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("POMEGR_RELEASE_NODE_DOWNLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Cache only the official Windows executable, avoiding npm's Git Bash placeholder. */
export async function ensureReleaseNodeRuntime({ version, repositoryRoot, fetchImpl = fetch, report = () => {} }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("POMEGR_RELEASE_NODE_VERSION_INVALID");
  const cache = path.resolve(repositoryRoot, ".electron-builder-cache", "release-node", version);
  const executable = path.join(cache, "node.exe");
  const checksumFile = path.join(cache, "node.sha256");
  try {
    const expected = (await readFile(checksumFile, "utf8")).trim();
    const metadata = await stat(executable);
    if (/^[a-f0-9]{64}$/.test(expected) && metadata.isFile() && metadata.size <= MAX_EXECUTABLE_BYTES
      && sha256(await readFile(executable)) === expected) return executable;
  } catch { /* Missing or incomplete caches are rebuilt before executing anything. */ }

  report(`Downloading the CI Node.js runtime (${version}) from nodejs.org…`);
  const base = `https://nodejs.org/dist/v${version}/`;
  const manifest = (await download(`${base}SHASUMS256.txt`, 128 * 1024, fetchImpl)).toString("utf8");
  const checksums = [...manifest.matchAll(/^([a-f0-9]{64})\s+win-x64\/node\.exe\r?$/gm)];
  if (checksums.length !== 1) throw new Error("POMEGR_RELEASE_NODE_CHECKSUM_MISSING");
  const expected = checksums[0][1];
  const binary = await download(`${base}win-x64/node.exe`, MAX_EXECUTABLE_BYTES, fetchImpl);
  if (sha256(binary) !== expected) throw new Error("POMEGR_RELEASE_NODE_CHECKSUM_MISMATCH");

  await mkdir(cache, { recursive: true });
  const suffix = randomUUID();
  const temporaryExecutable = path.join(cache, `${suffix}.exe`);
  const temporaryChecksum = path.join(cache, `${suffix}.sha256`);
  try {
    await writeFile(temporaryExecutable, binary, { flag: "wx" });
    await writeFile(temporaryChecksum, `${expected}\n`, { flag: "wx" });
    await rename(temporaryExecutable, executable);
    await rename(temporaryChecksum, checksumFile);
  } finally {
    await rm(temporaryExecutable, { force: true });
    await rm(temporaryChecksum, { force: true });
  }
  return executable;
}
