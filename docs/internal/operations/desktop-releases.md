# Pomegr desktop releases

> Scope: packaging, signing, publishing, and rolling back the Windows x64 desktop releases.
> Authority: operating procedure for maintainers. Users follow [Install Pomegr](../../public/get-started/install.md).
> Related code and checks: `desktop/packaging/`, `scripts/release-windows-local.mjs`, and `.github/workflows/release.yml`. [Desktop beta acceptance](desktop-beta-acceptance.md) owns the beta evidence gates, and [desktop clean-VM checklist](desktop-clean-vm.md) owns the reusable VM checks.

## Publish signed artifacts

Before releasing a new version, test if the new version works locally

```powershell
$env:POMEGR_DATA_DIR = "C:\Temp\pomegr-test-data"; npm run desktop:start
```

Bump the version from a clean checkout of whichever branch carries the release changes. The release command never changes the version:

```powershell
npm run version:bump -- X.Y.Z
```

It runs `npm version X.Y.Z --no-git-tag-version`, commits `package.json` and `package-lock.json` as `chore: bump version to X.Y.Z`, and pushes the checked-out branch. It creates no tag and dispatches nothing. Merge that branch as usual so the version commit reaches `main`.

With that commit on `main`, run the release command from a clean `main` at the same commit as `origin/main`:

```powershell
npm run release:windows -- --tag vX.Y.Z
```

Then confirm the workflow run and the published GitHub release succeeded.

Rules:

- Stable releases use `vX.Y.Z`. Beta releases use `vX.Y.Z-beta.N`, publish as a GitHub prerelease, and use the beta updater channel.
- The version bump is its own commit, made and pushed with `npm run version:bump` on the checked-out branch and merged to `main` before the release command, so `package.json` and `package-lock.json` change together; the release command never edits, commits, or pushes a version.
- Pushing a tag does not start the workflow. Only the dispatch does.
- Never move or reuse a published tag, rerun a published version, replace release assets, or publish locally built executables.

### What the release command does

`npm run release:windows` needs Git and an authenticated GitHub CLI on `PATH`. For a tag GitHub does not have yet, it:

1. Requires a clean checkout of `main` at the same commit as `origin/main`.
2. Requires `package.json` to already have version `X.Y.Z`. Otherwise it stops with `POMEGR_RELEASE_VERSION_NOT_BUMPED` and changes nothing.
3. Creates the annotated tag `vX.Y.Z` on that commit and pushes it.
4. Checks that the tag matches `package.json` and that the checkout, the local tag, and the GitHub tag all resolve to the same commit.
5. Dispatches `release.yml` with the tag and that commit SHA.

When GitHub already has the tag, the command skips steps 1 to 3 and never changes the tag. Run it from a clean checkout of that tag to dispatch a release point that was pushed but not yet dispatched.

The command never installs dependencies or builds. If a step fails, fix the cause and rerun the same command; it resumes from whatever is already in place.

Append `--check-only` to run only step 4, without changing the repository or dispatching.

### What the workflow does

The GitHub-hosted Windows runner checks out the tag and owns all validation:

1. Rejects a missing or mismatched `release_sha`.
2. Installs locked dependencies, then runs `npm run verify` and `npm run desktop:smoke:ci`.
3. Packages from that build, signs the installer and portable executable, and inspects the package privacy boundary.
4. Verifies each executable's Authenticode signature, complete publisher Subject, and trusted timestamp.
5. Generates the source archive and `SHA256SUMS.txt`, creates a draft release, checks the remote asset names against the allowlist, and publishes.

The manual alternative to the dispatch command is **GitHub → Actions → Windows release → Run workflow**, entering the tag and its full commit SHA.

## Release checklist

The workflow enforces the release gates, so a normal release needs no manual checklist beyond confirming that the run and the published release succeeded.

A published release contains the signed NSIS installer and its blockmap, the signed portable build, channel updater metadata, release notes, `SHA256SUMS.txt`, `Pomegr-X.Y.Z-source.zip`, and the `LICENSE`, `NOTICE`, `SOURCE.md`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md` documents. The source archive comes from `git archive` on the release tag and is the corresponding source offered with the binaries; GitHub's automatic source snapshots do not replace it.

Beta candidates that need recorded evidence also follow [desktop beta acceptance](desktop-beta-acceptance.md).

## Package locally

Local builds are for development and acceptance testing only. They are unsigned and must never be published.

```powershell
.\scripts\package-desktop-local.ps1
```

The helper stops this checkout's Pomegr processes, runs `npm ci`, packages into a clean `release/`, inspects the result, and restarts the development server if it was running. Earlier `release/` output moves to `.electron-builder-cache/local-package-backups/`. Use `-LeaveDevStopped` to keep development stopped or `-WhatIf` to preview.

The manual equivalent, after moving any existing `release/` aside:

```powershell
npm ci
npm run desktop:runtime
npm run desktop:package
npm run desktop:inspect
```

`npm run verify:release:local` is an optional preflight that runs the canonical verifier and CI smoke, then builds and inspects unsigned artifacts. It performs no signing or GitHub checks.

If `npm ci` reports `EPERM` or `EBUSY`, a process from this checkout still holds a file. Stop `npm run dev` and any local Pomegr window, then list what remains:

```powershell
$repo = (Resolve-Path .).Path
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in @("node.exe", "electron.exe") -and $_.CommandLine -like "*$repo*" } |
  Select-Object ProcessId, Name, CommandLine
```

Stop only the listed process IDs with `Stop-Process -Id <id> -Force`. Never stop every `node.exe`.

## Signing configuration

Signing uses Azure Artifact Signing through GitHub OpenID Connect (OIDC). The certificate and private key stay in Microsoft's managed service; GitHub stores no certificate, password, or client secret. Never create an `AZURE_CLIENT_SECRET` for this workflow.

Setup:

- A GitHub environment named `release`.
- A Microsoft Entra application with a federated credential for that environment.
- The `Artifact Signing Certificate Profile Signer` role for that application on the signing account. Do not assign Owner or Contributor.

The `release` environment defines these non-secret variables:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of the Entra application |
| `AZURE_TENANT_ID` | Directory (tenant) ID of that application |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the signing account |
| `ARTIFACT_SIGNING_ENDPOINT` | Regional endpoint, such as `https://eus.codesigning.azure.net/` |
| `ARTIFACT_SIGNING_ACCOUNT_NAME` | Artifact Signing account name |
| `ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME` | Public Trust certificate profile name |
| `WINDOWS_PUBLISHER_SUBJECT` | The certificate's complete Subject distinguished name, copied exactly from the issued certificate |

`WINDOWS_PUBLISHER_SUBJECT` must be the full DN in certificate order, such as `CN=Example Organization Inc, O=Example Organization Inc, L=Toronto, S=Ontario, C=CA`. A CN-only value is rejected. The same Subject is written into the updater metadata, and Pomegr compares it with the signer of every downloaded installer before accepting an update.

The workflow fails if a variable is absent, the endpoint is malformed, Azure authentication or signing fails, or any executable has an invalid signature, a different Subject, or no trusted timestamp. Rotate a compromised federation or Entra application authorization immediately.

## Beta update acceptance

Run this clean-VM exercise for the first beta produced by a new signing or updater configuration. It needs two consecutive beta versions and is not part of a routine release.

1. On a clean, fully patched Windows VM, download the older beta installer and verify its SHA-256, Authenticode signature, publisher, and timestamp. Install it without disabling SmartScreen.
2. Confirm the older beta stays usable offline and when the update endpoint fails.
3. Publish the newer beta, start the older one, and confirm it silently downloads only the newer beta-channel version without blocking the dashboard.
4. Confirm **Restart to update** appears only after verification, then activate it and confirm Pomegr installs the update, restarts, and reports the newer version.
5. Verify the installed executable's signature again, and confirm an interrupted download or verification leaves the old installation intact.
6. Repeat with an unsigned package and a package signed by a different publisher. Both must be rejected while the installation stays usable. Never publish these fixtures.
7. Inspect the workflow log and artifacts for credentials, query-bearing signed URLs, certificate bytes, private paths, and transcript content.

Record the versions, VM image, workflow run URLs, hashes, and outcomes in the [beta acceptance record](desktop-beta-acceptance.md). Before building the clean-VM upgrade fixture, update the pinned version pair in `desktop/packaging/build-acceptance-prior.mjs`.

### Real-file signature acceptance

Check candidates and negative fixtures with the production Authenticode verifier:

```powershell
$env:WINDOWS_PUBLISHER_SUBJECT = "CN=YOUR COMMON NAME, O=YOUR ORGANIZATION, L=YOUR CITY, S=YOUR STATE OR PROVINCE, C=YOUR COUNTRY"

npm run desktop:update:verify-signature -- --file .\Pomegr-Setup-X.Y.Z-beta.N-x64.exe --expect accepted
npm run desktop:update:verify-signature -- --file .\unsigned-negative-fixture.exe --expect rejected-unsigned
npm run desktop:update:verify-signature -- --file .\wrong-publisher-negative-fixture.exe --expect rejected-wrong-publisher

Remove-Item Env:WINDOWS_PUBLISHER_SUBJECT
```

`rejected-wrong-publisher` requires a valid timestamped signature with a different Subject, so an unsigned or corrupt file cannot satisfy it. Record only the reported SHA-256 and the fixed result words; never copy certificate Subjects or private paths into the record. Keep negative fixtures outside `release/` and delete them afterward.

## Failure and rollback

Published versions and tags are immutable. Fix a broken release with a new commit and a higher version: `X.Y.Z-beta.N+1` for a beta, `X.Y.(Z+1)` for a stable release. If exposure is dangerous, also mark the affected GitHub release unavailable. Never overwrite assets or reuse the version number.

If the workflow fails before publishing, leave the draft release unpublished or delete only that draft, correct the cause, and release from a new version tag.

An update check, download, or verification failure must leave the installed version runnable. Do not bypass signature checks, switch a stable installation to beta, or edit updater metadata to force a retry.

## Reference documentation

- [electron-builder documentation](https://www.electron.build/)
- [electron-builder automatic updates](https://www.electron.build/docs/features/auto-update/)
- [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
