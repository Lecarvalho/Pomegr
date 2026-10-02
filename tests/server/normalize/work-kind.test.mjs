import assert from "node:assert/strict";
import test from "node:test";
import { executionWorkKind, normalizedWorkKind, toolWorkKind, WORK_KINDS } from "../../../server/normalize/work-kind.mjs";

test("classifies only recognized monitor-private shell structures", () => {
  const cases = [
    ["git status --short", "git"],
    ["git push origin main", "git_push"],
    ["gh pr view 701", "pull_request"],
    ["npm run test", "test"],
    ["npm run build", "build"],
    ["restart-pomegr.ps1", "process"],
    ["rg --files app", "search"],
    ["Get-Content README.md", "read"],
    ["custom-private-tool --opaque", "shell"],
  ];
  for (const [command, expected] of cases) assert.equal(executionWorkKind(command), expected);
  assert.equal(executionWorkKind({ action: { command: "git push" } }), "git_push");
  assert.doesNotMatch(JSON.stringify(cases.map(([command]) => executionWorkKind(command))), /private-tool|opaque/);
});

test("a Git command is classified by its subcommand, not by words in its arguments", () => {
  const cases = [
    ["git commit -m \"fix push bug\"", "git"],
    ["git log --grep push", "git"],
    ["git -C repo push", "git_push"],
    ["git -c core.autocrlf=false status", "git"],
    ["git stash", "git"],
    ["git cherry-pick abc", "git"],
    ["git worktree add ../tree", "git"],
    ["node -e \"console.log('git push')\"", "shell"],
    ["cat digit status", "read"],
    ["ls .git hooks", "search"],
  ];
  for (const [command, expected] of cases) assert.equal(executionWorkKind(command), expected, command);
});

test("a program classifies a command only where a command can start", () => {
  const cases = [
    ["echo 'rg is a search tool'", "shell"],
    ["node scripts/timeout-check.mjs", "shell"],
    ["timeout 30 npm run foo", "shell"],
    ["timeout 30 npm test", "test"],
    ["timeout /t 5", "wait"],
    ["Start-Sleep 5", "wait"],
    ["npm view curl", "shell"],
    ["echo hi; rg foo", "search"],
    ["cd app && ls -la", "search"],
    ["find . -name '*.ts'", "search"],
    ["cat README.md", "read"],
    ["tail -f server.log", "read"],
    ["Get-Content restart-pomegr.ps1", "read"],
    ["kill 123", "process"],
    ["taskkill /PID 1", "process"],
    ["go test ./...", "test"],
    ["npx playwright test", "test"],
    ["curl https://example.test", "web"],
    ["$body = Invoke-RestMethod https://example.test", "web"],
    ["$lines = Get-Content a.txt", "read"],
    ["npm ci", "shell"],
    ["gh issue list", "shell"],
  ];
  for (const [command, expected] of cases) assert.equal(executionWorkKind(command), expected, command);
  // Codex records a command as a launcher argument array; the script starts on its own line.
  assert.equal(executionWorkKind({ command: ["pwsh.exe", "-Command", "git push origin main"] }), "git_push");
  assert.equal(executionWorkKind({ command: ["pwsh.exe", "-NoProfile", "-Command", "rg foo"] }), "search");
});

test("maps structured tool identities to bounded provider-neutral work kinds", () => {
  const cases = [
    // Claude Code tools.
    ["Read", "read"], ["Write", "write"], ["Edit", "write"], ["MultiEdit", "write"], ["NotebookEdit", "write"],
    ["Grep", "search"], ["Glob", "search"], ["ToolSearch", "search"], ["WebFetch", "web"], ["WebSearch", "web"],
    ["Agent", "agent"], ["Task", "agent"], ["Workflow", "agent"], ["SendMessage", "agent"], ["ListAgents", "agent"],
    ["TaskCreate", "plan"], ["TaskUpdate", "plan"], ["TodoWrite", "plan"], ["ExitPlanMode", "plan"],
    ["TaskStop", "process"], ["KillShell", "process"], ["TaskOutput", "process"],
    ["Monitor", "wait"], ["ScheduleWakeup", "wait"], ["Skill", "skill"], ["AskUserQuestion", "input"],
    ["SendUserFile", "transfer"], ["EnterWorktree", "git"],
    // Labels the Codex adapter authors.
    ["File change", "write"], ["Web search", "web"], ["View image", "image"], ["Image generation", "image"],
    ["Tool search", "search"], ["Spawn agent", "agent"], ["Send to agent", "agent"], ["Stop agent", "agent"],
    ["Resume agent", "agent"], ["List agents", "agent"], ["Wait for agent", "wait"], ["Wait", "wait"],
    ["Request input", "input"], ["Plan update", "plan"], ["Shell input", "process"], ["Message to user", "reply"],
    // Monitor-authored activity rows.
    ["User input", "input"], ["Assistant replied", "reply"], ["Summary updated", "reply"],
  ];
  for (const [tool, expected] of cases) assert.equal(toolWorkKind(tool), expected, tool);
  assert.equal(toolWorkKind("Shell", { input: { command: "git status" } }), "git");
  assert.equal(toolWorkKind("Bash", { input: { command: "npm test" } }), "test");
  assert.equal(toolWorkKind("PowerShell", { input: { command: "Get-Content a.txt" } }), "read");
  assert.equal(normalizedWorkKind("not-a-kind", "integration"), "integration");
  assert.deepEqual(WORK_KINDS.slice(-3), ["reply", "plan", "other"]);
});

test("an unrecognized tool is other, and free-text detail never classifies a tool", () => {
  for (const tool of ["future_tool", "Artifact", "CronCreate", "SendFeedback"]) assert.equal(toolWorkKind(tool), "other", tool);
  // A description, subject, file name or label says nothing about the kind of work.
  assert.equal(toolWorkKind("Agent", { detail: "Review git history and push" }), "agent");
  assert.equal(toolWorkKind("TaskCreate", { detail: "Fix PR review comments" }), "plan");
  assert.equal(toolWorkKind("future_tool", { detail: "search the web and build" }), "other");
  for (const detail of ["skill-usage.mjs", "wait-helper.ts", "git-status.md", "pull-request-view.tsx", "screenshot.png"]) {
    assert.equal(toolWorkKind("Edit", { detail }), "write");
    assert.equal(toolWorkKind("Read", { detail }), "read");
    assert.equal(toolWorkKind("File change", { detail }), "write");
  }
});

test("a carried MCP or dynamic tool is an integration unless its exact identity is allowlisted", () => {
  const report = ["report_session_progress", "report_session_signal", "report_agent_signal", "report_task_signal",
    "clear_session_progress", "clear_session_signal", "clear_agent_signal"];
  for (const tool of report) {
    assert.equal(toolWorkKind(`mcp__plugin_pomegr_pomegr__${tool}`), "report", tool);
    assert.equal(toolWorkKind("MCP", { detail: `pomegr / ${tool}` }), "report", tool);
  }
  // The Pomegr read tools and a lookalike on another server are ordinary integrations.
  assert.equal(toolWorkKind("mcp__plugin_pomegr_pomegr__rename_session"), "integration");
  assert.equal(toolWorkKind("MCP", { detail: "pomegr / get_session_report" }), "integration");
  assert.equal(toolWorkKind("MCP", { detail: "other / report_session_signal" }), "integration");

  assert.equal(toolWorkKind("mcp__github__create_pull_request"), "pull_request");
  assert.equal(toolWorkKind("MCP", { detail: "github / list_pull_requests" }), "pull_request");
  assert.equal(toolWorkKind("MCP", { detail: "codex_apps / github.get_pr_info" }), "pull_request");
  assert.equal(toolWorkKind("MCP", { detail: "codex_apps / github.fetch_pr_file_patch" }), "pull_request");

  // A tool name that merely resembles a kind stays an integration.
  const integrations = [
    ["mcp__github__get_file_contents", ""], ["mcp__github__search_code", ""], ["mcp__plugin_slack_slack__slack_send_message", ""],
    ["mcp__claude-in-chrome__navigate", ""], ["mcp__other__list_prs", ""],
    ["MCP", "codex_apps / github.fetch_file"], ["MCP", "codex_apps / github.search"], ["MCP", "codex_app / read_thread"],
    ["MCP", "codex_app / wait_threads"], ["MCP", "openaiDeveloperDocs / search_openai_docs"], ["MCP", "docs / build_guide"],
    ["MCP", "fs / write_file"], ["MCP", "cua_repl / js"], ["Dynamic tool", "exec"], ["Dynamic tool", "codex_app / list_threads"],
  ];
  for (const [tool, detail] of integrations) assert.equal(toolWorkKind(tool, { detail }), "integration", `${tool} ${detail}`);
});
