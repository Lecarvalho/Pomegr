import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertCleanTaggedCheckout, prepareRelease } from "../desktop/prepare-release.mjs";
import {
  parseAcceptanceArguments,
  verifyUpdateSignatureAcceptance,
} from "../desktop/update-signature-acceptance.mjs";
import {
  RELEASE_LEGAL_FILES,
  POMEGR_WINDOWS_PUBLISHER,
  assertReleaseArtifactNames,
  assertReleaseTag,
  assertUpdateMetadata,
  parseReleaseVersion,
  releaseArtifactNames,
  renderChecksumManifest,
  updateMetadataName,
} from "../desktop/release-policy.mjs";

const ACCEPTANCE_PUBLISHER_SUBJECT = "CN=DSNK Technologie Inc, O=DSNK Technologie Inc, C=CA";

async function updateSignatureFixture(contents = "synthetic executable fixture") {
  const root = await mkdtemp(path.join(tmpdir(), "pomegr-update-acceptance-"));
  const filename = path.join(root, "PRIVATE_PATH_MUST_NOT_LEAK.exe");
  await writeFile(filename, contents, "utf8");
  return filename;
}

test("release versions keep stable and beta channels separate", () => {
  assert.deepEqual(parseReleaseVersion("1.2.3"), { version: "1.2.3", channel: "stable", prerelease: false });
  assert.deepEqual(parseReleaseVersion("1.2.3-beta.4"), { version: "1.2.3-beta.4", channel: "beta", prerelease: true });
  assert.equal(updateMetadataName("1.2.3"), "latest.yml");
  assert.equal(updateMetadataName("1.2.3-beta.4"), "beta.yml");
  assert.equal(assertReleaseTag({ tag: "v1.2.3-beta.4", version: "1.2.3-beta.4" }).channel, "beta");
  for (const value of ["1.2", "1.2.3-alpha.1", "01.2.3", "1.2.3-beta", "1.2.3-beta.01"]) {
    assert.throws(() => parseReleaseVersion(value), /DESKTOP_RELEASE_VERSION_INVALID/);
  }
  assert.throws(() => assertReleaseTag({ tag: "v1.2.4", version: "1.2.3" }), /TAG_VERSION_MISMATCH/);
});

test("release artifact policy requires source, notices, update payload, notes, and checksums", () => {
  const names = releaseArtifactNames("1.2.3-beta.4");
  assert.deepEqual(names, [
    "Pomegr-Setup-1.2.3-beta.4-x64.exe",
    "Pomegr-Setup-1.2.3-beta.4-x64.exe.blockmap",
    "Pomegr-Portable-1.2.3-beta.4-x64.exe",
    "beta.yml",
    "Pomegr-1.2.3-beta.4-source.zip",
    "RELEASE_NOTES.md",
    ...RELEASE_LEGAL_FILES,
    "SHA256SUMS.txt",
  ]);
  assert.deepEqual(assertReleaseArtifactNames(names, "1.2.3-beta.4"), { artifactCount: names.length });
  assert.throws(() => assertReleaseArtifactNames(names.slice(1), "1.2.3-beta.4"), /ARTIFACT_SET_INVALID/);
  assert.throws(() => assertReleaseArtifactNames([...names, "credentials.pem"], "1.2.3-beta.4"), /ARTIFACT_SET_INVALID/);
});

test("updater metadata is version-bound, complete, and contains no query-bearing URL", () => {
  const valid = [
    "version: 1.2.3-beta.4",
    "path: Pomegr-Setup-1.2.3-beta.4-x64.exe",
    "sha512: abcdef",
  ].join("\n");
  assert.equal(assertUpdateMetadata(valid, "1.2.3-beta.4"), true);
  assert.throws(() => assertUpdateMetadata(valid.replace("1.2.3-beta.4", "1.2.3-beta.5"), "1.2.3-beta.4"), /METADATA_VERSION_INVALID/);
  assert.throws(() => assertUpdateMetadata(`${valid}\nurl: https://example.test/file?token=private`, "1.2.3-beta.4"), /SECRET_URL_FORBIDDEN/);
});

test("checksum manifests are deterministic and reject unsafe input", () => {
  const first = "a".repeat(64);
  const second = "B".repeat(64);
  assert.equal(renderChecksumManifest([
    { name: "z.exe", sha256: second },
    { name: "a.zip", sha256: first },
  ]), `${first} *a.zip\n${second.toLowerCase()} *z.exe\n`);
  assert.throws(() => renderChecksumManifest([{ name: "../secret", sha256: first }]), /CHECKSUM_INVALID/);
  assert.throws(() => renderChecksumManifest([]), /CHECKSUMS_EMPTY/);
});

test("real-file acceptance verifies a private snapshot and distinguishes three exact outcomes", async () => {
  const filename = await updateSignatureFixture();
  let stagedPath;
  const accepted = await verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "accepted",
    verifier: async (publishers, observedPath) => {
      assert.deepEqual(publishers, [ACCEPTANCE_PUBLISHER_SUBJECT]);
      assert.notEqual(observedPath, filename);
      assert.equal(path.basename(observedPath), "update-fixture.exe");
      stagedPath = observedPath;
      return null;
    },
    inspectSignature: async (observedPath) => {
      assert.notEqual(observedPath, filename);
      return { status: "Valid", subject: ACCEPTANCE_PUBLISHER_SUBJECT, timestamped: true };
    },
  });
  assert.equal(accepted.result, "accepted");
  assert.match(accepted.sha256, /^[a-f0-9]{64}$/);
  assert.ok(stagedPath);

  const unsigned = await verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "rejected-unsigned",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_INVALID",
    inspectSignature: async () => ({ status: "NotSigned", subject: "", timestamped: false }),
  });
  assert.deepEqual(unsigned, { result: "rejected-unsigned", sha256: accepted.sha256 });

  const wrongPublisher = await verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "rejected-wrong-publisher",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_INVALID",
    inspectSignature: async () => ({
      status: "Valid",
      subject: "CN=Different Publisher, O=Different Organization, C=CA",
      timestamped: true,
    }),
  });
  assert.deepEqual(wrongPublisher, { result: "rejected-wrong-publisher", sha256: accepted.sha256 });
});

test("wrong-publisher evidence cannot be satisfied by another unsigned or invalid file", async () => {
  const filename = await updateSignatureFixture();
  await assert.rejects(() => verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "rejected-wrong-publisher",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_INVALID",
    inspectSignature: async () => ({ status: "NotSigned", subject: "", timestamped: false }),
  }), /RESULT_MISMATCH/);
  await assert.rejects(() => verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "rejected-wrong-publisher",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_INVALID",
    inspectSignature: async () => ({
      status: "HashMismatch",
      subject: "CN=Different Publisher, O=Different Organization, C=CA",
      timestamped: true,
    }),
  }), /VERIFICATION_FAILED/);
});

test("real-file acceptance fails closed on verifier errors, result mismatch, and source mutation", async () => {
  const filename = await updateSignatureFixture();
  await assert.rejects(() => verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "rejected-unsigned",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_CHECK_FAILED",
    inspectSignature: async () => ({ status: "NotSigned", subject: "", timestamped: false }),
  }), /VERIFICATION_FAILED/);
  await assert.rejects(() => verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "accepted",
    verifier: async () => "DESKTOP_UPDATE_SIGNATURE_INVALID",
    inspectSignature: async () => ({ status: "NotSigned", subject: "", timestamped: false }),
  }), /RESULT_MISMATCH/);
  await assert.rejects(() => verifyUpdateSignatureAcceptance({
    filename,
    publisherSubject: ACCEPTANCE_PUBLISHER_SUBJECT,
    expected: "accepted",
    verifier: async () => {
      await writeFile(filename, "changed executable fixture", "utf8");
      return null;
    },
    inspectSignature: async () => ({ status: "Valid", subject: ACCEPTANCE_PUBLISHER_SUBJECT, timestamped: true }),
  }), /FILE_CHANGED/);
});

test("signature acceptance CLI parser rejects missing, unknown, and duplicate options", () => {
  assert.deepEqual(parseAcceptanceArguments(["--file", "candidate.exe", "--expect", "accepted"]), {
    filename: "candidate.exe",
    expected: "accepted",
  });
  for (const args of [
    ["--file", "candidate.exe"],
    ["--file", "a.exe", "--file", "b.exe"],
    ["--expect", "accepted", "--expect", "accepted"],
    ["--file", "candidate.exe", "--unknown", "accepted"],
  ]) {
    assert.throws(() => parseAcceptanceArguments(args), /ARGUMENTS_INVALID/);
  }
});

test("release preparation requires a clean exact tag and emits a closed checksummed set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pomegr-release-"));
  const inputRoot = path.join(root, "release");
  const version = "1.2.3-beta.4";
  const legal = Object.fromEntries(RELEASE_LEGAL_FILES.map((name) => [name, `${name} fixture\n`]));
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ version }), "utf8"),
    writeFile(path.join(root, ".gitignore"), "/release/\n", "utf8"),
    ...Object.entries(legal).map(([name, contents]) => writeFile(path.join(root, name), contents, "utf8")),
  ]);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Pomegr Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "release fixture"], { cwd: root });
  execFileSync("git", ["tag", `v${version}`], { cwd: root });
  assert.match(assertCleanTaggedCheckout(root, `v${version}`), /^[a-f0-9]{40}$/);

  await mkdir(inputRoot);
  const installer = `Pomegr-Setup-${version}-x64.exe`;
  await Promise.all([
    writeFile(path.join(inputRoot, installer), "signed installer fixture", "utf8"),
    writeFile(path.join(inputRoot, `${installer}.blockmap`), "blockmap fixture", "utf8"),
    writeFile(path.join(inputRoot, `Pomegr-Portable-${version}-x64.exe`), "signed portable fixture", "utf8"),
    writeFile(path.join(inputRoot, "beta.yml"), `version: ${version}\npath: ${installer}\nsha512: fixture\n`, "utf8"),
    writeFile(path.join(inputRoot, "RELEASE_NOTES.md"), "Fixture release notes\n", "utf8"),
  ]);
  const result = await prepareRelease({ repositoryRoot: root, inputRoot, outputRoot: path.join(inputRoot, "publish"), tag: `v${version}`, artifactExtractorPath: false });
  assert.deepEqual(result, { version, artifactCount: releaseArtifactNames(version).length });
  assert.deepEqual((await readdir(path.join(inputRoot, "publish"))).sort(), [...releaseArtifactNames(version)].sort());
  const checksums = await readFile(path.join(inputRoot, "publish", "SHA256SUMS.txt"), "utf8");
  for (const name of releaseArtifactNames(version, { includeChecksums: false })) assert.match(checksums, new RegExp(`\\*${name.replaceAll(".", "\\.")}`));

  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.4" }), "utf8");
  assert.throws(() => assertCleanTaggedCheckout(root, `v${version}`), /CHECKOUT_DIRTY/);
});

test("release workflow fails closed around signing, drafts, and exact-source publication", async () => {
  const [workflow, releaseBuilderConfig, signatureVerifier, preparer, documentation] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../desktop/electron-builder.release.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/verify-signature.ps1", import.meta.url), "utf8"),
    readFile(new URL("../desktop/prepare-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_RELEASES.md", import.meta.url), "utf8"),
  ]);
  assert.equal(POMEGR_WINDOWS_PUBLISHER, "DSNK Technologie Inc");
  assert.match(workflow, /runs-on: windows-2022/);
  assert.doesNotMatch(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /uses: azure\/login@v2/);
  for (const name of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) {
    assert.match(workflow, new RegExp(`vars\\.${name}`));
  }
  for (const name of ["ARTIFACT_SIGNING_ENDPOINT", "ARTIFACT_SIGNING_ACCOUNT_NAME", "ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME"]) {
    assert.match(workflow, new RegExp(`vars\\.${name}`));
    assert.match(releaseBuilderConfig, new RegExp(`requiredEnvironment\\("${name}"\\)`));
  }
  assert.doesNotMatch(workflow, /WINDOWS_CODESIGN_CERTIFICATE|WINDOWS_CODESIGN_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD/);
  assert.doesNotMatch(workflow, /AZURE_CLIENT_SECRET/);
  assert.match(workflow, /WINDOWS_PUBLISHER_SUBJECT:\s*\$\{\{ vars\.WINDOWS_PUBLISHER_SUBJECT \}\}/);
  assert.match(workflow, /DESKTOP_RELEASE_PUBLISHER_SUBJECT_INCOMPLETE/);
  assert.match(releaseBuilderConfig, /forceCodeSigning: true/);
  assert.match(releaseBuilderConfig, /signtoolOptions: null/);
  assert.match(releaseBuilderConfig, /azureSignOptions:/);
  assert.match(releaseBuilderConfig, /timestampRfc3161: "http:\/\/timestamp\.acs\.microsoft\.com"/);
  const qualityStep = workflow.match(/- name: Run canonical verifier and desktop extension[\s\S]*?(?=\n\s+- name:)/)?.[0] || "";
  for (const command of ["npm run verify", "npm run verify:desktop:ci"]) {
    assert.match(qualityStep, new RegExp(command.replaceAll(".", "\\.")));
  }
  assert.match(workflow, /verify-signature\.ps1/);
  assert.match(workflow, /gh release create[^\n]+--draft/);
  assert.match(workflow, /verify-assets/);
  assert.match(workflow, /gh release edit[^\n]+--draft=false/);
  const buildStep = workflow.match(/- name: Build and sign Windows artifacts[\s\S]*?(?=\n\s+- name:)/)?.[0] || "";
  assert.doesNotMatch(buildStep, /GH_TOKEN|GITHUB_TOKEN/);
  assert.match(buildStep, /WINDOWS_PUBLISHER_SUBJECT:\s*\$\{\{ vars\.WINDOWS_PUBLISHER_SUBJECT \}\}/);
  assert.match(buildStep, /npm run desktop:prepare(?:\r?\n|$)/);
  assert.doesNotMatch(buildStep, /desktop:prepare:from-build/);
  assert.match(buildStep, /electron-builder --config desktop\/electron-builder\.release\.cjs/);
  for (const stepName of ["Generate release notes", "Create draft release", "Verify draft assets and publish"]) {
    const step = workflow.match(new RegExp(`- name: ${stepName}[\\s\\S]*?(?=\\n\\s+- name:|$)`))?.[0] || "";
    assert.match(step, /if: github\.event_name == 'push'/);
    assert.match(step, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  }
  const sourceStep = workflow.match(/- name: Prepare exact source, notices, and checksums[\s\S]*?(?=\n\s+- name:)/)?.[0] || "";
  assert.match(sourceStep, /if: github\.event_name == 'push'/);
  assert.match(sourceStep, /git restore --worktree -- \.[\s\S]*node desktop\/prepare-release\.mjs --tag/);
  assert.match(signatureVerifier, /SignatureStatus\]::Valid/);
  assert.match(signatureVerifier, /SignerCertificate\.Subject -cne \$ExpectedSubject/);
  assert.doesNotMatch(signatureVerifier, /GetNameInfo|SimpleName/);
  assert.match(signatureVerifier, /WINDOWS_PUBLISHER_SUBJECT/);
  assert.match(signatureVerifier, /\^CN=\.\+,\\s\*\[A-Z\]/);
  assert.match(signatureVerifier, /TimeStamperCertificate/);
  assert.match(preparer, /git", \["archive"/);
  assert.match(preparer, /--prefix=pomegr-/);
  assert.match(documentation, /higher beta/);
  assert.match(documentation, /never overwrite assets or reuse the broken version number/i);
  assert.match(documentation, /clean Windows VM/i);
  assert.match(documentation, /unsigned test package/);
  assert.match(documentation, /complete canonical Subject distinguished name/i);
  assert.match(documentation, /CN-only value is rejected/i);
  assert.match(documentation, /immutable organization and repository IDs/i);
  assert.match(documentation, /stores no certificate file, certificate password, Azure client secret/i);
  assert.match(documentation, /manual run[\s\S]*skips[\s\S]*GitHub release publication/i);
  assert.match(documentation, /current installation remains usable/i);
});

test("local desktop packaging helper validates repository processes before replacing dependencies", async () => {
  const [helper, documentation] = await Promise.all([
    readFile(new URL("../scripts/package-desktop-local.ps1", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_RELEASES.md", import.meta.url), "utf8"),
  ]);

  assert.match(helper, /\[CmdletBinding\(SupportsShouldProcess\)\]/);
  assert.match(helper, /Resolve-Path \(Join-Path \$PSScriptRoot '\.\.'\)/);
  assert.match(helper, /Get-Command npm\.cmd -CommandType Application \| Select-Object -First 1 -ExpandProperty Source/);
  assert.match(helper, /Get-Command node\.exe -CommandType Application \| Select-Object -First 1 -ExpandProperty Source/);
  assert.match(helper, /Test-ExactCommandArgument/);
  assert.match(helper, /Test-ExactExecutablePath/);
  assert.match(helper, /Pomegr-Portable-\$packageVersion-x64\.exe/);
  assert.match(helper, /win-unpacked\\Pomegr\.exe/);
  assert.match(helper, /Get-DescendantTargets/);
  assert.match(helper, /Sort-Object Depth -Descending/);
  assert.match(helper, /Stop-Process -Id \(\[int\]\$target\.Id\)/);
  assert.doesNotMatch(helper, /Stop-Process\s+-Name|taskkill(?:\.exe)?\s+\/IM|Get-Process\s+(?:-Name\s+)?node/i);

  const installIndex = helper.indexOf("Invoke-Npm -Arguments @('ci')");
  const electronIndex = helper.indexOf("    Install-ElectronRuntime");
  const archiveIndex = helper.indexOf("  Archive-ExistingReleaseOutput");
  const packageIndex = helper.indexOf("Invoke-Npm -Arguments @('run', 'desktop:package')");
  const inspectIndex = helper.indexOf("Invoke-Npm -Arguments @('run', 'desktop:inspect')");
  assert.ok(installIndex >= 0 && electronIndex > installIndex && archiveIndex > electronIndex && packageIndex > archiveIndex && inspectIndex > packageIndex);
  assert.match(helper, /node_modules\\electron\\install\.js/);
  assert.match(helper, /node_modules\\electron\\dist\\electron\.exe/);
  assert.match(helper, /POMEGR_LOCAL_DESKTOP_PACKAGE_ELECTRON_RUNTIME_MISSING/);
  assert.match(helper, /POMEGR_LOCAL_DESKTOP_PACKAGE_INSPECTION_FAILED/);
  assert.match(helper, /\.electron-builder-cache\\local-package-backups/);
  assert.match(helper, /\[System\.IO\.Directory\]::Move\(\$releaseRoot, \$backupPath\)/);
  assert.match(helper, /if \(\$attempt -ge 5\)/);
  assert.doesNotMatch(helper, /(?:Move-Item|Remove-Item)[^\n]*\$releaseRoot/);
  assert.match(helper, /\$devWasRunning -and -not \$LeaveDevStopped/);
  assert.match(documentation, /\.\\scripts\\package-desktop-local\.ps1/);
  assert.match(documentation, /npm run desktop:runtime/);
  assert.match(documentation, /npm run desktop:inspect/);
  assert.match(documentation, /local-package-backups/);
  assert.match(documentation, /-LeaveDevStopped/);
  assert.match(documentation, /-WhatIf/);
});
