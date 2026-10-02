import assert from "node:assert/strict";
import test from "node:test";
import { executionWorkKind, normalizedWorkKind, toolWorkKind } from "../../../server/normalize/work-kind.mjs";

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

test("a tool's own identity decides its kind, and only a carrier is classified by its detail", () => {
  // A file name or label in the detail never reclassifies a tool that names its own work.
  for (const detail of ["skill-usage.mjs", "wait-helper.ts", "git-status.md", "pull-request-view.tsx", "screenshot.png"]) {
    assert.equal(toolWorkKind("Edit", { detail }), "write");
    assert.equal(toolWorkKind("Read", { detail }), "read");
    assert.equal(toolWorkKind("File change", { detail }), "write");
  }
  // A carrier names nothing itself, so its detail identifies the real tool.
  assert.equal(toolWorkKind("MCP", { detail: "pomegr / report_session_signal" }), "report");
  assert.equal(toolWorkKind("MCP", { detail: "pomegr / report_session_progress" }), "report");
  assert.equal(toolWorkKind("MCP", { detail: "cua_repl / js" }), "integration");
  assert.equal(toolWorkKind("Dynamic tool", { detail: "exec" }), "integration");
});
