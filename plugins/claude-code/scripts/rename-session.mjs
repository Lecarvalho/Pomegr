#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getSessionInfo, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { createSessionTitleRenamer } from "./session-title.mjs";

const RENAME_TOOL_NAMES = new Set([
  "mcp__plugin_pomegr_pomegr__rename_session",
  "mcp__pomegr__rename_session",
]);
const FAILURE_MESSAGE = "Pomegr could not safely rename the current Claude Code session. Continue working; native automatic naming remains available.";

function readPayload() {
  if (process.stdin.isTTY) return null;
  try {
    const raw = fs.readFileSync(0, "utf8");
    const payload = raw.trim() ? JSON.parse(raw) : null;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function runRenameSessionHook(payload, options = {}) {
  if (!payload || !RENAME_TOOL_NAMES.has(payload.tool_name)) return { status: "ignored" };
  if (typeof payload.agent_id === "string" && payload.agent_id) return { status: "unavailable" };

  const renameCurrentSession = createSessionTitleRenamer({
    getSessionInfo: options.getSessionInfo || getSessionInfo,
    renameSession: options.renameSession || renameSession,
  });
  return renameCurrentSession({
    sessionId: payload.session_id,
    directory: options.projectDirectory || process.env.CLAUDE_PROJECT_DIR || payload.cwd,
    title: payload.tool_input?.title,
  });
}

async function main() {
  const result = await runRenameSessionHook(readPayload());
  if (result.status === "renamed" || result.status === "preserved" || result.status === "ignored") return;
  process.stderr.write(`${FAILURE_MESSAGE}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
