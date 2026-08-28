import assert from "node:assert/strict";
import test from "node:test";
import { executionWorkKind, normalizedWorkKind, toolWorkKind } from "../monitor/work-kind.mjs";

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

test("maps structured tool identities to bounded provider-neutral work kinds", () => {
  assert.equal(toolWorkKind("Write"), "write");
  assert.equal(toolWorkKind("SendUserFile"), "transfer");
  assert.equal(toolWorkKind("Skill"), "skill");
  assert.equal(toolWorkKind("mcp__plugin_pomegr_pomegr__report_session_progress"), "report");
  assert.equal(toolWorkKind("Shell", { input: { command: "git status" } }), "git");
  assert.equal(toolWorkKind("MCP", { detail: "github / list_pull_requests" }), "pull_request");
  assert.equal(toolWorkKind("future_tool"), "shell");
  assert.equal(normalizedWorkKind("not-a-kind", "integration"), "integration");
});
