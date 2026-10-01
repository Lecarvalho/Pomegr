# Pomegr

Pomegr is a local-first, read-only observer that makes coding-agent activity and efficiency signals easier to understand without exposing private session content.

## Windows desktop app

The Windows x64 desktop app is available now. [Download Pomegr](https://pomegr.com/download)
and follow [Install Pomegr](docs/public/get-started/install.md) to choose the
installer or portable app and get started. Neither download needs Node.js setup.

The desktop app includes opt-in phone access under **Settings → Phone access**. Pair a
phone browser by QR code on the same trusted private network. Sharing is off by default
and uses unencrypted HTTP; see [Phone access](docs/public/using-pomegr/phone-access.md).

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

For a bounded current health snapshot, attach the passive diagnostics reader from a
second shell:

```powershell
npm run diagnostics:snapshot
```

Add `--json` for machine-readable output or `--provider codex` to filter one provider.
See [Pipeline operations](docs/internal/operations/pipeline-diagnostics.md) for the bounded diagnostic
contract, continuous local JSONL logs, and live/historical analysis.

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
[context, input, output, and cache tokens](docs/public/concepts/context-and-tokens.md).
The [maintainer index](docs/internal/README.md) maps technical contracts,
development workflows, and release procedures.

## How to contribute

Start with the [contribution guide](CONTRIBUTING.md), then open an [issue](https://github.com/Lecarvalho/pomegr/issues) before proposing a substantial change.

## Coding-agent plugins

Open **Repositories**, select a repository, and use its **Plugin** and **Reporting**
tabs to check the plugin and the reporting policy. Plugin changes and inventory
captures require confirmation in Pomegr desktop; browser and phone clients show setup
guidance.

- [Install the Pomegr reporting plugin for Codex or Claude Code](docs/public/using-pomegr/reporting-plugins.md)

## Publish procedures

- **Skill changes:** Edit the canonical skill sources and regenerate both provider packages; follow [Skill changes](docs/internal/development/plugins.md#skill-changes).
- **Plugin upgrade:** Bump the shared Claude and Codex plugin version and rebuild both packages; follow [Plugin upgrade](docs/internal/development/plugins.md#plugin-upgrade).
- **Desktop release versioning and publish:** bump the package version by hand and push it to `main`, then `npm run release:windows -- --tag vX.Y.Z` pushes the immutable tag for that commit and dispatches the workflow that publishes the signed Windows artifacts. See [Publish signed artifacts](docs/internal/operations/desktop-releases.md#publish-signed-artifacts).
- **Public landing site:** Deploy the independently audited Cloudflare Worker artifact; follow [Release the exact audited artifact](docs/internal/operations/website.md#5-release-the-exact-audited-artifact).

## Current limitations

- Desktop downloads are currently available for Windows x64 only.
- Claude Code and Codex expose different amounts of session data; see
  [Limitations](docs/internal/architecture/limitations.md) for provider-related
  and Pomegr-specific limits.
- Efficiency signals are deterministic heuristics, not authoritative judgments.

## Licence

Pomegr is licensed under [AGPL-3.0-only](LICENSE). See the [license history](docs/internal/decisions/license-history.md) and [trademark policy](TRADEMARKS.md) for details.
