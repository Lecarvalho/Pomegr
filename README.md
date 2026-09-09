# Pomegr

Pomegr is a local-first, read-only observer that makes coding-agent activity and efficiency signals easier to understand without exposing private session content.

## Windows desktop app

The Windows x64 desktop app is available now. [Download Pomegr](https://pomegr.com/download)
and follow [Install Pomegr](docs/public/get-started/install.md) to choose the
installer or portable app and get started. Neither download needs Node.js setup.

The desktop app includes opt-in phone access under **Settings → Phone access**. Pair a
phone browser by QR code on the same trusted private network. Sharing is off by default
and uses unencrypted HTTP; see [configuration and troubleshooting](docs/CONFIGURATION.md#another-device-cannot-open-the-dashboard).

## Run the web version

To run from source with Node.js 22.13 or newer:

```powershell
npm run dev
```

Then open [http://localhost:3003](http://localhost:3003).

On Windows, running `npm run dev` again stops this checkout's existing development
web and monitor processes before starting a fresh instance. Orphaned development
services are cleaned up too. An unrelated app (including the packaged desktop app)
using port 3003 or 4317 is left running and startup explains which port is blocked.
On other platforms, stop the previous instance before running the command again.

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

Read the [introduction to Pomegr](docs/public/get-started/introduction.md) to
understand what the dashboard observes and how to interpret its evidence.
Then [follow your first session](docs/public/get-started/first-session.md) to find
local work and open its dashboard.
Use the [documentation index](docs/README.md) for user guides,
configuration, and troubleshooting, including
[input, output, and cache tokens](docs/user-guide/tokens-and-cache.md).
The [maintainer index](docs/internal/README.md) maps technical contracts,
development workflows, and release procedures.

## How to contribute

Start with the [contribution guide](CONTRIBUTING.md), then open an [issue](https://github.com/Lecarvalho/pomegr/issues) before proposing a substantial change.

## Coding-agent plugins

Open **Repositories**, select a repository, and use **Setup** to check its plugins.
The detail page also includes **Overview**, **Context inventory**, and **Reporting**;
**Git** is a coming-soon placeholder. Plugin changes and inventory captures require
confirmation in Pomegr desktop; browser and phone clients show setup guidance.

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
