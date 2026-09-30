# Windows desktop beta acceptance

> Scope: the release-candidate acceptance procedure for a Pomegr Windows x64 beta, and the acceptance items still open.
> Authority: operating procedure (gates, evidence schema, retention) plus the labeled [open items](#open-acceptance-items) carried from the retired desktop implementation plan.
> Related code and checks: `desktop/packaging/beta-acceptance.mjs` (`npm run desktop:beta:init`, `npm run desktop:beta:verify`), [desktop releases](desktop-releases.md), and the [desktop clean-VM checklist](desktop-clean-vm.md).
>
> Pomegr desktop is [available for Windows x64](https://github.com/Lecarvalho/Pomegr/releases/latest).
> This checklist tracks beta acceptance evidence separately from public availability;
> publication does not mark its unchecked gates as passed.

This is the release-candidate checklist for a Pomegr Windows x64 beta. It complements the earlier unsigned alpha run kept under [Recorded acceptance runs](desktop-clean-vm.md#recorded-acceptance-runs); that alpha evidence does not prove signing or automatic updates. Complete this checklist on a clean, fully patched Windows x64 VM using assets downloaded from the same draft or prerelease. Never replace a manual result with a unit-test result.

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
- [ ] `needsInputNotification`: Create a synthetic needs-input transition carrying a sentinel session title. Confirm exactly one notification with title `Pomegr` and body `A coding-agent session needs input`, confirm the sentinel title is absent, click through to the matching observation view, then clear the transition and confirm a future transition can notify again.
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

Do not add filenames, local paths, certificate details, error text, notes, or screenshots to the JSON. `release-acceptance/` is intentionally ignored: archive the record with release-maintainer evidence, not in source control. Verifier output includes a SHA-256 so the reviewed record can be identified later.

## Evidence retention

This page keeps the procedure and the open items, never a candidate's results. `npm run desktop:beta:init` writes the record to the ignored `release-acceptance/desktop-beta-X.Y.Z-beta.N.json`. Archive each verified record, with the SHA-256 the verifier prints, with the release maintainers' evidence outside source control. The clean-VM runs recorded before this rule stay in [Recorded acceptance runs](desktop-clean-vm.md#recorded-acceptance-runs).

## Current evidence status

Open. The earlier 0.0.9-to-0.1.0 Windows Sandbox run proves unsigned installer/portable startup, upgrade-in-place, clean shutdown, and data-boundary behavior. It does not prove the signed download path, exact publisher/timestamp, synthetic notification flow, persisted beta preferences, or signed automatic update. Do not mark `POMEGR-DT-10` complete until this checklist and its machine-verifiable record pass for a signed beta.

## Open acceptance items

> Status: open; no signed-beta record exists in this repository's documentation.
> Origin: carried on 2026-09-30 from the retired desktop implementation plan, whose `POMEGR-DT-08`, `POMEGR-DT-09`, and `POMEGR-DT-10` were its only unfinished tasks.
> Lifetime: temporary. Delete this section when a signed beta's acceptance record verifies and the three items are closed. The reusable procedure above stays.

Closing `POMEGR-DT-10` also closes the first desktop release's definition of done, which is the conjunction of every milestone below.

### POMEGR-DT-08: signed releases and automatic updates

The repository implementation and automated release gates are in place (see [desktop releases](desktop-releases.md)). Completion is blocked on external evidence from two real signed beta releases: a clean-Windows-VM upgrade, invalid-signer rejection, checksum and signature re-verification, and CI log inspection. Run the [beta update acceptance](desktop-releases.md#beta-update-acceptance) and record the result in the machine-verifiable record above.

- [ ] A signed older beta can discover, download, verify, and install a newer beta.
- [ ] Unsigned or incorrectly signed updates are rejected.
- [ ] Update failure leaves the current installation usable.
- [ ] Every binary release has matching corresponding source available at no charge.
- [ ] Signing credentials never appear in repository history or artifacts.

Verification: exercise an update from one test version to the next on a clean Windows VM; verify signature and checksum before and after installation; inspect workflow logs for secret masking and private-path leakage.

### POMEGR-DT-09: desktop privacy and security QA

The retired plan recorded no acceptance status or completion notes for this item, so treat it as open until a maintainer confirms each item against the current desktop tests and records the result. It depends on `POMEGR-DT-03` through `POMEGR-DT-08`. The goal is to prove that desktop packaging and native integrations do not weaken Pomegr's security, privacy, read-only behavior, or failure isolation.

Work to confirm:

- Automated assertions for BrowserWindow sandboxing, context isolation, disabled Node integration, denied webviews, denied unexpected navigation, and bounded preload APIs.
- Local-origin authorization, Host/Origin rejection, dynamic ports, concurrent local clients, and launch-lifetime authorization revocation.
- The `/api/state` and `/api/sessions` serialization privacy audits, repeated through the packaged desktop path.
- Desktop IPC privacy sentinels for prompts, responses, commands, tool output, credentials, environment values, private paths, and arbitrary exceptions.
- Notifications, tray labels, desktop logs, crash handling, and update errors carry only bounded safe metadata.
- The monitor remains read-only under desktop startup and cannot perform provider control actions.
- Process cleanup after normal quit, renderer crash, utility-process crash, update restart, Windows logoff, and forced application termination.
- An audit of packaged dependencies that records their licenses without changing third-party terms.

Acceptance criteria:

- [ ] No forbidden privacy sentinel reaches the renderer, IPC payloads, notifications, logs, crash UI, or release artifacts.
- [ ] The renderer cannot access filesystem, shell, process, unrestricted IPC, or Electron internals.
- [ ] Unexpected local origins cannot read desktop metadata.
- [ ] Provider, Git, web, tray, notification, and updater failures degrade independently.
- [ ] All observed desktop behavior remains read-only.

Verification: `npm run build`, `npm test`, `npm run desktop:smoke`, `npm run desktop:security`, `npm run desktop:inspect`, and `npm run lint`.

### POMEGR-DT-10: beta acceptance and desktop documentation

Automation, user and contributor documentation, and the release checklist are implemented. Final signed-beta clean-VM evidence remains open, and the earlier unsigned alpha run cannot satisfy it. The nine-step first-run path maps to the [clean-VM gates](#clean-vm-first-run-and-lifecycle-gates): download the installer (`downloadArtifacts`), verify the publisher and signature (`verifyChecksums`, `verifyPublisherSignature`), install without Node.js (`standardUserInstall`), launch without a terminal (`firstLaunch`), discover existing provider sessions (`providerDiscovery`), receive and clear a synthetic safe needs-input notification (`needsInputNotification`), restart and preserve bounded preferences (`preferenceRestart`), update to a newer signed version (`signedUpdate`), and uninstall without touching provider data (`uninstallDataBoundary`).

- [ ] A new user can go from download to visible sessions without cloning the repository or installing Node.js. The [installation guide](../../public/get-started/install.md) distinguishes desktop installation, portable beta, and source development.
- [ ] No unsupported operating system or provider capability is implied.
- [ ] The release has corresponding source, legal notices, signatures, checksums, and reproducible version metadata.
- [ ] Temporary diagnostics, unsigned test artifacts, and local signing configuration are removed before publication.
- [ ] The full build, test, lint, desktop security, and artifact-inspection commands listed under `POMEGR-DT-09` pass.

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
| `POMEGR-DT-08` | Signed releases and automatic updates | Open | [Open acceptance items](#pomegr-dt-08-signed-releases-and-automatic-updates) |
| `POMEGR-DT-09` | Desktop privacy and security QA | Open | [Open acceptance items](#pomegr-dt-09-desktop-privacy-and-security-qa) |
| `POMEGR-DT-10` | Beta acceptance and desktop documentation | Open | [Open acceptance items](#pomegr-dt-10-beta-acceptance-and-desktop-documentation) |
