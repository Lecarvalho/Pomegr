---
name: git-sync-main
description: Safely synchronize a tracked main branch with its remote while preserving in-progress work. Use when asked to pull, push, or reconcile a local main branch with origin.
---

# Git Sync Main

Synchronize the requested repository branch without discarding work or rewriting published history. This skill is for ordinary tracked-branch synchronization, not history cleanup, force-pushing, or conflict-resolution work.

## Inspect first

Before changing Git state, inspect the current branch, upstream divergence, working-tree/index state, and whether a merge, rebase, cherry-pick, or revert is already in progress. Fetch the tracked remote before judging divergence when a fresh remote view matters.

Never use `reset --hard`, `checkout --`, `restore`, `clean`, force-push, or abort an in-progress operation as part of a sync. Do not treat a dirty index as permission to discard or overwrite work.

## Reconcile deliberately

- If an earlier merge or rebase is in progress, do not start another integration operation. If it has unresolved files, stop and name the conflict state for the user. If it has no unresolved files and the requested synchronization clearly authorizes completion, finalize the existing operation with an accurate merge message, then continue.
- If the branch is only ahead, push it.
- If it is only behind and clean, fast-forward from the tracked remote.
- If it has diverged, preserve any uncommitted work with Git's supported autostash mechanism and rebase the local commit(s) onto the fetched remote when that is safe for the requested branch. If that operation produces conflicts, stop rather than choosing a resolution unilaterally.
- Push only after the local integration completes. Never force-push to make the remote match.

An explicit request to "sync", "pull and push", or "reconcile" authorizes the normal merge/rebase and push needed for that synchronization. Otherwise, restrict the work to inspection and explain what would change.

## Confirm the outcome

After any push, verify that `HEAD` and the tracked upstream agree and report the resulting commit. Confirm whether the worktree is clean; if a preserved autostash could not be reapplied cleanly, stop and report that state instead of altering it further.
