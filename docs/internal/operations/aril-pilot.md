# Validate the temporary Aril pilot

> Scope: local update and real-provider acceptance for the finite multi-repository pilot.
> Authority: operational procedure. [Agent chat](../architecture/agent-chat.md#temporary-autonomous-pilot) owns behavior and privacy.
> Related checks: [Agent workflow](../development/agent-workflow.md#focused-verification).

## Update locally

Use the reviewed branch before merge, or `origin/main` after merge. Do not replace local plans or other uncommitted documents.
The broad `aril.md` proposal remains context, not authorization for other features.
Keep the current desktop running until you are ready to replace it. A build does not activate a pilot.

1. Fetch the reviewed commit and create a separate checkout.
2. Install both dependency trees and run the required verification.
3. Build the desktop services from the verified web build.
4. Close the existing desktop yourself, then launch this checkout's desktop.

```powershell
git fetch origin
git worktree add C:/Workspace/repos/pomegr-aril-pilot origin/tasks/T-158
Set-Location C:/Workspace/repos/pomegr-aril-pilot
npm ci
npm ci --prefix landing
npm run build
npm test
npm run verify:fast
npm run desktop:prepare:from-build
npx electron .
```

Choose a different empty checkout path if this example path already exists.
After merge, replace `origin/tasks/T-158` with `origin/main`.
Do not publish a release, change a tag, or activate a grant as part of updating.
The feature name is Aril 0.9.0; this change does not itself change the app version.

## Prepare tomorrow's scopes

For each repository, select a small set of existing, low-risk tasks whose starts you authorize.
There may be one nonterminal grant per repository; a paused or needs-you grant occupies that slot until it is revoked, finished, or expires. Each grant has its own objective, deadline, provider/model permissions, and inference and start budgets; the desktop shares one inference slot and the dispatcher's existing launch slot across all grants.
Inspect each task's **Run on**, model, effort, dependencies, and completion conditions before selecting it.
Leave explicit provider choices intact. Include both providers only when your permitted work calls for them.
Provider success is not a required demonstration; an accurate quota wait is a valid outcome.

Open **Aril pilot** on each repository board, enter that grant's objective, and select its finite task set.
Choose an inference provider/model with current capacity and an allowed task provider/model list.
Review the displayed deadline, granted actions, and every limit before confirming.
Confirm each grant separately. A phone can review and confirm a grant through the authenticated paired-device route; the desktop remains open to coordinate decisions and starts.

## Check the real loop

1. For each grant, confirm that the first recorded decision names its evidence revision, chosen provider/model, and reason.
2. Close the pilot panel. Verify later that the desktop continues to observe and record results.
3. Send an ordinary chat message during a round. Confirm that the interactive answer takes priority.
4. When quota blocks a configured provider, confirm a wait rather than substitution or threshold bypass.
5. After its predicted reset, confirm a new quota observation before any start becomes eligible.
6. Inspect a dependent task. A human decision must hold its dependent work without inventing completion.
7. Pause or revoke the grant. Confirm that no new pilot effect occurs and running sessions continue.
8. Reopen the panel and read receipts, used limits, needs-you states, and the persistent summary.

The pilot never marks a task done. Resolve review and completion on the board yourself.
Do not force a provider or weaken a quota threshold to obtain a successful demonstration.
When all eligible work is held, the correct result is a visible wait or a request for your decision.

## Recover an uncertain start

A crash or ambiguous launcher result can leave a durable attempt without a confirmed result.
The pilot must show **Needs you** and must not retry that task automatically.
Inspect the task, linked session, terminal, and board before deciding whether an actual session started.
For an unbound uncertain start, select **Reconcile T-n** only after confirming that no session started.
This action requeues the task through the board and revokes the grant. It never stops a session.
For a linked session, use the board's existing owner resolution controls after inspection.
Review and confirm any replacement grant separately. A new grant does not erase an unresolved dispatch claim or its receipt.

This procedure validates the real loop after implementation. Synthetic tests cover safety and isolation before the first real activation.
