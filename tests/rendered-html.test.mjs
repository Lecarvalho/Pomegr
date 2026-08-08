import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { USAGE_REFRESH_INTERVAL_MS, usageRefreshDelay } from "../app/usage-refresh.mjs";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders Threadlight", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Threadlight<\/title>/i);
  assert.match(html, /Threadlight/);
  assert.match(html, /LIVE SESSION OBSERVER/);
  assert.doesNotMatch(html, />ALL-AGENT CONTEXT</);
  assert.match(html, /CONTEXT GROWTH/);
  assert.match(html, /Context added over time/);
  assert.match(html, /Usage limits/);
  assert.match(html, /Generate report/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the privacy explanation on the about page", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /About · Threadlight/);
  assert.match(html, /Watching Claude Code quietly/);
  assert.match(html, /Prompt and response text stay out of the dashboard/);
  assert.match(html, /Back to dashboard/);
});

test("uses one provider-neutral identity and no starter preview", async () => {
  const [page, layout, packageJson, dashboard, styles, stateRoute, sessionsRoute, monitor] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(packageJson, /"name": "threadlight"/);
  assert.doesNotMatch(packageJson, /claude-session-coach|session-pulse|react-loading-skeleton/);
  assert.match(page, /<Dashboard \/>/);
  assert.match(layout, /title: "Threadlight"/);
  assert.match(dashboard, /\$\{agent\.status\}Agent/);
  assert.match(styles, /\.agentRow\.idleAgent/);
  assert.match(styles, /\.agentRow\.finishedAgent/);
  assert.match(styles, /\.agentRow\.stoppedAgent/);
  assert.match(styles, /\.agentRow\.needs_inputAgent/);
  assert.match(styles, /\.statusPill\.stopped/);
  assert.match(styles, /\.statusPill\.needs_input/);
  assert.match(dashboard, /needs input/);
  assert.match(dashboard, /attentionSessions/);
  assert.match(dashboard, /Claude Code needs your input/);
  assert.doesNotMatch(dashboard, /Open session/);
  assert.match(dashboard, /className="attentionNotice"\s+role="status"/);
  assert.match(styles, /\.attentionNotice/);
  assert.match(dashboard, /data-needs-input/);
  assert.match(dashboard, /gitPathParts/);
  assert.match(styles, /\.gitPathName/);
  assert.match(styles, /\.gitPathName \{ display: block; max-width: none; overflow: visible; white-space: normal/);
  assert.match(styles, /min\(var\(--agent-indent\), 40px\)/);
  assert.match(styles, /\.agentRow time \{ display: block/);
  assert.doesNotMatch(styles, /\.agentRow time \{ display: none/);
  assert.match(dashboard, /agentMetaRuntime/);
  assert.match(dashboard, /agentSignal/);
  assert.match(dashboard, /sessionSignal/);
  assert.match(dashboard, /data\.session\?\.summary\?\.text/);
  assert.match(dashboard, /Provider-generated session summary/);
  assert.match(dashboard, /className="sidebarAboutLink" href="\/about"/);
  assert.doesNotMatch(dashboard, /className="aboutLink"/);
  assert.doesNotMatch(dashboard, /Watching Claude Code quietly/);
  assert.match(styles, /\.heroSummarySource/);
  assert.match(styles, /\.sidebarAboutLink/);
  assert.match(monitor, /summary: latestSessionSummary\(mainRecords\)/);
  assert.match(dashboard, /Reported for this session through the Threadlight MCP tool/);
  assert.match(dashboard, /sessionMetaValues/);
  assert.match(dashboard, /function AgentChip/);
  assert.match(dashboard, /<AgentChip/);
  assert.match(dashboard, /Reported by this agent through the Threadlight MCP tool/);
  assert.match(styles, /\.agentSignal\.positive/);
  assert.match(styles, /\.agentSignal\.negative/);
  assert.match(styles, /\.agentChip \{ min-height: 18px; display: inline-flex; align-items: center/);
  assert.match(styles, /\.agentTitleLine > \.agentSignal \{ flex: 0 0 auto/);
  assert.match(styles, /\.skillPopoverAnchor, \.executionTaskAnchor, \.planTaskAnchor \{ display: flex; align-items: center/);
  assert.match(styles, /display: grid; grid-template-areas: "kind tools" "runtime runtime"/);
  assert.match(styles, /grid-template-rows: auto auto auto/);
  assert.match(styles, /\.agentTitleLine > strong \{ overflow: visible; white-space: normal/);
  assert.match(dashboard, /usageRefreshDelay\(data\.usageLimits\.attemptedAt\)/);
  assert.match(dashboard, /refresh\(true\)/);
  assert.match(dashboard, /clearTimeout\(timeout\)/);
  assert.match(dashboard, /retry failed/);
  assert.match(dashboard, /attemptedAt/);
  assert.doesNotMatch(dashboard, /usageRequested|pageLoadedAt/);
  assert.match(dashboard, /onClick=\{\(\) => refresh\(false\)\}/);
  assert.match(dashboard, /SESSION MACHINERY/);
  assert.match(dashboard, /Loaded machinery/);
  assert.match(dashboard, /Machinery token load/);
  assert.match(dashboard, /MACHINERY BREAKDOWN/);
  assert.match(dashboard, /Token inventory/);
  assert.match(dashboard, /contextMachinery\.machineryTokens/);
  assert.doesNotMatch(dashboard, /firstRequestFootprint|First request input|Includes first prompt/);
  assert.match(styles, /\.machineryStat/);
  assert.match(dashboard, /View loaded machinery/);
  assert.match(dashboard, /Run \/context to measure loaded machinery/);
  assert.match(dashboard, /contextMachinery\.groups/);
  assert.match(dashboard, /provider estimates/);
  assert.match(styles, /\.machineryPopover/);
  assert.match(styles, /\.machineryStat \{ position: relative/);
  assert.match(dashboard, /metricPopover machineryPopover/);
  assert.match(dashboard, /machineryPopoverBody/);
  assert.match(styles, /\.machineryGroup/);
  assert.match(monitor, /readLatestContextMachinery\(mainFile\)/);
  assert.match(dashboard, /tokenHistogramTitle/);
  assert.doesNotMatch(dashboard, /className=\{`panel tokenPanel/);
  assert.match(dashboard, /activitySegment inputSegment/);
  assert.match(dashboard, /activitySegment cacheWriteSegment/);
  assert.match(dashboard, /activitySegment cacheReadSegment/);
  assert.match(dashboard, /activitySegment outputSegment/);
  assert.match(dashboard, /contextGrowthTimeline/);
  assert.match(dashboard, /Context growth composition legend/);
  assert.match(dashboard, /compactNumber\(currentTokens\.input\)/);
  assert.match(dashboard, /compactNumber\(currentTokens\.cacheWrite\)/);
  assert.match(dashboard, /compactNumber\(currentTokens\.cacheRead\)/);
  assert.match(dashboard, /compactNumber\(currentTokens\.output\)/);
  assert.doesNotMatch(dashboard, /className="tokenStat"/);
  assert.match(dashboard, /positive change in latest snapshots/);
  assert.match(dashboard, /Recent activity/);
  assert.match(dashboard, /Tool and user activity will appear here/);
  assert.match(dashboard, /event\.status === "failed"/);
  assert.match(styles, /\.activityRow\.failed/);
  assert.match(monitor, /userInputContentType\(record, requestedInputIds\)/);
  assert.match(monitor, /shellFailureActivityEvents\(executionTasks, primaryActor\)/);
  assert.match(monitor, /actor: "User"/);
  assert.match(monitor, /tool: "User input"/);
  assert.match(monitor, /detail: userInputType/);
  assert.doesNotMatch(dashboard, /Recorded token activity|TOKEN ACTIVITY|not billed spend/);
  assert.doesNotMatch(dashboard, /contextStepArea|stepHitArea/);
  assert.doesNotMatch(dashboard, /data\.metrics\.tokens\.(?:total|cumulative|lastMinute)/);
  assert.doesNotMatch(dashboard, /Token spend|session total|recorded total/);
  assert.match(dashboard, /running now/);
  assert.match(dashboard, /wall time/);
  assert.match(dashboard, /executionTaskTrigger/);
  assert.match(dashboard, /executionTaskPopover/);
  assert.match(dashboard, /EXECUTION TASKS/);
  assert.match(dashboard, /Background tasks/);
  assert.match(dashboard, /Running execution tasks/);
  assert.match(dashboard, /Finished execution tasks/);
  assert.match(styles, /\.executionTaskPopover/);
  assert.match(styles, /\.executionTaskRow\.running/);
  assert.match(dashboard, /executionTaskSignal/);
  assert.match(dashboard, /Reported for this task through the Threadlight MCP tool/);
  assert.match(styles, /\.agentSignal, \.executionTaskSignal, \.sessionSignal/);
  assert.match(styles, /\.executionTaskTitleLine/);
  assert.match(monitor, /agent\.executionTasks = file/);
  assert.match(monitor, /buildExecutionTasks\(recordsByFile\.get\(file\)/);
  assert.match(dashboard, /executionTasksByAgent\.get\(agent\.id\)/);
  assert.doesNotMatch(dashboard, /agent\.id === "primary" && executionTasks\.length/);
  assert.match(monitor, /taskSignals/);
  assert.match(dashboard, /planTaskTrigger/);
  assert.match(dashboard, /planTaskPopover/);
  assert.match(dashboard, /CLAUDE PLAN/);
  assert.match(dashboard, /Agent-maintained checklist/);
  assert.match(dashboard, /Claude may forget/);
  assert.match(styles, /\.planTaskPopover/);
  assert.match(styles, /\.planTaskCaution/);
  assert.match(monitor, /planTasks: readSessionTasks\(TASKS_ROOT, sessionId\)/);
  assert.match(dashboard, /skillPopoverTrigger/);
  assert.match(dashboard, /SKILL USAGE/);
  assert.match(dashboard, /normalized metadata only/);
  assert.match(styles, /\.skillPopover/);
  assert.match(monitor, /skills: buildSkillUsage\(records\)/);
  assert.match(monitor, /signal: signalsByFile\.get\(file\)\?\.agent \|\| null/);
  assert.match(monitor, /signal: sessionSignal/);
  assert.doesNotMatch(monitor, /signal: file === mainFile \? null/);
  assert.match(monitor, /tool === "Skill" \? normalizedSkillName\(input\)/);
  assert.match(monitor, /buildContextGrowthTimeline/);
  assert.match(dashboard, /buildSessionReport/);
  assert.doesNotMatch(dashboard, /REPEATED CALLS|loopMetric|loop-patterns-popover/);
  assert.match(dashboard, /SESSION ID/);
  assert.match(dashboard, /HISTORICAL SESSION/);
  assert.match(dashboard, /historySessions/);
  assert.match(dashboard, /liveSessions\.map/);
  assert.match(dashboard, /selectedIsHistorical/);
  assert.match(dashboard, /LIVE SESSIONS/);
  assert.match(dashboard, /groupSessionsByProject/);
  assert.match(styles, /\.sessionSidebar/);
  assert.match(styles, /\.historyProjectHeader/);
  assert.match(dashboard, /const collapsed = !expandedHistoryProjects\.has\(group\.project\)/);
  assert.match(dashboard, /aria-expanded=\{!collapsed\}/);
  assert.match(styles, /\.historyProject\.collapsed/);
  assert.match(styles, /\.scoreRing > div[^}]*flex-direction: column/);
  assert.match(dashboard, /TOOL CALL BREAKDOWN/);
  assert.match(dashboard, /toolPatterns/);
  assert.match(dashboard, /role="dialog"/);
  assert.match(stateRoute, /monitorParams\.set\("refreshUsage", "1"\)/);
  assert.match(stateRoute, /sessionId/);
  assert.match(sessionsRoute, /\/api\/sessions/);
  assert.match(monitor, /historical \? emptyUsageLimits\(\)/);
  assert.match(monitor, /refreshUsage \? await usageLimits\(\) : cachedUsageLimits\(\)/);
  assert.match(monitor, /sanitizedUsageError/);
  assert.match(monitor, /readSessionRegistry/);
  assert.match(monitor, /sessionRegistryEntry\?\.needsInput/);
  assert.match(monitor, /\.\.\.usageCache\.value, attemptedAt:/);
  assert.match(monitor, /error: errorMessage/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("refreshes stale usage immediately and waits out a recent attempt", () => {
  const now = Date.parse("2026-08-06T14:00:00.000Z");
  assert.equal(usageRefreshDelay(null, now), 0);
  assert.equal(usageRefreshDelay("invalid", now), 0);
  assert.equal(usageRefreshDelay("2026-08-06T13:58:59.999Z", now), 0);
  assert.equal(usageRefreshDelay("2026-08-06T13:59:20.000Z", now), 20_100);
  assert.equal(usageRefreshDelay("2026-08-06T14:00:10.000Z", now), USAGE_REFRESH_INTERVAL_MS);
});
