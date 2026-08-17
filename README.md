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

## Windows desktop app (soon)

On Windows x64, download and run the installer from the [latest release](https://github.com/Lecarvalho/pomegr/releases/latest).

LAN sharing is unavailable in the Windows desktop app.

## Portable beta (soon)

Download the [latest release](https://github.com/Lecarvalho/pomegr/releases/latest) and run it.

## How to contribute

Start with the [contribution guide](CONTRIBUTING.md), then open an [issue](https://github.com/Lecarvalho/pomegr/issues) before proposing a substantial change.

## Current limitations

- The desktop app currently supports Windows x64 only.
- Claude Code and Codex expose different amounts of session data.
- Efficiency signals are deterministic heuristics, not authoritative judgments.

## Licence

Pomegr is licensed under [AGPL-3.0-only](LICENSE). See the [license history](docs/LICENSE_HISTORY.md) and [trademark policy](TRADEMARKS.md) for details.
