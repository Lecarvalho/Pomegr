# Pomegr for Claude Code

Pomegr is a local-first, read-only observer for coding-agent sessions. This plugin loads a repository-owned reporting policy, lets Claude Code report bounded project-specific signals, and exposes read-only queries over normalized observations already committed by the local Pomegr monitor.

The plugin does not send transcript contents, source code, prompts, responses, commands, tool output, or provider credentials to Pomegr. Reporting remains opt-in per repository through `.pomegr/signals.md`, and query tools fail closed when the local observer is unavailable. Read-only queries connect only to the loopback Pomegr process and use its short-lived local capability; that capability is not an account credential and never leaves the computer.

## Get started

1. Install and run Pomegr on the same computer as Claude Code.
2. Install this plugin and reload plugins.
3. Run `/pomegr:init` in a repository to review and create its reporting policy.
4. Run `/pomegr:doctor` for a read-only setup check.

## Session line

On Claude Code 2.1.288 or newer the plugin draws one quiet line above the prompt, led by the repository's folder name: the main agent's context, its last 5 requests, the agent's own progress estimate, account usage windows, and the subagents of the current prompt. It reads only the figures Claude Code already has for the session, works without the Pomegr app, and never blocks or changes a prompt or tool call. Run `/pomegr-hud` to move or hide it.

Documentation and source are available in the [Pomegr repository](https://github.com/Lecarvalho/pomegr). Report problems through [GitHub Issues](https://github.com/Lecarvalho/pomegr/issues).

## Distribution notes

The included icon is Pomegr's first-party product mark, also used by the app and favicon. The generated JavaScript bundles let the plugin run without installing `node_modules`; their canonical sources, pinned dependency versions, build script, and preserved third-party legal notices are available in the Pomegr repository.
