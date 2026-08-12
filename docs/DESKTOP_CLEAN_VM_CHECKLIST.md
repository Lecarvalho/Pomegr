# Windows desktop clean-VM checklist

Use this checklist for `TL-DT-05` acceptance on a clean, supported Windows x64 virtual machine. Record only software versions, paths owned by Threadlight, and pass/fail results. Do not record usernames, provider paths, session titles, repository paths, prompts, responses, commands, credentials, or screenshots containing private data.

Use these exact locally built artifacts:

- Prior-version upgrade fixture: `release-acceptance/Threadlight-TestOnly-Prior-0.0.9-x64.exe`. This ignored artifact is test-only and must not be published as a release.
- Candidate installer: `release/Threadlight-Setup-0.1.0-x64.exe`.
- Candidate portable build: `release/Threadlight-Portable-0.1.0-x64.exe`.

The local alpha artifacts are expected to be unsigned until signing is implemented in `TL-DT-08`. Before copying them to the VM, calculate SHA-256 hashes and compare them with the accepted-artifact record below. On the isolated test VM, Windows SmartScreen may show **Unknown publisher**; only after the hash matches, use **More info** and **Run anyway** for these exact local artifacts. Never disable SmartScreen globally, and do not continue if the hash differs or the artifact came from another source.

### Accepted artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Threadlight-TestOnly-Prior-0.0.9-x64.exe` | 122,568,054 | `F3C70717DB2CA3A586176EA216A2A747B3D04CBB4713CAF700DB43E55A3CC1FF` |
| `Threadlight-Setup-0.1.0-x64.exe` | 122,544,766 | `CE79013A31EE2461748665F4DA9776A8F260EBF4E19B4C5A9D474036A4BD9597` |
| `Threadlight-Portable-0.1.0-x64.exe` | 122,381,440 | `39DB7D6D011A4EC273EB8F93588A61CFE32D69845E3521EE1746053FB8B971FA` |

Some VM hosts can fail inside Chromium's graphics initialization before Threadlight code runs. If the VM shows that host-level failure, record the fixed label `VM_GRAPHICS_INITIALIZATION_FAILED`, disable that VM's virtual GPU, and rerun the same artifact. This is an acceptance-environment workaround, not a Threadlight runtime requirement.

If Threadlight shows its bounded startup error, report the complete ordered diagnostic trace. Valid trace lines start with `MONITOR_` or `SHELL_` and contain no paths or user data. Do not add arbitrary exception text, screenshots, or private environment details.

## Test record

| Field | Value |
| --- | --- |
| Threadlight version | 0.0.9 prior fixture upgraded to 0.1.0 candidate |
| Windows version | Clean Windows Sandbox; host build not recorded |
| System Node.js installed | No |
| System Git installed | No |
| Installer artifact | `Threadlight-Setup-0.1.0-x64.exe` |
| Portable artifact | `Threadlight-Portable-0.1.0-x64.exe` |
| Prior fixture SHA-256 | `F3C70717DB2CA3A586176EA216A2A747B3D04CBB4713CAF700DB43E55A3CC1FF` |
| Candidate installer SHA-256 | `CE79013A31EE2461748665F4DA9776A8F260EBF4E19B4C5A9D474036A4BD9597` |
| Candidate portable SHA-256 | `39DB7D6D011A4EC273EB8F93588A61CFE32D69845E3521EE1746053FB8B971FA` |
| Threadlight install path | Threadlight-owned per-user application directory verified |
| Threadlight user-data path | Threadlight-owned per-user data directory preserved on uninstall |
| Result | PASS |

## Installer and first launch

- [x] PASS: Verified the installer filename and version match the release.
- [x] PASS: Launched the installer as a standard user; the normal per-user path did not request administrator credentials.
- [x] PASS: The installer created the Threadlight Start menu and desktop shortcuts.
- [x] PASS: Threadlight launched without a repository checkout, system Node.js, or system Git. Missing Git did not block the dashboard.
- [x] PASS: No terminal window opened.
- [x] PASS: **About Threadlight** opened every packaged license, notice, source, dependency, and trademark document.
- [x] PASS: Threadlight quit without leaving an owned background process.

## Upgrade in place

- [x] PASS: Installed `Threadlight-TestOnly-Prior-0.0.9-x64.exe` for the same standard Windows user.
- [x] PASS: Launched version 0.0.9, closed it, and installed `Threadlight-Setup-0.1.0-x64.exe` over it without elevation.
- [x] PASS: The candidate opened and reported version 0.1.0.
- [x] PASS: Only one Threadlight installation and one set of shortcuts remained.

## Portable build

- [x] PASS: Copied the portable executable to a writable, empty directory.
- [x] PASS: Launched it without installing Node.js or Threadlight.
- [x] PASS: `ThreadlightData` was the only Threadlight-owned data directory created beside the executable.
- [x] PASS: Portable Threadlight quit without leaving an owned background process.

## Uninstall and data boundaries

- [x] PASS: Uninstalled Threadlight from Windows Settings as the installing user without administrator credentials.
- [x] PASS: Application files and Threadlight shortcuts were removed.
- [x] PASS: The Threadlight user-data directory was preserved.
- [x] PASS: Provider-owned and unrelated user data were unchanged.

`TL-DT-05` acceptance completed on 2026-08-11. The Sandbox required its virtual GPU to be disabled because of a host graphics-initialization failure; this was specific to the acceptance environment and is not a Threadlight runtime requirement.
