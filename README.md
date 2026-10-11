# Pomegr

Pomegr is a local-first, read-only observer for coding-agent sessions. It shows session
activity and efficiency signals and does not expose private session content.

<p align="center">
  <img src="landing/public/landing/about/observer-principles-signal.webp" alt="A hand-drawn pomegranate connected to four small signal seeds." width="360" />
</p>

## Windows desktop app

[Download Pomegr](https://pomegr.com/download) for Windows x64. Then follow
[Install Pomegr](docs/public/get-started/install.md). The download does not need Node.js.

## Run from source

You need Node.js 22.13 or newer.

```powershell
npm ci
npm run dev
```

Then open [http://localhost:3003](http://localhost:3003).

On Windows, a second `npm run dev` stops the development processes of this checkout
before it starts new ones. It does not stop an unrelated app that uses port 3003 or
4317; startup tells you which port is blocked. On other platforms, stop the previous
instance first.

## Documentation

| Subject | Read |
| --- | --- |
| What Pomegr observes | [Introduction to Pomegr](docs/public/get-started/introduction.md) |
| User guides, concepts, and help | [Documentation index](docs/README.md) |
| Contracts, development, releases, and diagnostics | [Maintainer index](docs/internal/README.md) |
| The reporting plugin for Claude Code and Codex | [Reporting plugins](docs/public/using-pomegr/reporting-plugins.md) |
| Limits of each provider and of Pomegr | [Limitations](docs/internal/architecture/limitations.md) |
| Rules for coding agents | [AGENTS.md](AGENTS.md) |

## Contribute

Read the [contribution guide](CONTRIBUTING.md). Open an
[issue](https://github.com/Lecarvalho/pomegr/issues) before you propose a large change.

## Licence

Pomegr is licensed under [AGPL-3.0-only](LICENSE). See the
[license history](docs/internal/decisions/license-history.md) and the
[trademark policy](TRADEMARKS.md).
