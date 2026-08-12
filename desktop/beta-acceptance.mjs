import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion, releaseArtifactNames } from "./release-policy.mjs";

export const BETA_ACCEPTANCE_SCHEMA_VERSION = 2;
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
const RECORD_KEYS = Object.freeze(["schemaVersion", "version", "tag", "completedOn", "evidence"]);
const EVIDENCE_KEYS = Object.freeze([
  "windowsVersion",
  "vmImage",
  "systemNodeInstalled",
  "releaseUrl",
  "workflowRunUrl",
  "artifacts",
  "manual",
]);

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

function assertEvidence(evidence, version) {
  assertExactKeys(evidence, EVIDENCE_KEYS, "DESKTOP_BETA_EVIDENCE_KEYS_INVALID");
  requireSafeText(evidence.windowsVersion, "DESKTOP_BETA_WINDOWS_VERSION_INVALID");
  requireSafeText(evidence.vmImage, "DESKTOP_BETA_VM_IMAGE_INVALID");
  if (evidence.systemNodeInstalled !== false) throw new Error("DESKTOP_BETA_SYSTEM_NODE_PRESENT");
  if (evidence.releaseUrl !== `https://github.com/Lecarvalho/threadlight/releases/tag/v${version}`
    || !THREADLIGHT_WORKFLOW_RUN_URL.test(evidence.workflowRunUrl || "")) {
    throw new Error("DESKTOP_BETA_EVIDENCE_URL_INVALID");
  }
  const expected = releaseArtifactNames(version);
  assertExactKeys(evidence.artifacts, expected, "DESKTOP_BETA_ARTIFACT_SET_INVALID");
  for (const name of expected) {
    if (!SHA256_PATTERN.test(evidence.artifacts[name] || "")) throw new Error("DESKTOP_BETA_ARTIFACT_HASH_INVALID");
  }
  assertExactKeys(evidence.manual, BETA_ACCEPTANCE_MANUAL_GATES, "DESKTOP_BETA_MANUAL_EVIDENCE_INVALID");
  for (const gate of BETA_ACCEPTANCE_MANUAL_GATES) {
    if (evidence.manual[gate] !== "pass") throw new Error(`DESKTOP_BETA_MANUAL_${gate.toUpperCase()}_INCOMPLETE`);
  }
}

export function assertBetaAcceptanceRecord(record, expectedVersion) {
  assertExactKeys(record, RECORD_KEYS, "DESKTOP_BETA_RECORD_KEYS_INVALID");
  if (record.schemaVersion !== BETA_ACCEPTANCE_SCHEMA_VERSION) throw new Error("DESKTOP_BETA_SCHEMA_INVALID");
  const release = parseReleaseVersion(record.version);
  if (release.channel !== "beta" || record.version !== expectedVersion) throw new Error("DESKTOP_BETA_VERSION_INVALID");
  if (!/^v\d+\.\d+\.\d+-beta\.\d+$/.test(record.tag || "") || record.tag !== `v${record.version}`) {
    throw new Error("DESKTOP_BETA_TAG_INVALID");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.completedOn || "")) throw new Error("DESKTOP_BETA_DATE_INVALID");
  assertEvidence(record.evidence, record.version);
  return Object.freeze({ version: record.version, manualGateCount: BETA_ACCEPTANCE_MANUAL_GATES.length });
}

export function betaAcceptanceTemplate(version) {
  const release = parseReleaseVersion(version);
  if (release.channel !== "beta") throw new Error("DESKTOP_BETA_VERSION_INVALID");
  return {
    schemaVersion: BETA_ACCEPTANCE_SCHEMA_VERSION,
    version,
    tag: `v${version}`,
    completedOn: "YYYY-MM-DD",
    evidence: {
      windowsVersion: "REPLACE_WITH_SUPPORTED_WINDOWS_VERSION",
      vmImage: "REPLACE_WITH_CLEAN_VM_IMAGE",
      systemNodeInstalled: false,
      releaseUrl: `https://github.com/Lecarvalho/threadlight/releases/tag/v${version}`,
      workflowRunUrl: "https://github.com/Lecarvalho/threadlight/actions/runs/REPLACE_WITH_RUN_ID",
      artifacts: Object.fromEntries(releaseArtifactNames(version).map((name) => [name, "REPLACE_WITH_SHA256"])),
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
