import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GENERATED_SKILL_NOTICE,
  readPluginSkillArtifacts,
} from "../scripts/build-plugin-skills.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged skills are deterministic generated outputs of one canonical source", async () => {
  for (const provider of ["codex", "claude"]) {
    const artifacts = await readPluginSkillArtifacts(provider);
    assert.equal(artifacts.length, 3);
    for (const artifact of artifacts) {
      assert.equal(await readFile(artifact.outputFile, "utf8"), artifact.content, path.relative(repositoryRoot, artifact.outputFile));
      if (artifact.outputFile.endsWith("SKILL.md")) {
        assert.equal(artifact.content.split(GENERATED_SKILL_NOTICE).length - 1, 1);
        assert.doesNotMatch(artifact.content, /\{\{\/?(?:codex|claude)\}\}/);
      }
    }
  }
});

test("provider overlays keep runtime-specific instructions while sharing one policy template", async () => {
  const codex = await readPluginSkillArtifacts("codex");
  const claude = await readPluginSkillArtifacts("claude");
  const codexInit = codex.find((artifact) => artifact.outputFile.endsWith(path.join("init", "SKILL.md"))).content;
  const claudeInit = claude.find((artifact) => artifact.outputFile.endsWith(path.join("init", "SKILL.md"))).content;
  const codexDoctor = codex.find((artifact) => artifact.outputFile.endsWith(path.join("doctor", "SKILL.md"))).content;
  const claudeDoctor = claude.find((artifact) => artifact.outputFile.endsWith(path.join("doctor", "SKILL.md"))).content;
  const codexPolicy = codex.find((artifact) => artifact.outputFile.endsWith("policy-template.md")).content;
  const claudePolicy = claude.find((artifact) => artifact.outputFile.endsWith("policy-template.md")).content;

  assert.equal(codexPolicy, claudePolicy);
  assert.match(codexInit, /\$pomegr:init/);
  assert.match(codexDoctor, /SubagentStart/);
  assert.match(codexInit, /usage-guard\.json/);
  assert.match(codexInit, /"mode": "advisory"/);
  assert.match(codexInit, /repository's existing handoff workflow/);
  assert.match(codexInit, /60-second minimum/);
  assert.match(codexDoctor, /optional usage guard/i);
  assert.match(codexDoctor, /no Pomegr handoff directory or ignore rule is required/);
  assert.doesNotMatch(codexInit, /rename_session/);
  assert.match(claudeInit, /\/pomegr:init/);
  assert.match(claudeDoctor, /PreToolUse/);
  assert.match(claudeInit, /usage-guard\.json/);
  assert.match(claudeInit, /repository's existing handoff workflow/);
  assert.match(claudeDoctor, /PostToolBatch/);
  assert.match(claudeDoctor, /no Pomegr handoff directory or ignore rule is required/);
  assert.match(claudeInit, /rename_session/);
  for (const skill of [codexInit, codexDoctor, claudeInit, claudeDoctor]) {
    assert.doesNotMatch(skill, /\.pomegr\/handoffs/);
    for (const tool of ["get_provider_health", "get_usage_limits", "list_sessions", "list_session_agents", "get_agent_context", "get_recent_failures", "get_session_report"]) {
      assert.match(skill, new RegExp(`\\b${tool}\\b`, "u"));
    }
    assert.match(skill, /decision-triggered observations/i);
  }
});
