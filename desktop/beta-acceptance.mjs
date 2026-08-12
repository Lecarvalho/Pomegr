import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion, releaseArtifactNames } from "./release-policy.mjs";

export const BETA_ACCEPTANCE_SCHEMA_VERSION = 3;
export const BETA_ACCEPTANCE_MANUAL_GATES = Object.freeze([
  "downloadArtifacts",
  "verifyChecksums",
  "verifyPublisherSignature",
  "standardUserInstall",
  "firstLaunch",
  "providerDiscovery",
  "needsInputNotification",
  "preferenceRestart",
  "signedUpdate",
  "updateFailureRecovery",
  "cleanShutdown",
  "uninstallDataBoundary",
  "portableIsolation",
  "packagedLegal",
  "artifactPrivacyInspection",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()+,:/-]{0,255}$/;
const THREADLIGHT_WORKFLOW_RUN_URL = /^https:\/\/github\.com\/Lecarvalho\/threadlight\/actions\/runs\/[1-9]\d*$/;
const RECORD_KEYS = Object.freeze(["schemaVersion", "completedOn", "evidence"]);
const EVIDENCE_KEYS = Object.freeze([
  "windowsVersion",
  "vmImage",
  "systemNodeInstalled",
  "releases",
  "updateVerification",
  "manual",
]);
const RELEASES_KEYS = Object.freeze(["older", "newer"]);
const OLDER_RELEASE_KEYS = Object.freeze([
  "version",
  "tag",
  "releaseUrl",
  "workflowRunUrl",
  "installerSha256",
  "installerSignature",
]);
const NEWER_RELEASE_KEYS = Object.freeze([
  "version",
  "tag",
  "releaseUrl",
  "workflowRunUrl",
  "artifacts",
  "installerSignature",
]);
const UPDATE_VERIFICATION_KEYS = Object.freeze([
  "signedUpdate",
  "unsignedFixture",
  "wrongPublisherFixture",
  "interruptedDownloadRecovery",
]);
const SIGNED_UPDATE_KEYS = Object.freeze([
  "downloadedUpdateSha256",
  "downloadedSignature",
  "installedExecutableSha256",
  "installedSignature",
  "outcome",
]);
const MATCHED_SIGNATURE_KEYS = Object.freeze(["status", "publisher", "timestamp"]);
const UNSIGNED_FIXTURE_KEYS = Object.freeze(["sha256", "authenticode", "outcome"]);
const WRONG_PUBLISHER_FIXTURE_KEYS = Object.freeze(["sha256", "authenticode", "publisher", "timestamp", "outcome"]);

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const allowlist = [...expected].sort();
  if (actual.length !== allowlist.length || actual.some((key, index) => key !== allowlist[index])) throw new Error(code);
}

function requireSafeText(value, code) {
  if (typeof value !== "string" || !SAFE_TEXT_PATTERN.test(value)) throw new Error(code);
  return value;
}

function parseBetaCoordinates(version, code) {
  let release;
  try {
    release = parseReleaseVersion(version);
  } catch {
    throw new Error(code);
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.exec(version || "");
  if (release.channel !== "beta" || !match) throw new Error(code);
  return Object.freeze({ base: `${match[1]}.${match[2]}.${match[3]}`, ordinal: BigInt(match[4]) });
}

function assertReleaseIdentity(release, expectedKeys, code) {
  assertExactKeys(release, expectedKeys, `${code}_KEYS_INVALID`);
  parseBetaCoordinates(release.version, `${code}_VERSION_INVALID`);
  if (release.tag !== `v${release.version}`) throw new Error(`${code}_TAG_INVALID`);
  if (release.releaseUrl !== `https://github.com/Lecarvalho/threadlight/releases/tag/${release.tag}`
    || !THREADLIGHT_WORKFLOW_RUN_URL.test(release.workflowRunUrl || "")) {
    throw new Error(`${code}_URL_INVALID`);
  }
}

function assertSha256(value, code) {
  if (!SHA256_PATTERN.test(value || "")) throw new Error(code);
}

function assertMatchedSignature(signature, code) {
  assertExactKeys(signature, MATCHED_SIGNATURE_KEYS, `${code}_KEYS_INVALID`);
  if (signature.status !== "valid"
    || signature.publisher !== "match"
    || signature.timestamp !== "valid") {
    throw new Error(`${code}_INVALID`);
  }
}

function assertEvidence(evidence, expectedVersion) {
  assertExactKeys(evidence, EVIDENCE_KEYS, "DESKTOP_BETA_EVIDENCE_KEYS_INVALID");
  requireSafeText(evidence.windowsVersion, "DESKTOP_BETA_WINDOWS_VERSION_INVALID");
  requireSafeText(evidence.vmImage, "DESKTOP_BETA_VM_IMAGE_INVALID");
  if (evidence.systemNodeInstalled !== false) throw new Error("DESKTOP_BETA_SYSTEM_NODE_PRESENT");

  assertExactKeys(evidence.releases, RELEASES_KEYS, "DESKTOP_BETA_RELEASES_KEYS_INVALID");
  const { older, newer } = evidence.releases;
  assertReleaseIdentity(older, OLDER_RELEASE_KEYS, "DESKTOP_BETA_OLDER_RELEASE");
  assertReleaseIdentity(newer, NEWER_RELEASE_KEYS, "DESKTOP_BETA_NEWER_RELEASE");
  const olderCoordinates = parseBetaCoordinates(older.version, "DESKTOP_BETA_OLDER_RELEASE_VERSION_INVALID");
  const newerCoordinates = parseBetaCoordinates(newer.version, "DESKTOP_BETA_NEWER_RELEASE_VERSION_INVALID");
  if (newer.version !== expectedVersion) throw new Error("DESKTOP_BETA_VERSION_INVALID");
  if (olderCoordinates.base !== newerCoordinates.base || olderCoordinates.ordinal >= newerCoordinates.ordinal) {
    throw new Error("DESKTOP_BETA_RELEASE_ORDER_INVALID");
  }
  assertSha256(older.installerSha256, "DESKTOP_BETA_OLDER_INSTALLER_HASH_INVALID");
  assertMatchedSignature(older.installerSignature, "DESKTOP_BETA_OLDER_INSTALLER_SIGNATURE");

  const expected = releaseArtifactNames(newer.version);
  assertExactKeys(newer.artifacts, expected, "DESKTOP_BETA_ARTIFACT_SET_INVALID");
  for (const name of expected) {
    assertSha256(newer.artifacts[name], "DESKTOP_BETA_ARTIFACT_HASH_INVALID");
  }
  assertMatchedSignature(newer.installerSignature, "DESKTOP_BETA_NEWER_INSTALLER_SIGNATURE");

  assertExactKeys(evidence.updateVerification, UPDATE_VERIFICATION_KEYS, "DESKTOP_BETA_UPDATE_VERIFICATION_KEYS_INVALID");
  const { signedUpdate, unsignedFixture, wrongPublisherFixture } = evidence.updateVerification;
  assertExactKeys(signedUpdate, SIGNED_UPDATE_KEYS, "DESKTOP_BETA_SIGNED_UPDATE_KEYS_INVALID");
  assertSha256(signedUpdate.downloadedUpdateSha256, "DESKTOP_BETA_DOWNLOADED_UPDATE_HASH_INVALID");
  assertSha256(signedUpdate.installedExecutableSha256, "DESKTOP_BETA_INSTALLED_EXECUTABLE_HASH_INVALID");
  assertMatchedSignature(signedUpdate.downloadedSignature, "DESKTOP_BETA_DOWNLOADED_UPDATE_SIGNATURE");
  assertMatchedSignature(signedUpdate.installedSignature, "DESKTOP_BETA_INSTALLED_EXECUTABLE_SIGNATURE");
  const newerInstallerName = `Threadlight-Setup-${newer.version}-x64.exe`;
  if (signedUpdate.downloadedUpdateSha256.toLowerCase() !== newer.artifacts[newerInstallerName].toLowerCase()) {
    throw new Error("DESKTOP_BETA_DOWNLOADED_UPDATE_HASH_MISMATCH");
  }
  if (signedUpdate.outcome !== "accepted") throw new Error("DESKTOP_BETA_SIGNED_UPDATE_NOT_ACCEPTED");
  assertExactKeys(unsignedFixture, UNSIGNED_FIXTURE_KEYS, "DESKTOP_BETA_UNSIGNED_FIXTURE_KEYS_INVALID");
  assertSha256(unsignedFixture.sha256, "DESKTOP_BETA_UNSIGNED_FIXTURE_HASH_INVALID");
  if (unsignedFixture.authenticode !== "not-signed" || unsignedFixture.outcome !== "rejected-unsigned") {
    throw new Error("DESKTOP_BETA_UNSIGNED_FIXTURE_EVIDENCE_INVALID");
  }
  assertExactKeys(wrongPublisherFixture, WRONG_PUBLISHER_FIXTURE_KEYS, "DESKTOP_BETA_WRONG_PUBLISHER_FIXTURE_KEYS_INVALID");
  assertSha256(wrongPublisherFixture.sha256, "DESKTOP_BETA_WRONG_PUBLISHER_FIXTURE_HASH_INVALID");
  if (wrongPublisherFixture.authenticode !== "valid"
    || wrongPublisherFixture.publisher !== "different"
    || wrongPublisherFixture.timestamp !== "valid"
    || wrongPublisherFixture.outcome !== "rejected-wrong-publisher") {
    throw new Error("DESKTOP_BETA_WRONG_PUBLISHER_FIXTURE_EVIDENCE_INVALID");
  }
  if (evidence.updateVerification.interruptedDownloadRecovery !== "pass") {
    throw new Error("DESKTOP_BETA_INTERRUPTED_DOWNLOAD_RECOVERY_INCOMPLETE");
  }

  assertExactKeys(evidence.manual, BETA_ACCEPTANCE_MANUAL_GATES, "DESKTOP_BETA_MANUAL_EVIDENCE_INVALID");
  for (const gate of BETA_ACCEPTANCE_MANUAL_GATES) {
    if (evidence.manual[gate] !== "pass") throw new Error(`DESKTOP_BETA_MANUAL_${gate.toUpperCase()}_INCOMPLETE`);
  }
}

export function assertBetaAcceptanceRecord(record, expectedVersion) {
  assertExactKeys(record, RECORD_KEYS, "DESKTOP_BETA_RECORD_KEYS_INVALID");
  if (record.schemaVersion !== BETA_ACCEPTANCE_SCHEMA_VERSION) throw new Error("DESKTOP_BETA_SCHEMA_INVALID");
  parseBetaCoordinates(expectedVersion, "DESKTOP_BETA_VERSION_INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.completedOn || "")) throw new Error("DESKTOP_BETA_DATE_INVALID");
  assertEvidence(record.evidence, expectedVersion);
  return Object.freeze({ version: record.evidence.releases.newer.version, manualGateCount: BETA_ACCEPTANCE_MANUAL_GATES.length });
}

export function betaAcceptanceTemplate(version) {
  const release = parseReleaseVersion(version);
  if (release.channel !== "beta") throw new Error("DESKTOP_BETA_VERSION_INVALID");
  return {
    schemaVersion: BETA_ACCEPTANCE_SCHEMA_VERSION,
    completedOn: "YYYY-MM-DD",
    evidence: {
      windowsVersion: "REPLACE_WITH_SUPPORTED_WINDOWS_VERSION",
      vmImage: "REPLACE_WITH_CLEAN_VM_IMAGE",
      systemNodeInstalled: false,
      releases: {
        older: {
          version: "REPLACE_WITH_OLDER_BETA_VERSION",
          tag: "REPLACE_WITH_OLDER_BETA_TAG",
          releaseUrl: "REPLACE_WITH_OLDER_BETA_RELEASE_URL",
          workflowRunUrl: "REPLACE_WITH_OLDER_BETA_WORKFLOW_RUN_URL",
          installerSha256: "REPLACE_WITH_OLDER_INSTALLER_SHA256",
          installerSignature: {
            status: "pending",
            publisher: "pending",
            timestamp: "pending",
          },
        },
        newer: {
          version,
          tag: `v${version}`,
          releaseUrl: `https://github.com/Lecarvalho/threadlight/releases/tag/v${version}`,
          workflowRunUrl: "https://github.com/Lecarvalho/threadlight/actions/runs/REPLACE_WITH_NEWER_RUN_ID",
          artifacts: Object.fromEntries(releaseArtifactNames(version).map((name) => [name, "REPLACE_WITH_SHA256"])),
          installerSignature: {
            status: "pending",
            publisher: "pending",
            timestamp: "pending",
          },
        },
      },
      updateVerification: {
        signedUpdate: {
          downloadedUpdateSha256: "REPLACE_WITH_DOWNLOADED_UPDATE_SHA256",
          downloadedSignature: {
            status: "pending",
            publisher: "pending",
            timestamp: "pending",
          },
          installedExecutableSha256: "REPLACE_WITH_INSTALLED_EXECUTABLE_SHA256",
          installedSignature: {
            status: "pending",
            publisher: "pending",
            timestamp: "pending",
          },
          outcome: "pending",
        },
        unsignedFixture: {
          sha256: "REPLACE_WITH_UNSIGNED_FIXTURE_SHA256",
          authenticode: "pending",
          outcome: "pending",
        },
        wrongPublisherFixture: {
          sha256: "REPLACE_WITH_WRONG_PUBLISHER_FIXTURE_SHA256",
          authenticode: "pending",
          publisher: "pending",
          timestamp: "pending",
          outcome: "pending",
        },
        interruptedDownloadRecovery: "pending",
      },
      manual: Object.fromEntries(BETA_ACCEPTANCE_MANUAL_GATES.map((gate) => [gate, "pending"])),
    },
  };
}

export async function verifyBetaAcceptanceFile(filename, expectedVersion) {
  const bytes = await readFile(filename);
  if (bytes.length > 64 * 1024) throw new Error("DESKTOP_BETA_RECORD_TOO_LARGE");
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("DESKTOP_BETA_RECORD_INVALID"); }
  const result = assertBetaAcceptanceRecord(record, expectedVersion);
  return Object.freeze({ ...result, sha256: createHash("sha256").update(bytes).digest("hex") });
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const version = option("--version") || packageJson.version;
  const defaultFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "release-acceptance", `desktop-beta-${version}.json`);
  const filename = path.resolve(option("--file") || defaultFile);
  if (command === "init") {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `${JSON.stringify(betaAcceptanceTemplate(version), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`created beta acceptance template: ${filename}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verifyBetaAcceptanceFile(filename, version);
    process.stdout.write(`Threadlight desktop beta acceptance: PASS (${result.version}; ${result.manualGateCount} manual gates; sha256 ${result.sha256})\n`);
    return;
  }
  throw new Error("DESKTOP_BETA_COMMAND_INVALID");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    const code = /^DESKTOP_[A-Z0-9_]+$/.test(error?.message) ? error.message : "DESKTOP_BETA_ACCEPTANCE_FAILED";
    process.stderr.write(`Threadlight desktop beta acceptance: FAIL (${code})\n`);
    process.exitCode = 1;
  });
}
