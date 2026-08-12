import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertCleanTaggedCheckout, prepareRelease } from "../desktop/prepare-release.mjs";
import {
  RELEASE_LEGAL_FILES,
  THREADLIGHT_WINDOWS_PUBLISHER,
  assertReleaseArtifactNames,
  assertReleaseTag,
  assertUpdateMetadata,
  parseReleaseVersion,
  releaseArtifactNames,
  renderChecksumManifest,
  updateMetadataName,
} from "../desktop/release-policy.mjs";

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
    "Threadlight-Setup-1.2.3-beta.4-x64.exe",
    "Threadlight-Setup-1.2.3-beta.4-x64.exe.blockmap",
    "Threadlight-Portable-1.2.3-beta.4-x64.exe",
    "beta.yml",
    "Threadlight-1.2.3-beta.4-source.zip",
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
    "path: Threadlight-Setup-1.2.3-beta.4-x64.exe",
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

test("release preparation requires a clean exact tag and emits a closed checksummed set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "threadlight-release-"));
  const inputRoot = path.join(root, "release");
  const version = "1.2.3-beta.4";
  const legal = Object.fromEntries(RELEASE_LEGAL_FILES.map((name) => [name, `${name} fixture\n`]));
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ version }), "utf8"),
    writeFile(path.join(root, ".gitignore"), "/release/\n", "utf8"),
    ...Object.entries(legal).map(([name, contents]) => writeFile(path.join(root, name), contents, "utf8")),
  ]);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Threadlight Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "release fixture"], { cwd: root });
  execFileSync("git", ["tag", `v${version}`], { cwd: root });
  assert.match(assertCleanTaggedCheckout(root, `v${version}`), /^[a-f0-9]{40}$/);

  await mkdir(inputRoot);
  const installer = `Threadlight-Setup-${version}-x64.exe`;
  await Promise.all([
    writeFile(path.join(inputRoot, installer), "signed installer fixture", "utf8"),
    writeFile(path.join(inputRoot, `${installer}.blockmap`), "blockmap fixture", "utf8"),
    writeFile(path.join(inputRoot, `Threadlight-Portable-${version}-x64.exe`), "signed portable fixture", "utf8"),
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
  const [workflow, signatureVerifier, preparer, documentation] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../desktop/verify-signature.ps1", import.meta.url), "utf8"),
    readFile(new URL("../desktop/prepare-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_RELEASES.md", import.meta.url), "utf8"),
  ]);
  assert.equal(THREADLIGHT_WINDOWS_PUBLISHER, "Leandro Carvalho");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /WINDOWS_CODESIGN_CERTIFICATE/);
  assert.match(workflow, /WINDOWS_CODESIGN_PASSWORD/);
  assert.match(workflow, /WINDOWS_PUBLISHER_SUBJECT:\s*\$\{\{ vars\.WINDOWS_PUBLISHER_SUBJECT \}\}/);
  assert.match(workflow, /DESKTOP_RELEASE_PUBLISHER_SUBJECT_INCOMPLETE/);
  assert.match(workflow, /forceCodeSigning=true/);
  assert.match(workflow, /verify-signature\.ps1/);
  assert.match(workflow, /gh release create[^\n]+--draft/);
  assert.match(workflow, /verify-assets/);
  assert.match(workflow, /gh release edit[^\n]+--draft=false/);
  const buildStep = workflow.match(/- name: Build and sign Windows artifacts[\s\S]*?(?=\n\s+- name:)/)?.[0] || "";
  assert.doesNotMatch(buildStep, /GH_TOKEN|GITHUB_TOKEN/);
  assert.match(buildStep, /WINDOWS_PUBLISHER_SUBJECT:\s*\$\{\{ vars\.WINDOWS_PUBLISHER_SUBJECT \}\}/);
  assert.match(buildStep, /win\.signtoolOptions\.publisherName=\$env:WINDOWS_PUBLISHER_SUBJECT/);
  for (const stepName of ["Generate release notes", "Create draft release", "Verify draft assets and publish"]) {
    const step = workflow.match(new RegExp(`- name: ${stepName}[\\s\\S]*?(?=\\n\\s+- name:|$)`))?.[0] || "";
    assert.match(step, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  }
  assert.match(signatureVerifier, /SignatureStatus\]::Valid/);
  assert.match(signatureVerifier, /SignerCertificate\.Subject -cne \$ExpectedSubject/);
  assert.doesNotMatch(signatureVerifier, /GetNameInfo|SimpleName/);
  assert.match(signatureVerifier, /WINDOWS_PUBLISHER_SUBJECT/);
  assert.match(signatureVerifier, /\^CN=\.\+,\\s\*\[A-Z\]/);
  assert.match(signatureVerifier, /TimeStamperCertificate/);
  assert.match(preparer, /git", \["archive"/);
  assert.match(preparer, /--prefix=threadlight-/);
  assert.match(documentation, /higher beta/);
  assert.match(documentation, /never overwrite assets or reuse the broken version number/i);
  assert.match(documentation, /clean Windows VM/i);
  assert.match(documentation, /unsigned test package/);
  assert.match(documentation, /complete canonical Subject distinguished name/i);
  assert.match(documentation, /CN-only value is rejected/i);
  assert.match(documentation, /current installation remains usable/i);
});
