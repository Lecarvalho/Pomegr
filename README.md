# Pomegr

Pomegr is a local-first, read-only observer that makes coding-agent activity and efficiency signals easier to understand without exposing private session content.

## Windows desktop app

The Windows x64 desktop app is available now. [Download the latest release](https://github.com/Lecarvalho/Pomegr/releases/latest) and choose:

- **Installer:** `Pomegr-Setup-<version>-x64.exe` for an installed app with automatic update checks and downloads. Restart to install an update when you're ready.
- **Portable:** `Pomegr-Portable-<version>-x64.exe` to run without installing. Portable mode does not support automatic updates or launch at login.

No Node.js setup is required for either download.

The desktop app includes opt-in phone access under **Settings → Phone access**. Pair a
phone browser by QR code on the same trusted private network. Sharing is off by default
and uses unencrypted HTTP; see [configuration and troubleshooting](docs/CONFIGURATION.md#another-device-cannot-open-the-dashboard).

## Run the web version

To run from source with Node.js 22.13 or newer:

```powershell
npm run dev
```

Then open [http://localhost:3003](http://localhost:3003).

For internal pipeline timing diagnostics, attach the passive terminal monitor from a
second shell:

```powershell
npm run ops:pipeline
```

See [Pipeline operations monitor](docs/PIPELINE_OPERATIONS.md) for its bounded diagnostic
contract, available stages, and the separately planned browser-render timing milestone.

<p align="center">
  <img src="landing/public/landing/about/observer-principles-signal.webp" alt="A hand-drawn pomegranate connected to four small signal seeds." width="360" />
</p>

## Documentation

Start with the [Pomegr user guide](docs/user-guide/README.md) to understand the app,
including [input, output, and cache tokens](docs/user-guide/tokens-and-cache.md).

## How to contribute

Start with the [contribution guide](CONTRIBUTING.md), then open an [issue](https://github.com/Lecarvalho/pomegr/issues) before proposing a substantial change.

## Coding-agent plugins

- [Install the Pomegr reporting plugin for Codex or Claude Code](docs/PLUGINS.md)

## Publish procedures

- **Skill changes:** Edit the canonical skill sources and regenerate both provider packages; follow [Skill changes](docs/PLUGINS.md#skill-changes).
- **Plugin upgrade:** Bump the shared Claude and Codex plugin version and rebuild both packages; follow [Plugin upgrade](docs/PLUGINS.md#plugin-upgrade).
- **Desktop release versioning and publish:** Set the canonical package version, merge the release commit, create its immutable tag, and manually publish the signed Windows artifacts by following [Publish signed artifacts](docs/DESKTOP_RELEASES.md#publish-signed-artifacts).
- **Public landing site:** Deploy the independently audited Cloudflare Worker artifact; follow [Release the exact audited artifact](landing/OPERATIONS.md#5-release-the-exact-audited-artifact).

## Current limitations

- Desktop downloads are currently available for Windows x64 only.
- Claude Code and Codex expose different amounts of session data.
- Efficiency signals are deterministic heuristics, not authoritative judgments.

## Licence

Pomegr is licensed under [AGPL-3.0-only](LICENSE). See the [license history](docs/LICENSE_HISTORY.md) and [trademark policy](TRADEMARKS.md) for details.
