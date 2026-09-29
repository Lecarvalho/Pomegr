#!/usr/bin/env node
// Post-edit agent hook: after a source edit in a checked tier, run the dependency-boundary and
// architecture checks and report violations back to the agent (exit 2) so it fixes them in the
// same turn. Wired from .claude/settings.json and .codex/hooks.json.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKED = /^(?:server|app|shared|desktop|mcp|scripts|web)\/.+\.(?:mjs|cjs|js|ts|tsx|mts)$/;

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(""));
  });
}

function editedPaths(payload) {
  const input = payload?.tool_input ?? {};
  const direct = [input.file_path, input.path, payload?.tool_response?.filePath].filter((value) => typeof value === "string");
  // Codex apply_patch carries paths only inside the patch text.
  const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
  const fromPatch = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
  return [...direct, ...fromPatch].map((file) => {
    const absolute = path.resolve(repositoryRoot, file);
    return path.relative(repositoryRoot, absolute).split(path.sep).join("/");
  });
}

let payload = null;
try { payload = JSON.parse(await readStdin()); } catch { payload = null; }
const paths = payload ? editedPaths(payload) : [];
if (payload && !paths.some((file) => CHECKED.test(file))) process.exit(0);

const failures = [];
for (const [label, args] of [
  ["check:boundaries", [path.join("node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs"), "vite.config.ts", "server", "app", "shared", "desktop", "web", "mcp", "scripts", "--config", ".dependency-cruiser.cjs", "--output-type", "err"]],
  ["check:architecture", [path.join("scripts", "check-architecture.mjs")]],
]) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) failures.push(`${label} failed:\n${`${result.stdout}${result.stderr}`.trim()}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n\n")}\n`);
  process.exit(2);
}
