# Pomegr for Claude Code

Pomegr is a local-first, read-only observer for coding-agent sessions. This plugin loads a repository-owned reporting policy, lets Claude Code report bounded project-specific signals, and exposes read-only queries over normalized observations already committed by the local Pomegr monitor.

The plugin does not send transcript contents, source code, prompts, responses, commands, tool output, or provider credentials to Pomegr. Reporting remains opt-in per repository through `.pomegr/signals.md`, and query tools fail closed when the local observer is unavailable.

## Get started

1. Install and run Pomegr on the same computer as Claude Code.
2. Install this plugin and reload plugins.
3. Run `/pomegr:init` in a repository to review and create its reporting policy.
4. Run `/pomegr:doctor` for a read-only setup check.

Documentation and source are available in the [Pomegr repository](https://github.com/Lecarvalho/pomegr). Report problems through [GitHub Issues](https://github.com/Lecarvalho/pomegr/issues).
