# Threadlight desktop releases

Official Threadlight Windows releases are built only by the tag-triggered GitHub Actions workflow from a clean checkout of the tagged commit. A release tag and `package.json` must match exactly: stable releases use `vX.Y.Z`, while beta releases use `vX.Y.Z-beta.N`. A beta is published as a GitHub prerelease and uses the beta updater channel; a stable version is published as the latest non-prerelease and uses the stable channel. Never move or reuse a published version tag.

## Release checklist

- [ ] The exact tag matches `package.json`, is immutable, and points at the clean checkout used by CI.
- [ ] `npm test`, `npm run lint`, `npm run desktop:smoke`, `npm run desktop:security`, and `npm run desktop:inspect` pass.
- [ ] Both executables have valid Authenticode signatures, the exact complete publisher Subject, and trusted timestamps.
- [ ] `SHA256SUMS.txt` matches every published artifact and update metadata names/version/checksum are internally consistent.
- [ ] The exact tagged `Threadlight-X.Y.Z-source.zip` is published beside the binaries at no charge.
- [ ] `LICENSE`, `NOTICE`, `SOURCE.md`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md` are present, non-empty, and accessible from About.
- [ ] The remote release asset set exactly matches the allowlist; no diagnostics, unsigned fixtures, private paths, secrets, certificate material, or signing configuration are present.
- [ ] For beta, every clean-VM gate in `DESKTOP_BETA_ACCEPTANCE.md` passes and `npm run desktop:beta:verify -- --version X.Y.Z-beta.N` verifies the archived evidence record.
- [ ] Download, first launch, provider discovery, notification transition/clear, preference restart, signed update, clean shutdown, uninstall data preservation, and portable isolation are recorded as pass.

## Signing configuration

The repository release environment must define these GitHub Actions secrets:

- `WINDOWS_CODESIGN_CERTIFICATE`: the encrypted or base64-encoded Windows code-signing certificate accepted by electron-builder as `CSC_LINK`.
- `WINDOWS_CODESIGN_PASSWORD`: its password, passed to electron-builder as `CSC_KEY_PASSWORD`.

It must also define the non-secret GitHub Actions repository variable `WINDOWS_PUBLISHER_SUBJECT` as the certificate's complete canonical Subject distinguished name exactly as PowerShell reports it, including `CN=` and every organization, locality, state, country, and other Subject component in the same order. Example structure: `CN=Leandro Carvalho, O=Example Organization, L=Toronto, S=Ontario, C=CA`. Copy the actual value from the issued certificate; do not use the example.

The certificate's common name must be `Leandro Carvalho`. The checked-in package configuration uses that CN as a non-release development fallback, while the release workflow replaces the updater publisher value with `WINDOWS_PUBLISHER_SUBJECT`. The resulting installed `app-update.yml` therefore carries the complete Subject DN. Before accepting a downloaded installer, Threadlight independently requires one full DN and compares the valid Authenticode signer's Subject exactly (case-insensitively) with it; a CN-only value is rejected. CI applies the same complete Subject comparison to every executable and also requires a trusted timestamp. The workflow fails if either secret or the required Subject variable is absent, electron-builder cannot sign, any executable has an invalid signature, the full Subject differs, or a trusted timestamp is absent. Certificate material and passwords must never be stored in the repository, copied into artifacts, supplied on a command line, or printed while diagnosing a failed build. Rotate a compromised certificate and revoke it through the issuing certificate authority before attempting another release.

## Release contents and integrity

The workflow first creates a draft release and publishes it only after the remote asset names match the fail-closed allowlist. Each release contains the signed NSIS installer, signed portable build, installer blockmap, channel-specific updater metadata, generated release notes, `SHA256SUMS.txt`, an exact tagged source archive, and the AGPL, notice, source-offer, third-party-license, and trademark documents. Update metadata containing a query-bearing URL is rejected so a signed or credential-bearing URL cannot become a durable release artifact.

Before publishing, compare `SHA256SUMS.txt` with fresh SHA-256 hashes and verify the Authenticode signature and publisher on both executables. After installation, repeat signature verification on the installed executable. GitHub's automatically generated source snapshots do not replace `Threadlight-X.Y.Z-source.zip`, which is produced with `git archive` from the exact release tag and is the corresponding source offered with the binaries at no charge.

## Beta update acceptance

Do not promote the first beta produced by a new signing or updater configuration until two monotonically increasing beta versions have passed this clean-VM exercise:

1. On a fully patched, clean Windows VM, download the older beta installer, its checksum manifest, and its source archive from the same release.
2. Verify the installer SHA-256, valid Authenticode signature, exact publisher, and trusted timestamp; install it without disabling SmartScreen or other security controls.
3. Confirm the older installed beta remains usable when offline and when the update endpoint fails.
4. Publish the newer beta, start the older beta, and confirm its background check offers only the newer beta channel version without blocking the dashboard.
5. Accept the explicit restart/install confirmation. Confirm Threadlight shuts down its local services, installs the update, restarts, and reports the newer version.
6. Verify the downloaded installer and installed executable signatures and checksums again. Confirm the old installation was not damaged if download or verification was deliberately interrupted.
7. Repeat with an unsigned test package and a package signed by a different publisher; both must be rejected while the current installation remains usable. Never publish those negative fixtures.
8. Inspect the workflow log and downloaded artifacts for credential values, signed URLs with query strings, certificate bytes, private workstation paths, transcripts, prompts, responses, commands, and tool output.

Record the two versions, VM image/version, workflow run URLs, hashes, signature result, publisher, update outcome, interruption outcome, and negative-test outcome in the release acceptance record. These observations are required external evidence; unit tests and a successful packaging job are not substitutes.

### Real-file signature acceptance

Run every candidate through Threadlight's production Authenticode verifier. Set the expected complete publisher Subject only in the process environment; the command prints no path or certificate identity:

```powershell
$env:WINDOWS_PUBLISHER_SUBJECT = "CN=Leandro Carvalho, O=YOUR ACTUAL ORGANIZATION, C=YOUR COUNTRY"

npm run desktop:update:verify-signature -- --file .\Threadlight-Setup-X.Y.Z-beta.N-x64.exe --expect accepted
npm run desktop:update:verify-signature -- --file .\unsigned-negative-fixture.exe --expect rejected-unsigned
npm run desktop:update:verify-signature -- --file .\wrong-publisher-negative-fixture.exe --expect rejected-wrong-publisher

Remove-Item Env:WINDOWS_PUBLISHER_SUBJECT
```

Use the complete Subject copied from the issued certificate, not the example. `accepted` requires a valid timestamped Authenticode signature whose complete Subject matches. `rejected-unsigned` requires Windows to report `NotSigned`. `rejected-wrong-publisher` requires a valid timestamped signature with a different complete Subject, so an unsigned or corrupt second fixture cannot satisfy that gate. The command verifies a private snapshot and fails if the source changes during the run. A PowerShell failure, unreadable file, malformed publisher Subject, duplicate option, or unexpected result also fails closed. Record each command's reported SHA-256 and only the fixed signature/publisher/timestamp result words required by the beta evidence schema; do not copy certificate Subjects or private paths into the record. Keep negative fixtures outside `release/`, never upload them, and remove them after the acceptance run.

## Failure and rollback

An update check, download, or verification failure must leave the installed version runnable. Do not delete the working installation, bypass signature checks, switch a stable installation to beta, or manually replace updater metadata to force a retry.

Published version numbers and tags are immutable. If a beta is broken, stop promoting it and publish the fix as a higher beta such as `X.Y.Z-beta.N+1`. If a stable release is broken, publish a higher patch version such as `X.Y.(Z+1)`. If exposure is dangerous, mark the affected GitHub release unavailable and document the issue, but still use a higher fixed version; never overwrite assets or reuse the broken version number. Existing installations can then accept the higher correctly signed release through their own channel.

If a draft release fails validation, leave it unpublished while investigating or delete only that draft through the GitHub release UI. Rerun the workflow from a new immutable version tag after correcting the cause.
