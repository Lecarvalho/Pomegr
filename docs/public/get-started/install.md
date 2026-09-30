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
Git, or a copy of Pomegr's source code to install and open the app. Optional Git
and GitHub information depends on their command-line tools being available.

Pomegr observes locally saved Claude Code and Codex sessions. Install it on the
computer where you use those coding tools; downloading Pomegr does not install
them or create session history.

## Choose your download

Open the [Pomegr download page](https://pomegr.com/download) and choose one of
the two options:

| Download | Choose it when… | Updates and login |
| --- | --- | --- |
| **Installer** | You want an app installed for your Windows user. | Automatic update checks and downloads; **Launch at login** in the tray menu. |
| **Portable** | You want to run from a writable folder without installing. | Manual updates; no launch at login. |

## Install and open the app

### Installed app

1. Select **Download installer** on the download page.
2. Open it and follow the installer. It installs for your Windows user without
   requiring administrator credentials.
3. Open **Pomegr** from the Windows Start menu. The dashboard opens and begins
   discovering locally saved sessions.

### Portable app

1. Select **Download portable** on the download page.
2. Put it in a folder where your Windows user can write files, then open it. The
   dashboard opens and begins discovering locally saved sessions.
3. Keep the `PomegrData` folder created beside the executable. It holds Pomegr's
   settings and saved observation state. Move it with the executable if you move
   the app to another folder.

The portable dashboard observes the same local session sources as the installed
app. Provider session files stay in their original locations.

Next, [follow your first session](first-session.md) to find local work and open
its dashboard.

## Keep Pomegr up to date

The installed app checks for updates after startup and every four hours by
default, and downloads newer releases from the channel you installed. To check
manually, open **Settings → About** and select **Check for updates**. When a
verified update is ready, select **Restart and install** there, or **Restart to
update** at the bottom of the sidebar, when you are ready to restart. A failed
check or download leaves the current app usable.

Portable mode never checks for updates automatically. To update it:

1. Quit Pomegr with **Quit Pomegr** in the tray menu.
2. Select **Download portable** on the
   [download page](https://pomegr.com/download).
3. Replace your old executable with the new one, in the folder that contains
   `PomegrData`.
4. Open the new executable. Pomegr starts with your existing settings and
   observation state.
