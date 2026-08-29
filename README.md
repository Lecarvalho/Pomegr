# Pomegr

Pomegr is a local-first, read-only observer that makes coding-agent activity and efficiency signals easier to understand without exposing private session content.

## Run the web version

To run from source with Node.js 22.13 or newer:

```powershell
npm run dev
```

Then open [http://localhost:3003](http://localhost:3003).

<p align="center">
  <img src="landing/public/landing/about/observer-principles-signal.webp" alt="A hand-drawn pomegranate connected to four small signal seeds." width="360" />
</p>

## Windows desktop app (planned)

Pomegr’s planned desktop app targets Windows x64. No public installer is currently documented as available.

When released, LAN sharing will be unavailable in the Windows desktop app.

## Portable beta (planned)

A portable Windows x64 beta is planned. No public download is currently documented as available.

## How to contribute

Start with the [contribution guide](CONTRIBUTING.md), then open an [issue](https://github.com/Lecarvalho/pomegr/issues) before proposing a substantial change.

## Coding-agent plugins

- [Install the Pomegr reporting plugin for Codex or Claude Code](docs/PLUGINS.md)

## Publish procedures

- **Skill changes:** Edit the canonical skill sources and regenerate both provider packages; follow [Skill changes](docs/PLUGINS.md#skill-changes).
- **Plugin upgrade:** Bump the shared Claude and Codex plugin version and rebuild both packages; follow [Plugin upgrade](docs/PLUGINS.md#plugin-upgrade).
- **Desktop package and publish:** Publish signed Windows artifacts only through the immutable-tag release workflow; follow [Package and publish](docs/DESKTOP_RELEASES.md#package-and-publish).
- **Public landing site:** Deploy the independently audited Cloudflare Worker artifact; follow [Release the exact audited artifact](landing/OPERATIONS.md#5-release-the-exact-audited-artifact).

## Current limitations

- The planned desktop app targets Windows x64 only.
- Claude Code and Codex expose different amounts of session data.
- Efficiency signals are deterministic heuristics, not authoritative judgments.

## Licence

Pomegr is licensed under [AGPL-3.0-only](LICENSE). See the [license history](docs/LICENSE_HISTORY.md) and [trademark policy](TRADEMARKS.md) for details.
