# Windows desktop clean-VM checklist

Use this checklist for `TL-DT-05` acceptance on a clean, supported Windows x64 virtual machine. Record only software versions, paths owned by Threadlight, and pass/fail results. Do not record usernames, provider paths, session titles, repository paths, prompts, responses, commands, credentials, or screenshots containing private data.

Use these exact locally built artifacts:

- Prior-version upgrade fixture: `release-acceptance/Threadlight-TestOnly-Prior-0.0.9-x64.exe`. This ignored artifact is test-only and must not be published as a release.
- Candidate installer: `release/Threadlight-Setup-0.1.0-x64.exe`.
- Candidate portable build: `release/Threadlight-Portable-0.1.0-x64.exe`.

The local alpha artifacts are expected to be unsigned until signing is implemented in `TL-DT-08`. Before copying them to the VM, calculate SHA-256 hashes and compare them with the acceptance handoff. On the isolated test VM, Windows SmartScreen may show **Unknown publisher**; only after the hash matches, use **More info** and **Run anyway** for these exact local artifacts. Never disable SmartScreen globally, and do not continue if the hash differs or the artifact came from another source.

## Test record

| Field | Value |
| --- | --- |
| Threadlight version | Not run |
| Windows version | Not run |
| System Node.js installed | Not run |
| Installer artifact | Not run |
| Portable artifact | Not run |
| Prior fixture SHA-256 | Not run |
| Candidate installer SHA-256 | Not run |
| Candidate portable SHA-256 | Not run |
| Threadlight install path | Not run |
| Threadlight user-data path | Not run |
| Result | Not run |

## Installer and first launch

- [ ] PASS / FAIL: Verify the installer filename and version match the release.
- [ ] PASS / FAIL: Launch the installer as a standard user and confirm the normal per-user path does not request administrator credentials.
- [ ] PASS / FAIL: Confirm the installer creates the Threadlight Start menu and desktop shortcuts.
- [ ] PASS / FAIL: Launch Threadlight without a repository checkout or system Node.js.
- [ ] PASS / FAIL: Confirm no terminal window opens.
- [ ] PASS / FAIL: Open **About Threadlight**, then open every packaged license, notice, source, dependency, and trademark document.
- [ ] PASS / FAIL: Quit Threadlight and confirm no owned background process remains.

## Upgrade in place

- [ ] PASS / FAIL: Install `Threadlight-TestOnly-Prior-0.0.9-x64.exe` for the same standard Windows user.
- [ ] PASS / FAIL: Launch version 0.0.9 once, close it, and install `Threadlight-Setup-0.1.0-x64.exe` over it without elevation.
- [ ] PASS / FAIL: Confirm the candidate opens and reports the candidate version.
- [ ] PASS / FAIL: Confirm only one Threadlight installation and one set of shortcuts remain.

## Portable build

- [ ] PASS / FAIL: Copy the portable executable to a writable, empty directory.
- [ ] PASS / FAIL: Launch it without installing Node.js or Threadlight.
- [ ] PASS / FAIL: Confirm `ThreadlightData` is the only Threadlight-owned data directory created beside the executable.
- [ ] PASS / FAIL: Quit and confirm no owned background process remains.

## Uninstall and data boundaries

- [ ] PASS / FAIL: Uninstall Threadlight from Windows Settings as the installing user without administrator credentials.
- [ ] PASS / FAIL: Confirm application files and Threadlight shortcuts are removed.
- [ ] PASS / FAIL: Confirm the Threadlight user-data path is not deleted automatically.
- [ ] PASS / FAIL: Confirm provider-owned and unrelated user data are unchanged. Record only PASS or FAIL, never those paths or contents.

`TL-DT-05` stays incomplete until every item above passes. Failed checks should be reported with a fixed test label and no private path or content.
