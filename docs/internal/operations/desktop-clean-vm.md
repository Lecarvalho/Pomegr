# Windows desktop clean-VM checklist

> Scope: the reusable clean-VM checks for a Pomegr Windows x64 candidate: installer, first launch, upgrade in place, portable build, and uninstall.
> Authority: operating procedure. It carries no per-candidate result; the completed and pending runs it knows about are kept under [Recorded acceptance runs](#recorded-acceptance-runs).
> Related code and checks: `desktop/packaging/` (`npm run desktop:package:acceptance-prior`, `npm run desktop:inspect:acceptance-prior`), [desktop releases](desktop-releases.md), and [desktop beta acceptance](desktop-beta-acceptance.md) for the signed-beta gates.

Pomegr desktop is [available for Windows x64](https://github.com/Lecarvalho/Pomegr/releases/latest), including installer and portable downloads. This checklist is an acceptance procedure for a candidate; an unrecorded run does not mean the desktop application is unavailable.

Use it for `POMEGR-DT-08` acceptance (see the [desktop milestone IDs](desktop-beta-acceptance.md#desktop-milestone-ids)) of a Pomegr candidate `X.Y.Z` on a clean, supported Windows x64 virtual machine. Record only software versions, paths owned by Pomegr, cryptographic artifact evidence, and pass/fail results. Do not record usernames, provider paths, session titles, repository paths, prompts, responses, commands, credentials, or screenshots containing private data.

## Candidate artifacts

Use these exact artifact names when evidence is collected:

- Prior-version upgrade fixture: `release-acceptance/Pomegr-TestOnly-Prior-0.0.9-x64.exe`. This ignored artifact is test-only and must not be published as a release. Build it with `npm run desktop:package:acceptance-prior` and inspect it with `npm run desktop:inspect:acceptance-prior`.
- Candidate installer: `release/Pomegr-Setup-X.Y.Z-x64.exe`.
- Candidate portable build: `release/Pomegr-Portable-X.Y.Z-x64.exe`.

The prior-fixture name and version are prior-fixture facts only. They are not evidence that any candidate was built, signed, installed, upgraded, or accepted.

The candidate must come from the intended signed release workflow. Before copying artifacts to the VM, record their byte sizes and SHA-256 hashes in a separate acceptance record, verify the Windows publisher is DSNK Technologie Inc, and compare the VM copies with that record. Do not bypass SmartScreen, disable it globally, accept an unsigned candidate, or continue when any signature, size, hash, filename, version, or source differs.

Some VM hosts can fail inside Chromium's graphics initialization before Pomegr code runs. If the VM shows that host-level failure, record the fixed label `VM_GRAPHICS_INITIALIZATION_FAILED`, disable that VM's virtual GPU, and rerun the same artifact. This is an acceptance-environment workaround, not a Pomegr runtime requirement.

If Pomegr shows its bounded startup error, report the complete ordered diagnostic trace. Valid trace lines start with `MONITOR_` or `SHELL_` and contain no paths or user data. Do not add arbitrary exception text, screenshots, or private environment details.

## Test record

Fill one record per candidate. Leave a field as PENDING until its evidence exists.

| Field | Value |
| --- | --- |
| Pomegr version | Prior fixture 0.0.9 to candidate X.Y.Z |
| Windows version | |
| System Node.js installed | |
| System Git installed | |
| Installer artifact evidence | Byte size and SHA-256 |
| Portable artifact evidence | Byte size and SHA-256 |
| Prior fixture evidence | Prior-only input, not candidate proof |
| Pomegr install path | |
| Pomegr user-data path | |
| Result | |

## Installer and first launch

- [ ] Verify the signed installer filename and version match the candidate evidence record.
- [ ] Launch the installer as a standard user and verify the normal per-user path does not request administrator credentials.
- [ ] Verify the installer creates the Pomegr Start menu and desktop shortcuts.
- [ ] Verify Pomegr launches without a repository checkout, system Node.js, or system Git, and missing Git does not block the dashboard.
- [ ] Verify no terminal window opens.
- [ ] Verify **About Pomegr** opens every packaged license, notice, source, dependency, and trademark document.
- [ ] Verify Pomegr quits without leaving an owned background process.

## Upgrade in place

- [ ] Build, inspect, and install `Pomegr-TestOnly-Prior-0.0.9-x64.exe` for the same standard Windows user.
- [ ] Launch version 0.0.9, close it, and install the verified `Pomegr-Setup-X.Y.Z-x64.exe` over it without elevation.
- [ ] Verify the candidate opens and reports version X.Y.Z.
- [ ] Verify only one Pomegr installation and one set of shortcuts remain.

## Portable build

- [ ] Copy the verified portable executable to a writable, empty directory.
- [ ] Launch it without installing Node.js or Pomegr.
- [ ] Verify `PomegrData` is the only Pomegr-owned data directory created beside the executable.
- [ ] Verify portable Pomegr quits without leaving an owned background process.

## Uninstall and data boundaries

- [ ] Uninstall Pomegr from Windows Settings as the installing user without administrator credentials.
- [ ] Verify application files and Pomegr shortcuts are removed.
- [ ] Verify the Pomegr user-data directory is preserved.
- [ ] Verify provider-owned and unrelated user data are unchanged.

A candidate's acceptance remains **PENDING** until its artifact evidence is recorded and every item above is executed on the same verified artifacts.

## Recorded acceptance runs

No evidence store for clean-VM results is documented beyond the ignored `release-acceptance/` directory and the release maintainers' archive described in [desktop beta acceptance](desktop-beta-acceptance.md#evidence-retention). These are the runs the repository documentation has recorded; new runs belong in that archive, and only the reusable procedure above stays in this page.

| Candidate | Recorded | Environment | Result |
| --- | --- | --- | --- |
| 0.1.0 unsigned alpha, upgraded from the 0.0.9 prior fixture | 2026-08-11 (`POMEGR-DT-05`) | Clean Windows Sandbox without system Node.js or Git | Passed install, first launch, in-place upgrade, portable launch and storage, clean shutdown, and uninstall with data preserved. It does not prove signing, publisher, timestamp, or automatic updates. |
| 0.2.4 candidate (`POMEGR-DT-08`) | none | none | **PENDING.** No candidate size, SHA-256, publisher verification, or run was recorded, and this page contains no 0.2.4 PASS claim. |

Accepted SHA-256 values for the 2026-08-11 alpha run:

| Artifact | SHA-256 |
| --- | --- |
| Prior fixture | `F3C70717DB2CA3A586176EA216A2A747B3D04CBB4713CAF700DB43E55A3CC1FF` |
| Setup | `CE79013A31EE2461748665F4DA9776A8F260EBF4E19B4C5A9D474036A4BD9597` |
| Portable | `39DB7D6D011A4EC273EB8F93588A61CFE32D69845E3521EE1746053FB8B971FA` |

The 0.2.4 candidate used these exact names: `release-acceptance/Pomegr-TestOnly-Prior-0.0.9-x64.exe` (test-only prior fixture, not candidate proof), `release/Pomegr-Setup-0.2.4-x64.exe`, and `release/Pomegr-Portable-0.2.4-x64.exe`. The 0.0.9 name and version are retained only as historical prior-fixture facts.
