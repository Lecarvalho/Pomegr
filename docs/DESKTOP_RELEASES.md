# Pomegr desktop releases

## Download the desktop app

Pomegr desktop is available now for Windows x64. The
[latest stable release](https://github.com/Lecarvalho/Pomegr/releases/latest)
includes `Pomegr-Setup-<version>-x64.exe` and `Pomegr-Portable-<version>-x64.exe`.
Use the release page for downloads and checksums; the procedures below describe
how maintainers package and publish future releases.

Official Pomegr Windows releases are built only by a manually dispatched GitHub Actions workflow from a clean checkout of an existing tagged commit. Creating or pushing a tag does not start packaging or publication. A release tag and `package.json` must match exactly: stable releases use `vX.Y.Z`, while beta releases use `vX.Y.Z-beta.N`. A beta is published as a GitHub prerelease and uses the beta updater channel; a stable version is published as the latest non-prerelease and uses the stable channel. Never move or reuse a published version tag.

## Package and publish

To build the Windows installer and portable executable locally for development or testing, run the fail-closed helper from PowerShell at the repository root:

```powershell
.\scripts\package-desktop-local.ps1
```

The helper stops only validated Pomegr development, local Electron, and current-checkout portable or unpacked desktop processes, installs the locked dependencies with `npm ci`, downloads and verifies the Electron runtime, archives any existing `release/` directory, runs `npm run desktop:package` into a clean output directory, inspects the packaged runtime and privacy boundary with `npm run desktop:inspect`, and restores the development server in a detached PowerShell terminal when it was running beforehand. Previous release output—including portable `PomegrData` and legacy artifacts—is preserved beneath the ignored `.electron-builder-cache/local-package-backups/` directory rather than deleted. Use `-LeaveDevStopped` to leave development stopped, or `-WhatIf` to preview every state-changing step. The equivalent manual build commands are:

```powershell
npm ci
npm run desktop:runtime
npm run desktop:package
npm run desktop:inspect
```

The command prepares the desktop runtime, builds the web application, and creates the NSIS installer and portable executable under `release/`. These local artifacts are for development and acceptance testing only; do not publish them or manually substitute them for artifacts produced and signed by the manually dispatched release workflow.

Before running the manual commands, move any existing `release/` directory aside. The finalizer intentionally rejects stale artifacts and portable data so only the current allowlisted output can remain in the release directory.

### Refresh dependencies on Windows

The helper handles the usual repository-owned lock holders automatically. Use this manual fallback if npm still reports `EPERM` while unlinking a native `.node` file or `EBUSY` while removing a package directory:

1. In the terminal running `npm run dev` or `npm run desktop:start`, press `Ctrl+C` and wait for the PowerShell prompt to return. Close any locally launched Pomegr Electron window as well.
2. From the repository root, verify that no repository-owned Node or Electron processes remain:

   ```powershell
   $repo = (Resolve-Path .).Path
   Get-CimInstance Win32_Process |
     Where-Object {
       $_.Name -in @("node.exe", "electron.exe") -and
       $_.CommandLine -like "*$repo*"
     } |
     Select-Object ProcessId, ParentProcessId, Name, CommandLine
   ```

3. If the command still lists a process, confirm that its command line belongs to this Pomegr checkout, then stop only the listed process ID. Repeat the inspection until it returns no rows:

   ```powershell
   $verifiedProcessId = 12345 # Replace with the verified ProcessId from the inspection above.
   Stop-Process -Id $verifiedProcessId -Force
   ```

   Never stop every `node.exe` process; other development tools and applications may also use Node.js.
4. Run `npm ci` again. Administrator privileges are not normally required when the checkout belongs to the current user.
5. Run `npm run desktop:runtime` to populate Electron's on-demand `dist` runtime, then continue with `npm run desktop:package` or restart development with `npm run dev`.

### Publish signed artifacts

The canonical desktop application version is the root [`package.json`](../package.json) `version` field. `package-lock.json` mirrors that value and must remain synchronized. Do not edit the sidebar, installer filenames, updater metadata, or `package-lock.json` by hand to set a release version.

The manual GitHub Actions workflow packages an existing tag. It does not choose a version, commit changes, create a tag, or move a tag. Use this sequence for every stable or beta release:

1. Finish and merge every product change intended for the release. Confirm that no pending branch or pull request must be included.
2. Update local `main`, create a release-preparation branch, and choose the next immutable stable (`X.Y.Z`) or beta (`X.Y.Z-beta.N`) version.
3. From the repository root, set the version without creating a tag:

   ```powershell
   npm version X.Y.Z --no-git-tag-version
   ```

   Substitute the chosen version. This updates both `package.json` and `package-lock.json`. Then replace the previous candidate version in `desktop/build-acceptance-prior.mjs`, `docs/DESKTOP_CLEAN_VM_CHECKLIST.md`, and the clean-VM fixture assertions in `tests/desktop-packaging.test.mjs`. These release-specific safeguards intentionally fail CI when only the package files were bumped.
4. Run the applicable pre-release quality gates from the [release checklist](#release-checklist). Commit the complete release-preparation change, open a pull request, and merge it into `main`. Do not create the release tag on the feature branch because the pull-request merge produces the commit that must be released.
5. Update local `main` after the merge and verify the canonical version and clean release point:

   ```powershell
   git switch main
   git pull --ff-only origin main
   node -p "require('./package.json').version"
   git status --short
   ```

   The printed version must equal the intended release and the status output must be empty.
6. Create the matching annotated tag on that exact `main` commit, then push the tag:

   ```powershell
   git tag -a vX.Y.Z -m "Pomegr X.Y.Z"
   git push origin vX.Y.Z
   ```

   Use the matching beta form when applicable. A tag push does not start the release workflow or package any artifacts.
7. Confirm that GitHub can resolve the tag before opening Actions:

   ```powershell
   git ls-remote --exit-code --tags origin refs/tags/vX.Y.Z
   ```

   If this command returns no tag, do not run the workflow. Entering a nonexistent tag causes checkout to fail with `pathspec 'refs/tags/…' did not match any file(s) known to git`. If the tag exists but its `package.json` version differs, the release verification fails.
8. Run the local validation and dispatch command below. It starts the workflow only after local checks pass. The manual alternative is to first run the helper with `--check-only`, then open **GitHub → Actions → Windows release → Run workflow**: select the existing release tag as the workflow source, enter that same tag in **tag**, and copy the successful preflight's full commit SHA into **verified_sha**. The workflow checks out that immutable tag, checks the SHA, builds and smoke-tests the desktop runtime, signs and inspects the Windows artifacts, creates a draft GitHub release, verifies its exact assets, and publishes it.
9. Confirm the workflow and published release completed successfully, then finish the artifact and runtime checks in the release checklist. For beta releases, also complete and archive the evidence required by [the beta acceptance procedure](DESKTOP_BETA_ACCEPTANCE.md).

Do not publish locally built executables, rerun a published version, move a release tag, or manually replace release assets. Correct a failed or broken published release with a new commit and a higher version as described in [Failure and rollback](#failure-and-rollback).

### Validate locally before dispatch

From a clean Windows x64 checkout of the committed and pushed release tag, run:

```powershell
npm run release:windows -- --tag vX.Y.Z
```

Git and an authenticated GitHub CLI must be available on PATH. You can keep your
normal Node.js installation: when it differs from `.github/workflows/release.yml`
(currently 22.13.0), the helper downloads the official Windows x64 `node.exe` from
nodejs.org, verifies its published SHA-256 checksum, and relaunches with it. The runtime
is cached under the ignored `.electron-builder-cache/release-node/` directory and
checked again before reuse; a valid cache works offline. Your default Node.js and
system PATH remain unchanged. Child validation commands use the pinned runtime and
the npm CLI that launched the command. The standalone executable avoids the npm
`node` package's Git Bash placeholder problem on Windows.

Close this checkout's development server and local Electron app before running:
the command first checks the exact tagged source ZIP with the release privacy rules,
including extracted documentation and fixtures, using Windows' built-in `tar.exe`.
This standalone check is also available as
`npm run check:release-source -- --tag vX.Y.Z`. It then reinstalls locked root and
landing dependencies and runs
`npm run desktop:runtime`, `npm run verify`, and `npm run verify:desktop:ci`
in sequence, stopping at the first failure. The full verifier includes lint,
type checks, builds, generated-artifact checks, root tests, and landing tests/build.
The desktop extension exercises the packaged runtime and desktop security suite.

The command requires the tag to match `package.json` and both the local tag and
GitHub tag to resolve to the current clean commit. It checks these again after
validation, so edits, build-induced tracked changes, or a moved tag prevent dispatch.
It dispatches `release.yml` from the validated tag with the same tag and the verified
commit SHA as inputs. It never commits, pushes, creates tags, or moves them. Commit and push the
complete fix before tagging; an older tag will still run the older code.

Append `--check-only` to run the same checks without dispatching. Both modes require
a clean, already-pushed release tag. Use `npm run verify` while developing uncommitted
changes. Run this helper in the host terminal; Codex must use host permissions because
it invokes Git/GitHub and rebuilds generated plugin bundles.

The general application and landing suites run locally. CI installs only root
dependencies, builds once, checks generated artifacts, and runs
`npm run desktop:smoke:ci` before Azure authentication, signed packaging, artifact
inspection, signature verification, and publication. It does not reinstall or test
the landing site or repeat the general application and desktop-security suites.
Local success cannot guarantee those remote steps will pass. The full renderer
smoke (`npm run desktop:smoke`) and clean-VM acceptance remain separate release requirements.

CI rejects a missing, malformed, or mismatched `verified_sha` before dependency
installation or signing. This input is a trusted operator assertion that local
preflight passed, not cryptographic proof that tests ran. Prefer the local helper,
which supplies it only after every gate and the final clean-tag check succeed.
Both normal and `--check-only` runs print the verified SHA.

CI packaging uses `npm run desktop:prepare:from-build` to reuse the production
web output already built and smoke-tested in CI. `npm run build` generates legal
notices before copying public assets, including on a fresh Windows checkout with
CRLF line endings. Preparation checks the built legal copies byte-for-byte before
signing and regenerates only desktop service bundles. It does not regenerate legal
files or run a second web build. A stale build fails with
`DESKTOP_BUILD_LEGAL_CONTENT_MISMATCH`; rebuild before packaging.

## Release checklist

- [ ] The exact tag matches `package.json`, is immutable, and points at the clean checkout used by CI.
- [ ] `npm test`, `npm run lint`, `npm run desktop:smoke`, `npm run desktop:security`, and `npm run desktop:inspect` pass.
- [ ] Both executables have valid Authenticode signatures, the exact complete publisher Subject, and trusted timestamps.
- [ ] `SHA256SUMS.txt` matches every published artifact and update metadata names/version/checksum are internally consistent.
- [ ] The exact tagged `Pomegr-X.Y.Z-source.zip` is published beside the binaries at no charge.
- [ ] `LICENSE`, `NOTICE`, `SOURCE.md`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md` are present, non-empty, and accessible from About.
- [ ] The remote release asset set exactly matches the allowlist; no diagnostics, unsigned fixtures, private paths, secrets, certificate material, or signing configuration are present.
- [ ] For beta, every clean-VM gate in `DESKTOP_BETA_ACCEPTANCE.md` passes and `npm run desktop:beta:verify -- --version X.Y.Z-beta.N` verifies the archived evidence record.
- [ ] Download, first launch, provider discovery, notification transition/clear, preference restart, signed update, clean shutdown, uninstall data preservation, and portable isolation are recorded as pass.

## Signing configuration

Pomegr release signing uses Azure Artifact Signing with GitHub OpenID Connect (OIDC). The certificate and private key remain in Microsoft's managed signing service; GitHub stores no certificate file, certificate password, Azure client secret, or long-lived signing credential.

Create a GitHub environment named `release`, then create a Microsoft Entra application and a GitHub Actions federated credential for the `release` environment. Use the immutable organization and repository IDs requested by the Azure portal and retain its generated subject identifier. Assign that application's service principal the `Artifact Signing Certificate Profile Signer` role on the Pomegr Artifact Signing account. Do not assign Owner or Contributor for signing.

The `release` environment must define these non-secret GitHub Actions variables:

- `AZURE_CLIENT_ID`: the Application (client) ID of the Microsoft Entra application trusted by the `release` environment.
- `AZURE_TENANT_ID`: the Directory (tenant) ID containing that application.
- `AZURE_SUBSCRIPTION_ID`: the subscription containing the Artifact Signing account.
- `ARTIFACT_SIGNING_ENDPOINT`: the endpoint matching the Artifact Signing account region, such as `https://eus.codesigning.azure.net/` for East US.
- `ARTIFACT_SIGNING_ACCOUNT_NAME`: the Artifact Signing account name.
- `ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`: the Public Trust certificate profile name.
- `WINDOWS_PUBLISHER_SUBJECT`: the certificate's complete canonical Subject distinguished name exactly as shown by the certificate profile preview and later reported by PowerShell, including `CN=` and every organization, locality, state, country, and other Subject component in the same order. Example structure: `CN=Example Organization Inc, O=Example Organization Inc, L=Toronto, S=Ontario, C=CA`. Copy the actual value from the issued certificate; do not use the example.

These IDs and resource names identify the federation and signing resources but do not authenticate by themselves. The Entra federated credential restricts token exchange to the immutable GitHub repository identity and its `release` environment. Never create or store an `AZURE_CLIENT_SECRET` for this workflow.

The release-only electron-builder configuration signs the unpacked application, NSIS installer, and portable executable through Azure and writes the same complete Subject DN into the updater metadata. Before accepting a downloaded installer, Pomegr independently requires one full DN and compares the valid Authenticode signer's Subject exactly (case-insensitively) with it; a CN-only value is rejected. CI applies the same complete Subject comparison to every executable and also requires a trusted timestamp. The workflow fails if its OIDC identifiers or Artifact Signing variables are absent, the endpoint is malformed, Azure authentication or signing fails, any executable has an invalid signature, the full Subject differs, or a trusted timestamp is absent. Rotate a compromised GitHub federation or Microsoft Entra application authorization immediately; the Artifact Signing certificate itself remains non-exportable and managed by Microsoft.

The workflow runs only through `workflow_dispatch`. Select **Run workflow** and provide an existing release tag and its successfully preflighted commit SHA only when the candidate is ready to package and publish. The manual run builds once, smoke-tests the desktop runtime, signs every Windows artifact, inspects the package privacy boundary, verifies the publisher and timestamp, generates the exact source and checksums, creates a draft release, verifies its remote asset set, and then publishes it. Tag creation and tag pushes never start this workflow.

## Release contents and integrity

The workflow first creates a draft release and publishes it only after the remote asset names match the fail-closed allowlist. Each release contains the signed NSIS installer, signed portable build, installer blockmap, channel-specific updater metadata, generated release notes, `SHA256SUMS.txt`, an exact tagged source archive, and the AGPL, notice, source-offer, third-party-license, and trademark documents. Update metadata containing a query-bearing URL is rejected so a signed or credential-bearing URL cannot become a durable release artifact.

Before publishing, compare `SHA256SUMS.txt` with fresh SHA-256 hashes and verify the Authenticode signature and publisher on both executables. After installation, repeat signature verification on the installed executable. GitHub's automatically generated source snapshots do not replace `Pomegr-X.Y.Z-source.zip`, which is produced with `git archive` from the exact release tag and is the corresponding source offered with the binaries at no charge.

## Beta update acceptance

Do not promote the first beta produced by a new signing or updater configuration until two monotonically increasing beta versions have passed this clean-VM exercise:

1. On a fully patched, clean Windows VM, download the older beta installer, its checksum manifest, and its source archive from the same release.
2. Verify the installer SHA-256, valid Authenticode signature, exact publisher, and trusted timestamp; install it without disabling SmartScreen or other security controls.
3. Confirm the older installed beta remains usable when offline and when the update endpoint fails.
4. Publish the newer beta, start the older beta, and confirm its background check silently downloads only the newer beta channel version without blocking the dashboard. If validating periodic discovery, keep the app running and confirm the next non-overlapping four-hour check finds the release.
5. Confirm the bottom-left **Restart to update** action appears only after verification. Activate it as the explicit confirmation, then confirm Pomegr shuts down its local services, installs the update, restarts, and reports the newer version.
6. Verify the downloaded installer and installed executable signatures and checksums again. Confirm the old installation was not damaged if download or verification was deliberately interrupted.
7. Repeat with an unsigned test package and a package signed by a different publisher; both must be rejected while the current installation remains usable. Never publish those negative fixtures.
8. Inspect the workflow log and downloaded artifacts for credential values, signed URLs with query strings, certificate bytes, private workstation paths, transcripts, prompts, responses, commands, and tool output.

Record the two versions, VM image/version, workflow run URLs, hashes, signature result, publisher, update outcome, interruption outcome, and negative-test outcome in the release acceptance record. These observations are required external evidence; unit tests and a successful packaging job are not substitutes.

### Real-file signature acceptance

Run every candidate through Pomegr's production Authenticode verifier. Set the expected complete publisher Subject only in the process environment; the command prints no path or certificate identity:

```powershell
$env:WINDOWS_PUBLISHER_SUBJECT = "CN=YOUR COMMON NAME, O=YOUR ORGANIZATION, L=YOUR CITY, S=YOUR STATE OR PROVINCE, C=YOUR COUNTRY"

npm run desktop:update:verify-signature -- --file .\Pomegr-Setup-X.Y.Z-beta.N-x64.exe --expect accepted
npm run desktop:update:verify-signature -- --file .\unsigned-negative-fixture.exe --expect rejected-unsigned
npm run desktop:update:verify-signature -- --file .\wrong-publisher-negative-fixture.exe --expect rejected-wrong-publisher

Remove-Item Env:WINDOWS_PUBLISHER_SUBJECT
```

Use the complete Subject copied from the issued certificate, not the example. `accepted` requires a valid timestamped Authenticode signature whose complete Subject matches. `rejected-unsigned` requires Windows to report `NotSigned`. `rejected-wrong-publisher` requires a valid timestamped signature with a different complete Subject, so an unsigned or corrupt second fixture cannot satisfy that gate. The command verifies a private snapshot and fails if the source changes during the run. A PowerShell failure, unreadable file, malformed publisher Subject, duplicate option, or unexpected result also fails closed. Record each command's reported SHA-256 and only the fixed signature/publisher/timestamp result words required by the beta evidence schema; do not copy certificate Subjects or private paths into the record. Keep negative fixtures outside `release/`, never upload them, and remove them after the acceptance run.

## Failure and rollback

An update check, download, or verification failure must leave the installed version runnable. Do not delete the working installation, bypass signature checks, switch a stable installation to beta, or manually replace updater metadata to force a retry.

Published version numbers and tags are immutable. If a beta is broken, stop promoting it and publish the fix as a higher beta such as `X.Y.Z-beta.N+1`. If a stable release is broken, publish a higher patch version such as `X.Y.(Z+1)`. If exposure is dangerous, mark the affected GitHub release unavailable and document the issue, but still use a higher fixed version; never overwrite assets or reuse the broken version number. Existing installations can then accept the higher correctly signed release through their own channel.

If a draft release fails validation, leave it unpublished while investigating or delete only that draft through the GitHub release UI. Rerun the workflow from a new immutable version tag after correcting the cause.
