# Windows desktop clean-VM checklist

Use this checklist for `POMEGR-DT-08` acceptance of Pomegr 0.2.1 on a clean, supported Windows x64 virtual machine. Record only software versions, paths owned by Pomegr, cryptographic artifact evidence, and pass/fail results. Do not record usernames, provider paths, session titles, repository paths, prompts, responses, commands, credentials, or screenshots containing private data.

## Acceptance status

**PENDING:** Pomegr 0.2.1 candidate artifacts have not yet been recorded or accepted on a clean VM. This document contains no Pomegr 0.2.1 PASS claim.

Use these exact artifact names when evidence is collected:

- Prior-version upgrade fixture: `release-acceptance/Pomegr-TestOnly-Prior-0.0.9-x64.exe`. This ignored artifact is test-only and must not be published as a release.
- Candidate installer: `release/Pomegr-Setup-0.2.1-x64.exe`.
- Candidate portable build: `release/Pomegr-Portable-0.2.1-x64.exe`.

The 0.0.9 artifact name and version are retained only as historical prior-fixture facts. They are not evidence that the Pomegr 0.2.1 candidate was built, signed, installed, upgraded, or accepted.

The Pomegr 0.2.1 candidate must come from the intended signed release workflow. Before copying artifacts to the VM, record their byte sizes and SHA-256 hashes in a separate acceptance record, verify the Windows publisher is DSNK Technologie Inc, and compare the VM copies with that record. Do not bypass SmartScreen, disable it globally, accept an unsigned candidate, or continue when any signature, size, hash, filename, version, or source differs.

### Candidate artifact evidence

| Artifact | Evidence status |
| --- | --- |
| `Pomegr-TestOnly-Prior-0.0.9-x64.exe` | PENDING — prior fixture only; rebuild and inspect before upgrade testing |
| `Pomegr-Setup-0.2.1-x64.exe` | PENDING — candidate size, SHA-256, and publisher verification not recorded |
| `Pomegr-Portable-0.2.1-x64.exe` | PENDING — candidate size, SHA-256, and publisher verification not recorded |

Some VM hosts can fail inside Chromium's graphics initialization before Pomegr code runs. If the VM shows that host-level failure, record the fixed label `VM_GRAPHICS_INITIALIZATION_FAILED`, disable that VM's virtual GPU, and rerun the same artifact. This is an acceptance-environment workaround, not a Pomegr runtime requirement.

If Pomegr shows its bounded startup error, report the complete ordered diagnostic trace. Valid trace lines start with `MONITOR_` or `SHELL_` and contain no paths or user data. Do not add arbitrary exception text, screenshots, or private environment details.

## Test record

| Field | Value |
| --- | --- |
| Pomegr version | PENDING — 0.0.9 prior fixture to 0.2.1 candidate |
| Windows version | PENDING |
| System Node.js installed | PENDING |
| System Git installed | PENDING |
| Installer artifact evidence | PENDING |
| Portable artifact evidence | PENDING |
| Prior fixture evidence | PENDING — prior-only input, not Pomegr 0.2.1 proof |
| Pomegr install path | PENDING |
| Pomegr user-data path | PENDING |
| Result | PENDING |

## Installer and first launch

- [ ] PENDING: Verify the signed installer filename and version match the candidate evidence record.
- [ ] PENDING: Launch the installer as a standard user and verify the normal per-user path does not request administrator credentials.
- [ ] PENDING: Verify the installer creates the Pomegr Start menu and desktop shortcuts.
- [ ] PENDING: Verify Pomegr launches without a repository checkout, system Node.js, or system Git, and missing Git does not block the dashboard.
- [ ] PENDING: Verify no terminal window opens.
- [ ] PENDING: Verify **About Pomegr** opens every packaged license, notice, source, dependency, and trademark document.
- [ ] PENDING: Verify Pomegr quits without leaving an owned background process.

## Upgrade in place

- [ ] PENDING: Build, inspect, and install `Pomegr-TestOnly-Prior-0.0.9-x64.exe` for the same standard Windows user.
- [ ] PENDING: Launch version 0.0.9, close it, and install the verified `Pomegr-Setup-0.2.1-x64.exe` over it without elevation.
- [ ] PENDING: Verify the candidate opens and reports version 0.2.1.
- [ ] PENDING: Verify only one Pomegr installation and one set of shortcuts remain.

## Portable build

- [ ] PENDING: Copy the verified portable executable to a writable, empty directory.
- [ ] PENDING: Launch it without installing Node.js or Pomegr.
- [ ] PENDING: Verify `PomegrData` is the only Pomegr-owned data directory created beside the executable.
- [ ] PENDING: Verify portable Pomegr quits without leaving an owned background process.

## Uninstall and data boundaries

- [ ] PENDING: Uninstall Pomegr from Windows Settings as the installing user without administrator credentials.
- [ ] PENDING: Verify application files and Pomegr shortcuts are removed.
- [ ] PENDING: Verify the Pomegr user-data directory is preserved.
- [ ] PENDING: Verify provider-owned and unrelated user data are unchanged.

Acceptance remains **PENDING** until the candidate artifact evidence is recorded and every item above is executed on the same verified Pomegr 0.2.1 artifacts.
