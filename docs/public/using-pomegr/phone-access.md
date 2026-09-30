---
title: "Phone access"
description: "Share Pomegr, read-only, with a phone on your private network, and recover when pairing or the connection stops working."
---

# Phone access

Phone access lets a phone browser on the same private network view your Pomegr
dashboard. It is read-only and off by default, and it works only from the Windows
desktop app. Pomegr sends the page over unencrypted HTTP, so use it only on a
network you trust. No cloud account or phone app is needed.

## Before you start

- The computer runs the Pomegr desktop app and stays awake; keeping Pomegr in the
  tray is enough.
- The phone and the computer are on the same local network, and Windows
  classifies the computer's connection as **Private**. Public, domain, VPN,
  virtual, and IPv6-only connections are not supported.

## Pair a phone

1. On the computer, open **Settings → Phone access**. If more than one private
   network is available, choose one under **Private network**.
2. Select **Enable phone access**. The panel reads **Sharing started** and shows
   the address the phone will use. Windows may ask to allow Pomegr on private
   networks; allow only private networks.
3. Select **Create pairing code** and scan the QR code with the phone's camera.
   The panel shows the time the code expires, five minutes after you create it.
   Each code pairs one browser; **Regenerate code** makes another.
4. The phone opens the dashboard. The panel counts the **paired phones**: up to
   four browsers can be paired at once, and the count is browsers, not proof that
   each is connected now.

## What a phone can do

A paired phone shows the same normalized dashboard, read-only: Home, Sessions,
Repositories, Models & delegation, Usage limits, and Settings, where
**Providers** and **Storage** are view-only. It cannot copy a transcript path,
use desktop controls, sign in to a coding tool, or change sharing. The **Phone
access** tab exists only in the desktop app.

## Control sharing

- **Stop sharing**, or quitting Pomegr, revokes every phone and closes open
  connections.
- **Start on a private network** checks for a private network each time Pomegr
  launches. It is the only thing remembered; addresses and pairings are not, so
  after a restart create a new code.
- If the connection drops briefly, the panel reads **Reconnecting phone access**
  and paired phones reconnect on their own. If the network you chose changes,
  sharing stops; choose it again and select **Enable phone access**.

## If a phone cannot connect

- **The phone reads "This pairing code could not be used."** The code expired,
  was already used, or Pomegr restarted. Create a new code on the computer.
- **The phone reads "Phone access expired."** Its pairing ended. Create a new code
  and scan it.
- **The panel reads "Windows classifies your connected network as Public."** In
  Windows Settings, open **Network & internet**, select the connection, set
  **Network profile type** to **Private**, then select **Refresh networks** and
  **Retry phone access**.
- **The panel reads "Pomegr could not find a private network to share on."**
  Connect to a private network, then select **Refresh networks**.
- **The phone still cannot reach the address.** **Sharing started** confirms only
  the computer's listener. Check that guest Wi-Fi or access-point isolation is off,
  and that Windows Firewall allows Pomegr on **Private** networks only. Pomegr does
  not change firewall rules.
- **The phone reads "Pomegr cannot accept another pairing attempt right now."**
  Wait a minute, or create a new code.
