import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BETA_ACCEPTANCE_MANUAL_GATES,
  assertBetaAcceptanceRecord,
  betaAcceptanceTemplate,
  verifyBetaAcceptanceFile,
} from "../desktop/beta-acceptance.mjs";
import { releaseArtifactNames } from "../desktop/release-policy.mjs";

function acceptedRecord(version = "1.2.3-beta.4", olderVersion = "1.2.3-beta.3") {
  const template = betaAcceptanceTemplate(version);
  template.completedOn = "2026-08-12";
  template.evidence.windowsVersion = "Windows 11 24H2 build 26100";
  template.evidence.vmImage = "Clean Windows 11 x64 24H2";
  template.evidence.releases.older = {
    version: olderVersion,
    tag: `v${olderVersion}`,
    releaseUrl: `https://github.com/Lecarvalho/pomegr/releases/tag/v${olderVersion}`,
    workflowRunUrl: "https://github.com/Lecarvalho/pomegr/actions/runs/123455",
    installerSha256: "1".repeat(64),
    installerSignature: { status: "valid", publisher: "match", timestamp: "valid" },
  };
  template.evidence.releases.newer.workflowRunUrl = "https://github.com/Lecarvalho/pomegr/actions/runs/123456";
  template.evidence.releases.newer.artifacts = Object.fromEntries(releaseArtifactNames(version).map((name, index) => [name, String(index + 1).padStart(64, "a").slice(-64)]));
  template.evidence.releases.newer.installerSignature = { status: "valid", publisher: "match", timestamp: "valid" };
  template.evidence.updateVerification = {
    signedUpdate: {
      downloadedUpdateSha256: template.evidence.releases.newer.artifacts[`Pomegr-Setup-${version}-x64.exe`],
      downloadedSignature: { status: "valid", publisher: "match", timestamp: "valid" },
      installedExecutableSha256: "3".repeat(64),
      installedSignature: { status: "valid", publisher: "match", timestamp: "valid" },
      outcome: "accepted",
    },
    unsignedFixture: { sha256: "4".repeat(64), authenticode: "not-signed", outcome: "rejected-unsigned" },
    wrongPublisherFixture: {
      sha256: "5".repeat(64),
      authenticode: "valid",
      publisher: "different",
      timestamp: "valid",
      outcome: "rejected-wrong-publisher",
    },
    interruptedDownloadRecovery: "pass",
  };
  template.evidence.manual = Object.fromEntries(BETA_ACCEPTANCE_MANUAL_GATES.map((gate) => [gate, "pass"]));
  return template;
}

test("beta acceptance requires every clean-VM gate and exact release artifact evidence", () => {
  const record = acceptedRecord();
  assert.deepEqual(assertBetaAcceptanceRecord(record, record.evidence.releases.newer.version), { version: record.evidence.releases.newer.version, manualGateCount: 15 });
  for (const gate of BETA_ACCEPTANCE_MANUAL_GATES) {
    const incomplete = structuredClone(record);
    incomplete.evidence.manual[gate] = "pending";
    assert.throws(() => assertBetaAcceptanceRecord(incomplete, incomplete.evidence.releases.newer.version), new RegExp(`MANUAL_${gate.toUpperCase()}_INCOMPLETE`));
  }
  const extraArtifact = structuredClone(record);
  extraArtifact.evidence.releases.newer.artifacts["private.env"] = "a".repeat(64);
  assert.throws(() => assertBetaAcceptanceRecord(extraArtifact, extraArtifact.evidence.releases.newer.version), /ARTIFACT_SET_INVALID/);
});

test("beta acceptance requires two monotonically ordered beta releases with the same base version", () => {
  assert.throws(() => betaAcceptanceTemplate("1.2.3"), /BETA_VERSION_INVALID/);
  for (const olderVersion of ["1.2.3-beta.4", "1.2.3-beta.5", "1.2.4-beta.3", "1.2.3"]) {
    const unordered = acceptedRecord("1.2.3-beta.4", olderVersion);
    assert.throws(
      () => assertBetaAcceptanceRecord(unordered, unordered.evidence.releases.newer.version),
      /RELEASE_(ORDER|VERSION)_INVALID/,
    );
  }
  const wrongExpectedVersion = acceptedRecord();
  assert.throws(() => assertBetaAcceptanceRecord(wrongExpectedVersion, "1.2.3-beta.5"), /BETA_VERSION_INVALID/);
});

test("beta acceptance rejects unsafe release links and absent Node-free evidence", () => {
  for (const [releaseName, field, value] of [
    ["older", "releaseUrl", "https://github.com/attacker/pomegr/releases/tag/v1.2.3-beta.3"],
    ["newer", "releaseUrl", "https://github.com/Lecarvalho/other/releases/tag/v1.2.3-beta.4"],
    ["newer", "releaseUrl", "https://github.com/Lecarvalho/pomegr/releases/tag/v1.2.3-beta.5"],
    ["older", "workflowRunUrl", "https://github.com/attacker/pomegr/actions/runs/123456"],
    ["newer", "workflowRunUrl", "https://github.com/Lecarvalho/other/actions/runs/123456"],
    ["newer", "workflowRunUrl", "https://github.com/Lecarvalho/pomegr/actions/runs/123456?token=secret"],
    ["newer", "workflowRunUrl", "https://github.com/Lecarvalho/pomegr/actions/runs/not-a-run"],
  ]) {
    const unsafe = acceptedRecord();
    unsafe.evidence.releases[releaseName][field] = value;
    assert.throws(() => assertBetaAcceptanceRecord(unsafe, unsafe.evidence.releases.newer.version), /RELEASE_URL_INVALID/);
  }
  const withNode = acceptedRecord();
  withNode.evidence.systemNodeInstalled = true;
  assert.throws(() => assertBetaAcceptanceRecord(withNode, withNode.evidence.releases.newer.version), /SYSTEM_NODE_PRESENT/);
});

test("beta acceptance requires bounded hashes and fixed update outcomes", () => {
  const cases = [
    [(record) => { record.evidence.releases.older.installerSha256 = "pending"; }, /OLDER_INSTALLER_HASH_INVALID/],
    [(record) => { record.evidence.updateVerification.signedUpdate.downloadedUpdateSha256 = "C:\\private\\file"; }, /DOWNLOADED_UPDATE_HASH_INVALID/],
    [(record) => { record.evidence.updateVerification.signedUpdate.downloadedUpdateSha256 = "2".repeat(64); }, /DOWNLOADED_UPDATE_HASH_MISMATCH/],
    [(record) => { record.evidence.updateVerification.signedUpdate.installedExecutableSha256 = "bad"; }, /INSTALLED_EXECUTABLE_HASH_INVALID/],
    [(record) => { record.evidence.updateVerification.unsignedFixture.sha256 = "bad"; }, /UNSIGNED_FIXTURE_HASH_INVALID/],
    [(record) => { record.evidence.updateVerification.wrongPublisherFixture.sha256 = "bad"; }, /WRONG_PUBLISHER_FIXTURE_HASH_INVALID/],
    [(record) => { record.evidence.updateVerification.signedUpdate.outcome = "pending"; }, /SIGNED_UPDATE_NOT_ACCEPTED/],
    [(record) => { record.evidence.updateVerification.unsignedFixture.authenticode = "valid"; }, /UNSIGNED_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.unsignedFixture.outcome = "accepted"; }, /UNSIGNED_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.wrongPublisherFixture.authenticode = "not-signed"; }, /WRONG_PUBLISHER_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.wrongPublisherFixture.publisher = "match"; }, /WRONG_PUBLISHER_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.wrongPublisherFixture.timestamp = "invalid"; }, /WRONG_PUBLISHER_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.wrongPublisherFixture.outcome = "accepted"; }, /WRONG_PUBLISHER_FIXTURE_EVIDENCE_INVALID/],
    [(record) => { record.evidence.updateVerification.interruptedDownloadRecovery = "failed"; }, /INTERRUPTED_DOWNLOAD_RECOVERY_INCOMPLETE/],
  ];
  for (const [mutate, expected] of cases) {
    const record = acceptedRecord();
    mutate(record);
    assert.throws(() => assertBetaAcceptanceRecord(record, record.evidence.releases.newer.version), expected);
  }
});

test("beta acceptance requires exact valid matched signature evidence without certificate Subjects", () => {
  const cases = [
    [(record) => { record.evidence.releases.older.installerSignature.status = "invalid"; }, /OLDER_INSTALLER_SIGNATURE_INVALID/],
    [(record) => { record.evidence.releases.newer.installerSignature.publisher = "different"; }, /NEWER_INSTALLER_SIGNATURE_INVALID/],
    [(record) => { record.evidence.updateVerification.signedUpdate.downloadedSignature.timestamp = "missing"; }, /DOWNLOADED_UPDATE_SIGNATURE_INVALID/],
    [(record) => { record.evidence.updateVerification.signedUpdate.installedSignature.publisher = "Leandro Carvalho"; }, /INSTALLED_EXECUTABLE_SIGNATURE_INVALID/],
  ];
  for (const [mutate, expected] of cases) {
    const record = acceptedRecord();
    mutate(record);
    assert.throws(() => assertBetaAcceptanceRecord(record, record.evidence.releases.newer.version), expected);
  }
  const unknownSignatureKey = acceptedRecord();
  unknownSignatureKey.evidence.releases.older.installerSignature.subject = "private";
  assert.throws(
    () => assertBetaAcceptanceRecord(unknownSignatureKey, unknownSignatureKey.evidence.releases.newer.version),
    /OLDER_INSTALLER_SIGNATURE_KEYS_INVALID/,
  );
});

test("beta acceptance rejects every unknown key at every object level", () => {
  const cases = [
    ["record prompt", (record) => { record.prompt = "private"; }, /RECORD_KEYS_INVALID/],
    ["evidence private path", (record) => { record.evidence.privatePath = "C:/private"; }, /EVIDENCE_KEYS_INVALID/],
    ["releases arbitrary field", (record) => { record.evidence.releases.arbitrary = {}; }, /RELEASES_KEYS_INVALID/],
    ["older release arbitrary field", (record) => { record.evidence.releases.older.privatePath = "C:/private"; }, /OLDER_RELEASE_KEYS_INVALID/],
    ["newer release arbitrary field", (record) => { record.evidence.releases.newer.notes = "private"; }, /NEWER_RELEASE_KEYS_INVALID/],
    ["artifact arbitrary field", (record) => { record.evidence.releases.newer.artifacts.arbitrary = { nested: true }; }, /ARTIFACT_SET_INVALID/],
    ["update arbitrary field", (record) => { record.evidence.updateVerification.notes = "private"; }, /UPDATE_VERIFICATION_KEYS_INVALID/],
    ["signed update arbitrary field", (record) => { record.evidence.updateVerification.signedUpdate.path = "C:/private"; }, /SIGNED_UPDATE_KEYS_INVALID/],
    ["downloaded signature arbitrary field", (record) => { record.evidence.updateVerification.signedUpdate.downloadedSignature.subject = "private"; }, /DOWNLOADED_UPDATE_SIGNATURE_KEYS_INVALID/],
    ["unsigned fixture arbitrary field", (record) => { record.evidence.updateVerification.unsignedFixture.subject = "private"; }, /UNSIGNED_FIXTURE_KEYS_INVALID/],
    ["wrong publisher arbitrary field", (record) => { record.evidence.updateVerification.wrongPublisherFixture.subject = "private"; }, /WRONG_PUBLISHER_FIXTURE_KEYS_INVALID/],
    ["manual nested field", (record) => { record.evidence.manual.arbitrary = { nested: true }; }, /MANUAL_EVIDENCE_INVALID/],
  ];
  for (const [label, mutate, expected] of cases) {
    const record = acceptedRecord();
    mutate(record);
    assert.throws(() => assertBetaAcceptanceRecord(record, record.evidence.releases.newer.version), expected, label);
  }

  const missingEvidenceKey = acceptedRecord();
  delete missingEvidenceKey.evidence.releases;
  assert.throws(() => assertBetaAcceptanceRecord(missingEvidenceKey, "1.2.3-beta.4"), /EVIDENCE_KEYS_INVALID/);
});

test("beta acceptance file verification is bounded and returns a content hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pomegr-beta-acceptance-"));
  const filename = path.join(root, "record.json");
  const record = acceptedRecord();
  await writeFile(filename, `${JSON.stringify(record)}\n`, "utf8");
  const result = await verifyBetaAcceptanceFile(filename, record.evidence.releases.newer.version);
  assert.equal(result.version, record.evidence.releases.newer.version);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await writeFile(filename, "x".repeat(64 * 1024 + 1), "utf8");
  await assert.rejects(() => verifyBetaAcceptanceFile(filename, record.evidence.releases.newer.version), /RECORD_TOO_LARGE/);
});

test("beta acceptance template exposes only the exact operator fields", () => {
  const template = betaAcceptanceTemplate("2.0.0-beta.2");
  assert.equal(template.schemaVersion, 3);
  assert.equal(template.evidence.releases.newer.version, "2.0.0-beta.2");
  assert.equal(template.evidence.releases.older.version, "REPLACE_WITH_OLDER_BETA_VERSION");
  assert.deepEqual(Object.keys(template.evidence.releases.older.installerSignature).sort(), ["publisher", "status", "timestamp"]);
  assert.deepEqual(Object.keys(template.evidence.updateVerification).sort(), [
    "interruptedDownloadRecovery",
    "signedUpdate",
    "unsignedFixture",
    "wrongPublisherFixture",
  ]);
  assert.doesNotMatch(JSON.stringify(template), /privatePath|notes|publisherSubject|certificateSubject/);
});

test("desktop user, contributor, architecture, and release documentation stays explicit", async () => {
  const [readme, configuration, architecture, releases, checklist] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/CONFIGURATION.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_RELEASES.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_BETA_ACCEPTANCE.md", import.meta.url), "utf8"),
  ]);
  assert.match(readme, /Windows desktop app/);
  assert.match(readme, /download and run the installer/i);
  assert.match(readme, /portable beta/i);
  assert.match(readme, /LAN sharing is unavailable/);
  assert.match(configuration, /Windows x64 only/);
  assert.match(configuration, /dynamic `127\.0\.0\.1` ports/);
  assert.match(configuration, /Quiet for one hour.*temporary/i);
  assert.match(configuration, /only the fixed generic Pomegr title and body/);
  assert.doesNotMatch(configuration, /optional bounded session title/);
  assert.match(architecture, /monitor worker \(provider files, credentials, Git, normalization\)/);
  assert.match(architecture, /renderer receives normalized API state/);
  assert.match(architecture, /fixed generic Pomegr copy/);
  assert.doesNotMatch(architecture, /fixed copy may add only a bounded title/);
  for (const value of ["source.zip", "SHA256SUMS.txt", "TRADEMARKS.md", "desktop:security", "clean-VM"]) {
    assert.match(releases, new RegExp(value.replaceAll(".", "\\."), "i"));
  }
  const checklistGates = [...checklist.matchAll(/^- \[ \] `([a-zA-Z]+)`:/gm)].map((match) => match[1]);
  assert.deepEqual(checklistGates, BETA_ACCEPTANCE_MANUAL_GATES);
  for (const gate of ["signature", "persisted sessions", "sentinel session title", "A coding-agent session needs input", "restart", "signed beta", "Uninstall"]) {
    assert.match(checklist, new RegExp(gate, "i"));
  }
  for (const field of [
    "evidence.releases.older.version",
    "evidence.releases.older.installerSha256",
    "evidence.releases.newer.artifacts",
    "evidence.updateVerification.signedUpdate.downloadedUpdateSha256",
    "evidence.updateVerification.signedUpdate.installedExecutableSha256",
    "evidence.updateVerification.unsignedFixture.sha256",
    "evidence.updateVerification.wrongPublisherFixture.sha256",
    "evidence.updateVerification.interruptedDownloadRecovery",
  ]) {
    assert.match(checklist, new RegExp(field.replaceAll(".", "\\.")));
  }
});
