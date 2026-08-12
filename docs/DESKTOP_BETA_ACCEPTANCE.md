# Windows desktop beta acceptance

This is the release-candidate checklist for a Threadlight Windows x64 beta. It complements the earlier unsigned alpha record in `DESKTOP_CLEAN_VM_CHECKLIST.md`; that alpha evidence does not prove signing or automatic updates. Complete this checklist on a clean, fully patched Windows x64 VM using assets downloaded from the same draft or prerelease. Never replace a manual result with a unit-test result.

Record only product versions, public release/workflow URLs, public artifact names and checksums, the VM image/version, and pass/fail states. Do not record usernames, provider paths, session titles, repositories, prompts, responses, commands, credentials, or screenshots containing private data.

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

The verifier fails unless the record uses the exact beta version/tag, contains hashes for the complete release artifact allowlist, records no system Node.js, points to the exact versioned release and numeric Actions run under `github.com/Lecarvalho/threadlight`, and marks all 15 named manual gates `pass`. Each evidence gate maps to the checklist item with the same name. `release-acceptance/` is intentionally ignored: archive the record with release-maintainer evidence, not in source control. Its output includes a SHA-256 hash so the reviewed record can be identified later.

## Current evidence status

Open. The earlier 0.0.9-to-0.1.0 Windows Sandbox run proves unsigned installer/portable startup, upgrade-in-place, clean shutdown, and data-boundary behavior. It does not prove the signed download path, exact publisher/timestamp, synthetic notification flow, persisted beta preferences, or signed automatic update. Do not mark `TL-DT-10` complete until this checklist and its machine-verifiable record pass for a signed beta.
