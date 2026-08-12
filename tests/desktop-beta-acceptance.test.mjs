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

function acceptedRecord(version = "1.2.3-beta.4") {
  const template = betaAcceptanceTemplate(version);
  template.completedOn = "2026-08-12";
  template.evidence.windowsVersion = "Windows 11 24H2 build 26100";
  template.evidence.vmImage = "Clean Windows 11 x64 24H2";
  template.evidence.workflowRunUrl = "https://github.com/Lecarvalho/threadlight/actions/runs/123456";
  template.evidence.artifacts = Object.fromEntries(releaseArtifactNames(version).map((name, index) => [name, String(index + 1).padStart(64, "a").slice(-64)]));
  template.evidence.manual = Object.fromEntries(BETA_ACCEPTANCE_MANUAL_GATES.map((gate) => [gate, "pass"]));
  return template;
}

test("beta acceptance requires every clean-VM gate and exact release artifact evidence", () => {
  const record = acceptedRecord();
  assert.deepEqual(assertBetaAcceptanceRecord(record, record.version), { version: record.version, manualGateCount: 15 });
  for (const gate of BETA_ACCEPTANCE_MANUAL_GATES) {
    const incomplete = structuredClone(record);
    incomplete.evidence.manual[gate] = "pending";
    assert.throws(() => assertBetaAcceptanceRecord(incomplete, incomplete.version), new RegExp(`MANUAL_${gate.toUpperCase()}_INCOMPLETE`));
  }
  const extraArtifact = structuredClone(record);
  extraArtifact.evidence.artifacts["private.env"] = "a".repeat(64);
  assert.throws(() => assertBetaAcceptanceRecord(extraArtifact, extraArtifact.version), /ARTIFACT_SET_INVALID/);
});

test("beta acceptance rejects stable versions, unsafe external links, and absent Node-free evidence", () => {
  assert.throws(() => betaAcceptanceTemplate("1.2.3"), /BETA_VERSION_INVALID/);
  for (const [field, value] of [
    ["releaseUrl", "https://github.com/attacker/threadlight/releases/tag/v1.2.3-beta.4"],
    ["releaseUrl", "https://github.com/Lecarvalho/other/releases/tag/v1.2.3-beta.4"],
    ["releaseUrl", "https://github.com/Lecarvalho/threadlight/releases/tag/v1.2.3-beta.5"],
    ["workflowRunUrl", "https://github.com/attacker/threadlight/actions/runs/123456"],
    ["workflowRunUrl", "https://github.com/Lecarvalho/other/actions/runs/123456"],
    ["workflowRunUrl", "https://github.com/Lecarvalho/threadlight/actions/runs/123456?token=secret"],
    ["workflowRunUrl", "https://github.com/Lecarvalho/threadlight/actions/runs/not-a-run"],
  ]) {
    const unsafe = acceptedRecord();
    unsafe.evidence[field] = value;
    assert.throws(() => assertBetaAcceptanceRecord(unsafe, unsafe.version), /EVIDENCE_URL_INVALID/);
  }
  const withNode = acceptedRecord();
  withNode.evidence.systemNodeInstalled = true;
  assert.throws(() => assertBetaAcceptanceRecord(withNode, withNode.version), /SYSTEM_NODE_PRESENT/);
});

test("beta acceptance rejects every unknown record, evidence, artifact, and manual key", () => {
  const cases = [
    ["record prompt", (record) => { record.prompt = "private"; }, /RECORD_KEYS_INVALID/],
    ["evidence private path", (record) => { record.evidence.privatePath = "C:/private"; }, /EVIDENCE_KEYS_INVALID/],
    ["nested arbitrary evidence", (record) => { record.evidence.arbitrary = { nested: { prompt: "private" } }; }, /EVIDENCE_KEYS_INVALID/],
    ["artifact arbitrary field", (record) => { record.evidence.artifacts.arbitrary = { nested: true }; }, /ARTIFACT_SET_INVALID/],
    ["manual nested field", (record) => { record.evidence.manual.arbitrary = { nested: true }; }, /MANUAL_EVIDENCE_INVALID/],
  ];
  for (const [label, mutate, expected] of cases) {
    const record = acceptedRecord();
    mutate(record);
    assert.throws(() => assertBetaAcceptanceRecord(record, record.version), expected, label);
  }

  const missingEvidenceKey = acceptedRecord();
  delete missingEvidenceKey.evidence.workflowRunUrl;
  assert.throws(() => assertBetaAcceptanceRecord(missingEvidenceKey, missingEvidenceKey.version), /EVIDENCE_KEYS_INVALID/);
});

test("beta acceptance file verification is bounded and returns a content hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "threadlight-beta-acceptance-"));
  const filename = path.join(root, "record.json");
  const record = acceptedRecord();
  await writeFile(filename, `${JSON.stringify(record)}\n`, "utf8");
  const result = await verifyBetaAcceptanceFile(filename, record.version);
  assert.equal(result.version, record.version);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await writeFile(filename, "x".repeat(64 * 1024 + 1), "utf8");
  await assert.rejects(() => verifyBetaAcceptanceFile(filename, record.version), /RECORD_TOO_LARGE/);
});

test("desktop user, contributor, architecture, and release documentation stays explicit", async () => {
  const [readme, configuration, architecture, releases, checklist] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/CONFIGURATION.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_RELEASES.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_BETA_ACCEPTANCE.md", import.meta.url), "utf8"),
  ]);
  assert.match(readme, /Install the Windows desktop app/);
  assert.match(readme, /Contributor development/);
  assert.match(readme, /portable beta/i);
  assert.match(readme, /LAN sharing is unavailable/);
  assert.match(configuration, /Windows x64 only/);
  assert.match(configuration, /dynamic `127\.0\.0\.1` ports/);
  assert.match(configuration, /Quiet for one hour.*temporary/i);
  assert.match(configuration, /only the fixed generic Threadlight title and body/);
  assert.doesNotMatch(configuration, /optional bounded session title/);
  assert.match(architecture, /monitor worker \(provider files, credentials, Git, normalization\)/);
  assert.match(architecture, /renderer receives normalized API state/);
  assert.match(architecture, /fixed generic Threadlight copy/);
  assert.doesNotMatch(architecture, /fixed copy may add only a bounded title/);
  for (const value of ["source.zip", "SHA256SUMS.txt", "TRADEMARKS.md", "desktop:security", "clean-VM"]) {
    assert.match(releases, new RegExp(value.replaceAll(".", "\\."), "i"));
  }
  const checklistGates = [...checklist.matchAll(/^- \[ \] `([a-zA-Z]+)`:/gm)].map((match) => match[1]);
  assert.deepEqual(checklistGates, BETA_ACCEPTANCE_MANUAL_GATES);
  for (const gate of ["signature", "persisted sessions", "sentinel session title", "A coding-agent session needs input", "restart", "signed beta", "Uninstall"]) {
    assert.match(checklist, new RegExp(gate, "i"));
  }
});
