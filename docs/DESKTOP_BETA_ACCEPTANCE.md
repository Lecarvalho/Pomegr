# Windows desktop beta acceptance

This is the release-candidate checklist for a Threadlight Windows x64 beta. It complements the earlier unsigned alpha record in `DESKTOP_CLEAN_VM_CHECKLIST.md`; that alpha evidence does not prove signing or automatic updates. Complete this checklist on a clean, fully patched Windows x64 VM using assets downloaded from the same draft or prerelease. Never replace a manual result with a unit-test result.

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

- [ ] `downloadArtifacts`: Download the installer, portable build, `SHA256SUMS.txt`, and corresponding source archive from the exact `github.com/Lecarvalho/threadlight` beta release recorded in the evidence file.
- [ ] `verifyChecksums`: Verify every downloaded artifact against `SHA256SUMS.txt` before launching anything.
- [ ] `verifyPublisherSignature`: Verify the installer's valid Authenticode signature, trusted timestamp, and complete expected publisher Subject without disabling SmartScreen or another security control.
- [ ] `standardUserInstall`: Install on supported Windows x64 as a standard user with no system Node.js and no repository checkout; confirm no administrator credentials or terminal are required.
- [ ] `firstLaunch`: Launch from the Start menu and confirm the dashboard becomes visible without opening a terminal.
- [ ] `providerDiscovery`: Confirm existing Claude Code and/or Codex persisted sessions appear and that absence of one provider does not hide the other.
- [ ] `needsInputNotification`: Create a synthetic needs-input transition carrying a sentinel session title. Confirm exactly one notification with title `Threadlight` and body `A coding-agent session needs input`, confirm the sentinel title is absent, click through to the matching observation view, then clear the transition and confirm a future transition can notify again.
- [ ] `preferenceRestart`: Change close behavior, launch-at-login, and notification preference; restart and confirm those bounded preferences persist while temporary one-hour quiet mode does not.
- [ ] `signedUpdate`: From an older signed beta, accept an offered higher signed beta on the beta channel and confirm the explicitly approved restart/install opens the newer version.
- [ ] `updateFailureRecovery`: Repeat the interrupted-download, unsigned-package, and wrong-publisher cases in `DESKTOP_RELEASES.md`; confirm every case is rejected and the installed version remains runnable.
- [ ] `cleanShutdown`: Quit and confirm every owned monitor, web, and Electron process stops.
- [ ] `uninstallDataBoundary`: Uninstall and confirm application files and shortcuts are removed while Threadlight user data, provider data, and unrelated user data remain untouched.
- [ ] `portableIsolation`: Launch the portable beta separately and confirm it uses `ThreadlightData` beside the executable, does not register launch at login, and does not offer automatic updates.
- [ ] `packagedLegal`: Confirm the packaged About page exposes the AGPL license, notice, source offer, dependency notices, and trademark policy.
- [ ] `artifactPrivacyInspection`: Inspect release assets and workflow logs and confirm they contain no secrets, certificate bytes, private paths, transcripts, prompts, responses, commands, tool output, unsigned fixtures, or local signing configuration.

## Machine-verifiable acceptance record

After every manual checkbox passes, create the ignored record and replace every placeholder with safe evidence:

```powershell
npm run desktop:beta:init -- --version X.Y.Z-beta.N
npm run desktop:beta:verify -- --version X.Y.Z-beta.N
```

The `--version` argument is the newer beta. The verifier fails unless both releases are betas on the same `X.Y.Z` base and the older beta ordinal is strictly lower than the newer beta ordinal. It also requires the exact newer release artifact allowlist, no system Node.js, exact versioned release URLs, numeric Actions run URLs under `github.com/Lecarvalho/threadlight`, all bounded SHA-256 fields, the fixed outcomes below, and all 15 named manual gates set to `pass`. Each manual evidence gate maps to the checklist item with the same name.

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

## Current evidence status

Open. The earlier 0.0.9-to-0.1.0 Windows Sandbox run proves unsigned installer/portable startup, upgrade-in-place, clean shutdown, and data-boundary behavior. It does not prove the signed download path, exact publisher/timestamp, synthetic notification flow, persisted beta preferences, or signed automatic update. Do not mark `TL-DT-10` complete until this checklist and its machine-verifiable record pass for a signed beta.
