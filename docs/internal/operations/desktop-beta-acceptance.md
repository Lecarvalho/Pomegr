# Windows desktop beta acceptance

> Scope: the optional acceptance procedure for a future Pomegr Windows x64 beta candidate, and the desktop milestone IDs.
> Authority: operating procedure (gates, evidence schema, retention). It carries no per-candidate result, and no acceptance is pending.
> Related code and checks: `desktop/packaging/beta-acceptance.mjs` (`npm run desktop:beta:init`, `npm run desktop:beta:verify`), [desktop releases](desktop-releases.md), and the [desktop clean-VM checklist](desktop-clean-vm.md).
>
> Pomegr desktop is [available for Windows x64](https://github.com/Lecarvalho/Pomegr/releases/latest).
> As of 2026-10-01, signed stable releases are published through v0.6.0 (see
> [GitHub releases](https://github.com/Lecarvalho/Pomegr/releases)), and no release step
> requires a beta acceptance record.

This is an optional checklist for a future Pomegr Windows x64 beta candidate, such as the first beta after a new signing or updater configuration (see [beta update acceptance](desktop-releases.md#beta-update-acceptance)). It is not part of a routine release, and nothing is pending against it. It complements the earlier unsigned alpha run kept under [Recorded acceptance runs](desktop-clean-vm.md#recorded-acceptance-runs); that alpha evidence does not prove signing or automatic updates. When you run it, complete it on a clean, fully patched Windows x64 VM using assets downloaded from the same draft or prerelease. Never replace a manual result with a unit-test result.

Record only product versions, public release/workflow URLs, public artifact names and checksums, the VM image/version, fixed accept/reject outcomes, and pass/fail states. Do not record usernames, provider paths, session titles, repositories, prompts, responses, commands, credentials, certificate Subjects, or screenshots containing private data. The acceptance JSON uses exact key allowlists at every level; it has no free-form notes or path fields.

## Automated gates before the VM run

From the exact clean tagged checkout, run:

```powershell
npm ci
npm run build
npm test
npm run desktop:smoke
npm run desktop:security
npm run desktop:inspect
npm run lint
```

The release workflow must also pass tag/version matching, fail-closed signing, exact publisher Subject and timestamp verification, closed artifact-set inspection, update metadata validation, exact tagged source generation, legal-notice inclusion, and SHA-256 manifest generation. Keep signing material only in the release environment.

## Clean-VM first-run and lifecycle gates

- [ ] `downloadArtifacts`: Download the installer, portable build, `SHA256SUMS.txt`, and corresponding source archive from the exact `github.com/Lecarvalho/pomegr` beta release recorded in the evidence file.
- [ ] `verifyChecksums`: Verify every downloaded artifact against `SHA256SUMS.txt` before launching anything.
- [ ] `verifyPublisherSignature`: Verify the installer's valid Authenticode signature, trusted timestamp, and complete expected publisher Subject without disabling SmartScreen or another security control.
- [ ] `standardUserInstall`: Install on supported Windows x64 as a standard user with no system Node.js and no repository checkout; confirm no administrator credentials or terminal are required.
- [ ] `firstLaunch`: Launch from the Start menu and confirm the dashboard becomes visible without opening a terminal.
- [ ] `providerDiscovery`: Confirm existing Claude Code and/or Codex persisted sessions appear and that absence of one provider does not hide the other.
- [ ] `needsInputNotification`: Create a synthetic needs-input transition carrying a sentinel session title. Confirm exactly one notification whose title is the sentinel session title on one line and whose body is `This live session is waiting for input.`, confirm no question, command, or other session field is present, click through to the matching observation view, then clear the transition and confirm a future transition can notify again.
- [ ] `preferenceRestart`: Change close behavior, launch-at-login, and notification preference; restart and confirm those bounded preferences persist while temporary one-hour quiet mode does not.
- [ ] `signedUpdate`: From an older signed beta, confirm a higher signed beta downloads silently on the beta channel, the bottom-left update action appears only when verification completes, and activating **Restart to update** opens the newer version.
- [ ] `updateFailureRecovery`: Repeat the interrupted-download, unsigned-package, and wrong-publisher cases in [desktop releases](desktop-releases.md#beta-update-acceptance); confirm every case is rejected and the installed version remains runnable.
- [ ] `cleanShutdown`: Quit and confirm every owned monitor, web, and Electron process stops.
- [ ] `uninstallDataBoundary`: Uninstall and confirm application files and shortcuts are removed while Pomegr user data, provider data, and unrelated user data remain untouched.
- [ ] `portableIsolation`: Launch the portable beta separately and confirm it uses `PomegrData` beside the executable, does not register launch at login, and does not offer automatic updates.
- [ ] `packagedLegal`: Confirm the packaged About page exposes the AGPL license, notice, source offer, dependency notices, and trademark policy.
- [ ] `artifactPrivacyInspection`: Inspect release assets and workflow logs and confirm they contain no secrets, certificate bytes, private paths, transcripts, prompts, responses, commands, tool output, unsigned fixtures, or local signing configuration.

## Machine-verifiable acceptance record

After every manual checkbox passes, create the ignored record and replace every placeholder with safe evidence:

```powershell
npm run desktop:beta:init -- --version X.Y.Z-beta.N
npm run desktop:beta:verify -- --version X.Y.Z-beta.N
```

The `--version` argument is the newer beta. The verifier fails unless both releases are betas on the same `X.Y.Z` base and the older beta ordinal is strictly lower than the newer beta ordinal. It also requires the exact newer release artifact allowlist, no system Node.js, exact versioned release URLs, numeric Actions run URLs under `github.com/Lecarvalho/pomegr`, all bounded SHA-256 fields, the fixed outcomes below, and all 15 named manual gates set to `pass`. Each manual evidence gate maps to the checklist item with the same name.

Replace every generated placeholder in these exact operator fields:

- `completedOn`: completion date as `YYYY-MM-DD`.
- `evidence.windowsVersion` and `evidence.vmImage`: bounded public OS/image labels; never a local path or username.
- `evidence.releases.older.version`, `.tag`, `.releaseUrl`, and `.workflowRunUrl`: the installed older signed beta and its public GitHub evidence.
- `evidence.releases.older.installerSha256`: SHA-256 of the older installer used to establish the upgrade starting point.
- `evidence.releases.older.installerSignature`: exactly `{ "status": "valid", "publisher": "match", "timestamp": "valid" }` after verifying the older installer; record no certificate Subject.
- `evidence.releases.newer.version`, `.tag`, `.releaseUrl`, and `.workflowRunUrl`: the offered newer signed beta and its public GitHub evidence. The generated version, tag, and release URL are already populated from `--version`.
- `evidence.releases.newer.artifacts`: SHA-256 for every exact release asset key generated by the template; do not add or remove keys.
- `evidence.releases.newer.installerSignature`: exactly `{ "status": "valid", "publisher": "match", "timestamp": "valid" }` after verifying the newer installer; record no certificate Subject.
- `evidence.updateVerification.signedUpdate.downloadedUpdateSha256`: SHA-256 of the update payload actually downloaded by the updater; it must equal the newer installer's entry in `evidence.releases.newer.artifacts`.
- `evidence.updateVerification.signedUpdate.downloadedSignature`: exactly `{ "status": "valid", "publisher": "match", "timestamp": "valid" }` for the downloaded payload.
- `evidence.updateVerification.signedUpdate.installedExecutableSha256`: SHA-256 of the executable installed after the update.
- `evidence.updateVerification.signedUpdate.installedSignature`: exactly `{ "status": "valid", "publisher": "match", "timestamp": "valid" }` for the installed executable.
- `evidence.updateVerification.signedUpdate.outcome`: exactly `accepted` after the correctly signed newer beta is accepted.
- `evidence.updateVerification.unsignedFixture.sha256`, `.authenticode`, and `.outcome`: the fixture SHA-256 plus exactly `"authenticode": "not-signed"` and `"outcome": "rejected-unsigned"`.
- `evidence.updateVerification.wrongPublisherFixture.sha256`, `.authenticode`, `.publisher`, `.timestamp`, and `.outcome`: the fixture SHA-256 plus exactly `"authenticode": "valid"`, `"publisher": "different"`, `"timestamp": "valid"`, and `"outcome": "rejected-wrong-publisher"`.
- `evidence.updateVerification.interruptedDownloadRecovery`: exactly `pass` after interruption leaves the installed older beta runnable.
- `evidence.manual`: exactly the 15 generated gate keys, each set to `pass` only after its matching checklist item succeeds.

Do not add filenames, local paths, certificate details, error text, notes, or screenshots to the JSON. `release-acceptance/` is intentionally ignored, so the record stays out of source control; [Evidence retention](#evidence-retention) names who keeps it and where. Verifier output includes a SHA-256 so the reviewed record can be identified later.

## Evidence retention

This page keeps the procedure, never a candidate's results. `npm run desktop:beta:init` writes the record to the ignored `release-acceptance/desktop-beta-X.Y.Z-beta.N.json`.

- **Owner:** the release maintainer who publishes the accepted release.
- **Store:** the GitHub release for the same tag. After `npm run desktop:beta:verify` passes, attach the verified record JSON, unchanged, as an additional asset named `desktop-beta-X.Y.Z-beta.N.json`, and put the SHA-256 the verifier prints in the release notes or beside the asset.
- **Safe to attach:** the record uses exact key allowlists and holds only public fields (versions, public URLs, artifact checksums, fixed outcomes), so it is safe to publish.
- **Timing:** attach the record after the release workflow has published the release. The workflow's "Verify draft assets and publish" step requires the draft's asset names to equal the closed set in `desktop/packaging/release-policy.mjs` and fails on any extra asset, so the record can never be a draft asset. Never replace or remove an existing asset. `SHA256SUMS.txt` does not list the record, and a later exact-set check of the live release would report it as extra.

The clean-VM runs recorded before this rule stay in [Recorded acceptance runs](desktop-clean-vm.md#recorded-acceptance-runs).

## Desktop milestone IDs

`POMEGR-DT-01` through `POMEGR-DT-10` were the task IDs of the desktop implementation plan (`docs/plans/desktop-app-implementation.md`), retired in the 2026-09-30 documentation migration after its current contracts moved to the pages below. Code and tests keep one stable identifier, the `POMEGR-DT-08-signed-updates` packaging scope. Git history retains the plan's task-by-task implementation notes.

| ID | Milestone | Status | Current owner |
| --- | --- | --- | --- |
| `POMEGR-DT-01` | Extract production runtime seams | Complete 2026-08-11 | [Desktop runtime compatibility boundary](../architecture/overview.md#desktop-runtime-compatibility-boundary) |
| `POMEGR-DT-02` | Prove packaged Node runtime compatibility | Complete 2026-08-11 | [Desktop runtime compatibility boundary](../architecture/overview.md#desktop-runtime-compatibility-boundary) |
| `POMEGR-DT-03` | Secure Electron shell and service supervisor | Complete 2026-08-11 | [Desktop shell security boundary](../architecture/overview.md#desktop-shell-security-boundary) |
| `POMEGR-DT-04` | Installed-path discovery | Complete 2026-08-11 | [Desktop installed and portable paths](../architecture/overview.md#desktop-installed-and-portable-paths) |
| `POMEGR-DT-05` | Windows installer and portable build | Complete 2026-08-11 | [Desktop releases](desktop-releases.md); alpha run in [Recorded acceptance runs](desktop-clean-vm.md#recorded-acceptance-runs) |
| `POMEGR-DT-06` | Tray, window, and launch-at-login behavior | Complete 2026-08-11 | [Desktop settings and behavior](../development/configuration.md#desktop-settings-and-behavior) |
| `POMEGR-DT-07` | Privacy-bounded native notifications | Complete 2026-08-12 | [Desktop process ownership](../architecture/overview.md#desktop-process-ownership) and [Notifications do not appear](../development/configuration.md#notifications-do-not-appear) |
| `POMEGR-DT-08` | Signed releases and automatic updates | Retired 2026-10-01 by owner decision, see the note below | [Desktop releases](desktop-releases.md) |
| `POMEGR-DT-09` | Desktop privacy and security QA | Retired 2026-10-01 by owner decision, see the note below | [Desktop shell security boundary](../architecture/overview.md#desktop-shell-security-boundary) |
| `POMEGR-DT-10` | Beta acceptance and desktop documentation | Retired 2026-10-01 by owner decision, see the note below | The optional procedure on this page and the [installation guide](../../public/get-started/install.md) |

`POMEGR-DT-08`, `POMEGR-DT-09`, and `POMEGR-DT-10` were the only tasks of that plan still open at the migration. The owner retired them on 2026-10-01 because signed stable releases ship (through v0.6.0, see [GitHub releases](https://github.com/Lecarvalho/Pomegr/releases)) without a recorded signed-beta clean-VM run. This is a retirement, not an acceptance result: no signed-beta acceptance record was ever produced, and nothing here claims that a signed-beta clean-VM run passed. The signing and update gates every release workflow enforces are in [desktop releases](desktop-releases.md#what-the-workflow-does), and `npm run desktop:security` runs the desktop privacy and security suites.
