---
title: "Install Pomegr"
description: "Download Pomegr for Windows x64 and choose between the installed and portable apps."
---

# Install Pomegr

Download Pomegr for Windows x64 to follow coding-agent sessions on your computer.
Choose the installer for everyday use or the portable app to run without
installing. Both include the runtime they need.

## Before you start

Use a Windows x64 computer. Desktop builds for macOS, Linux, Windows ARM64, and
app stores are not supported. You do not need administrator credentials, Node.js,
Git, or a copy of Pomegr's source code to install and open the app. Optional Git and GitHub
information depends on their command-line tools being available.

Pomegr observes locally saved Claude Code and Codex sessions. Install it on the
computer where you use those coding tools; downloading Pomegr does not install
them or create session history.

## Choose your download

Open the [latest stable release](https://github.com/Lecarvalho/Pomegr/releases/latest)
and expand **Assets** if the downloads are collapsed. The version number in each
filename changes with the release.

| Download | Choose it when… | Updates and login |
| --- | --- | --- |
| `Pomegr-Setup-<version>-x64.exe` | You want an app installed for your Windows user. | Automatic update checks and downloads; optional launch at login. |
| `Pomegr-Portable-<version>-x64.exe` | You want to run from a writable folder without installing. | Manual updates; no launch at login. |

Choose one of these executables. The source ZIP is for working with the source
code and is not needed to run the desktop app.

## Install and open the app

### Installed app

1. Download `Pomegr-Setup-<version>-x64.exe` from the release's **Assets**.
2. Open it and follow the installer. It installs for your Windows user without
   requiring administrator credentials.
3. Open **Pomegr** from the Windows Start menu. The dashboard opens and begins
   discovering locally saved sessions.

### Portable app

1. Download `Pomegr-Portable-<version>-x64.exe` from the release's **Assets**.
2. Put it in a folder where your Windows user can write files, then open it.
3. Keep the `PomegrData` folder created beside the executable. It holds Pomegr's
   settings and saved observation state. Move it with the executable if you move
   the app to another folder.

The portable dashboard observes the same local session sources as the installed
app. Provider session files stay in their original locations.

Read the [introduction to Pomegr](introduction.md) for a tour of the dashboard and
the evidence it displays.

## Keep Pomegr up to date

Installed signed builds check for updates after startup and every four hours by
default. They download newer releases from the same stable or beta channel.
Open **Settings → About** to check manually. When a verified update is ready,
select **Restart and install**, or **Restart to update** at the bottom left, when
you are ready to restart. A failed check or download leaves the current app usable.

For portable mode, quit Pomegr, download the newer portable executable, and open
it from the folder containing your existing `PomegrData` to retain Pomegr state.
Portable mode never checks for updates automatically.
