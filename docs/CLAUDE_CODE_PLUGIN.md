# Claude Code plugin milestone

## Status

Packaging Threadlight as a Claude Code plugin is a future distribution milestone. The first version of repository-specific signal configuration will be installed and configured manually so the signal contract and onboarding flow can settle before they become a published package.

This document is provider-specific packaging guidance. Threadlight's monitor, normalized state, and signal model remain provider-neutral.

## Manual V1

V1 keeps each part explicit:

1. Register the Threadlight MCP server from the target repository:

   ```powershell
   claude mcp add --transport stdio --scope local threadlight -- node "C:\path\to\threadlight\mcp\server.mjs"
   ```

2. Copy the signal-configuration skill from the Threadlight checkout into the target repository's `.claude/skills/` directory once that skill is implemented.
3. Invoke the copied skill to create or update `.threadlight/signals.md`.
4. Review the generated policy and commit it when the repository's signal vocabulary should be shared with collaborators.
5. Check the MCP connection with `/mcp` before relying on reported signals.

The repository policy is guidance for agents, not an application-level enum. Threadlight should continue accepting any signal that satisfies its universal label, tone, privacy, and target constraints. Updating the policy must not invalidate signals recorded in historical transcripts.

The planned policy distinguishes:

- session-wide signals reported through `report_session_signal`
- agent-specific signals reported through `report_agent_signal`
- task-specific signals reported through `report_task_signal`
- the allowed or recommended labels, semantic tones, and conditions for reporting each label

The setup skill should be idempotent. When `.threadlight/signals.md` is absent, it performs onboarding; when the file exists, it reviews or updates the policy without replacing it blindly.

## Plugin milestone

The later plugin should make the MCP server and onboarding skill installable as one unit:

```text
threadlight/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── claude-code/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .mcp.json
        ├── mcp/
        │   └── server.mjs
        └── skills/
            └── configure-signals/
                └── SKILL.md
```

The plugin MCP configuration should use Claude Code's portable paths:

```json
{
  "mcpServers": {
    "threadlight": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"],
      "cwd": "${CLAUDE_PROJECT_DIR}"
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` locates the cached plugin installation. `${CLAUDE_PROJECT_DIR}` gives the MCP server the repository whose `.threadlight/signals.md` policy applies.

### Packaging requirements

Before publishing:

- Make the MCP runtime self-contained inside `plugins/claude-code/`. Installed plugins cannot import files from elsewhere in the Threadlight checkout.
- Package or install the MCP server's Node dependencies without relying on Threadlight's development `node_modules` directory.
- Keep generated policy files in the target repository, never in the plugin cache.
- Make missing or malformed repository policy degrade to the generic signal behavior.
- Include the configuration skill and MCP server in the same plugin.
- Test locally with `claude --plugin-dir ./plugins/claude-code`.
- Validate the package with `claude plugin validate ./plugins/claude-code`.
- Verify installation, `/reload-plugins`, `/mcp`, onboarding, live signals, and historical reconstruction from a clean target repository.

### Marketplace publishing

The Threadlight repository can host its own marketplace through `.claude-plugin/marketplace.json`. Once pushed to GitHub, users would install it with:

```text
/plugin marketplace add Lecarvalho/threadlight
/plugin install threadlight@threadlight
/reload-plugins
/threadlight:configure-signals
```

During active development, omit an explicit plugin version so Claude Code uses the Git commit as the resolved version. Add semantic versioning only when releases are intentionally managed, and bump it for every published update.

## References

- [Create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp)
