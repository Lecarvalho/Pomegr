# Pomegr for Codex

Pomegr is a local-first, read-only observer for coding-agent sessions. This plugin loads a repository-owned reporting policy, lets Codex report bounded project-specific signals, and exposes read-only queries over normalized observations already committed by the local Pomegr monitor.

`add_task` adds a task to the current repository's Pomegr board, in the first column, not queued; it does not start anything. Its optional `remote_control` asks that the task's Claude Code session start with Remote Control on, so the user can also open it on their phone. Adding the same text to the same feature again within five minutes returns the task already added instead of a second one. `update_task` changes a task of the board that has not started (its text, provider and model, effort, or Complete when); a value it sets replaces the stored one, so the agent reads the task first. `get_task` reads one task of the board by its ID (its text, column, state, whether `update_task` can change it, feature, provider, model, effort, and Complete when), and `list_tasks` lists at most 100 tasks of the board in board order with each text cut at 300 characters, narrowed by a part of the text, a state, a feature, or whether `update_task` can change them; both only read. `remove_task` deletes a task the same session added, such as a duplicate, while that task has not started; it cannot be undone, and it never removes a task the user or another session added. `get_feature` reads a feature of the board (its title, description, and app version), by default the feature of the task the session was started for; `create_feature`, `update_feature`, and `delete_feature` change the board's features, and `delete_feature` removes only a feature that has no task.

In a session that Pomegr started for a task, `complete_task` reports the task complete, optionally with one line that names what needs the user's attention, and Pomegr then verifies the conditions the user checked; `block_task` reports that the agent cannot continue, with a one-line reason. `assign_task` assigns the session to another task of the board that is not done, such as one whose first session stopped, so the session can report that task too; it changes no state and starts nothing, and `unassign_task` takes the assignment back. Each session reports a task once, the first report on a task wins, and a session with more than one task names the task with `task_id`.

When the Pomegr desktop app starts a session for a task, that session carries a one-time dispatch token in its environment. At startup the plugin sends the token and the new session's ID to the local monitor so the board can show which session works on which task. Sessions started any other way send nothing, and the hook prints nothing.

The plugin does not send transcript contents, source code, prompts, responses, commands, tool output, or provider credentials to Pomegr. Reporting remains opt-in per repository through `.pomegr/signals.md`, and query tools fail closed when the local observer is unavailable.

## Get started

1. Install and run Pomegr on the same computer as Codex.
2. Install this plugin and restart Codex.
3. Run `$pomegr:init` in a repository to review and create its reporting policy.
4. Run `$pomegr:doctor` for a read-only setup check.

Documentation and source are available in the [Pomegr repository](https://github.com/Lecarvalho/pomegr). Report problems through [GitHub Issues](https://github.com/Lecarvalho/pomegr/issues).
