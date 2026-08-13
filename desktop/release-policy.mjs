import { readFile } from "node:fs/promises";

export const POMEGR_WINDOWS_PUBLISHER = "Leandro Carvalho";
export const RELEASE_LEGAL_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "SOURCE.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
]);

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const SAFE_ARTIFACT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseReleaseVersion(value) {
  const match = VERSION_PATTERN.exec(value || "");
  if (!match) throw new Error("DESKTOP_RELEASE_VERSION_INVALID");
  return Object.freeze({
    version: value,
    channel: match[4] === undefined ? "stable" : "beta",
    prerelease: match[4] !== undefined,
  });
}

export function assertReleaseTag({ tag, version }) {
  const release = parseReleaseVersion(version);
  if (tag !== `v${version}`) throw new Error("DESKTOP_RELEASE_TAG_VERSION_MISMATCH");
  return release;
}

export function updateMetadataName(version) {
  return parseReleaseVersion(version).channel === "beta" ? "beta.yml" : "latest.yml";
}

export function releaseArtifactNames(version, { includeChecksums = true } = {}) {
  parseReleaseVersion(version);
  const installer = `Pomegr-Setup-${version}-x64.exe`;
  const names = [
    installer,
    `${installer}.blockmap`,
    `Pomegr-Portable-${version}-x64.exe`,
    updateMetadataName(version),
    `Pomegr-${version}-source.zip`,
    "RELEASE_NOTES.md",
    ...RELEASE_LEGAL_FILES,
  ];
  if (includeChecksums) names.push("SHA256SUMS.txt");
  return Object.freeze(names);
}

export function assertReleaseArtifactNames(actualNames, version) {
  const actual = [...actualNames];
  if (actual.some((name) => !SAFE_ARTIFACT_PATTERN.test(name))) {
    throw new Error("DESKTOP_RELEASE_ARTIFACT_NAME_INVALID");
  }
  const expected = releaseArtifactNames(version);
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw new Error("DESKTOP_RELEASE_ARTIFACT_SET_INVALID");
  }
  return Object.freeze({ artifactCount: expected.length });
}

export function assertUpdateMetadata(text, version) {
  const installer = `Pomegr-Setup-${version}-x64.exe`;
  if (!new RegExp(`^version:\\s*["']?${version.replaceAll(".", "\\.")}["']?\\s*$`, "m").test(text)) {
    throw new Error("DESKTOP_RELEASE_METADATA_VERSION_INVALID");
  }
  if (!text.includes(installer) || !/^sha512:\s*\S+/m.test(text)) {
    throw new Error("DESKTOP_RELEASE_METADATA_INCOMPLETE");
  }
  if (/https?:\/\/[^\s"']+[?#][^\s"']+/i.test(text)) {
    throw new Error("DESKTOP_RELEASE_METADATA_SECRET_URL_FORBIDDEN");
  }
  return true;
}

export function renderChecksumManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("DESKTOP_RELEASE_CHECKSUMS_EMPTY");
  const normalized = entries.map(({ name, sha256 }) => {
    if (!SAFE_ARTIFACT_PATTERN.test(name) || !/^[a-f0-9]{64}$/i.test(sha256 || "")) {
      throw new Error("DESKTOP_RELEASE_CHECKSUM_INVALID");
    }
    return { name, sha256: sha256.toLowerCase() };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return `${normalized.map(({ name, sha256 }) => `${sha256} *${name}`).join("\n")}\n`;
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  if (command === "verify-tag") {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const release = assertReleaseTag({ tag: option("--tag"), version: packageJson.version });
    process.stdout.write(`${release.channel}\n`);
    return;
  }
  if (command === "verify-assets") {
    const version = option("--version");
    const assetDocument = JSON.parse(await readFile(option("--assets-file"), "utf8"));
    const names = Array.isArray(assetDocument) ? assetDocument : assetDocument.assets?.map(({ name }) => name);
    assertReleaseArtifactNames(names || [], version);
    process.stdout.write("release assets verified\n");
    return;
  }
  throw new Error("DESKTOP_RELEASE_POLICY_COMMAND_INVALID");
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
