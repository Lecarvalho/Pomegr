#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  normalizeDescribedSignal,
  normalizeTaskSignal,
  SIGNAL_MAX_DESCRIPTION_LENGTH,
  SIGNAL_MAX_LABEL_LENGTH,
  SIGNAL_TONES,
} from "./signal-contract.mjs";
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from "../scripts/session-title.mjs";

const reportingAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const titleAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const label = z.string().trim().min(1).max(SIGNAL_MAX_LABEL_LENGTH)
  .refine((value) => normalizeDescribedSignal({ label: value, tone: "neutral" }) !== null, "Use one line of plain text without control characters.")
  .describe("Short project-specific status tag.");
const tone = z.enum(SIGNAL_TONES).default("neutral").describe("Semantic tone used to decorate the tag.");
const description = z.string().trim().min(1).max(SIGNAL_MAX_DESCRIPTION_LENGTH)
  .refine((value) => normalizeDescribedSignal({ label: "Signal", description: value }) !== null, "Use one line of plain text without control characters.")
  .describe("Optional bounded tooltip explanation.").optional();
const sessionTitle = z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH)
  .refine((value) => normalizeSessionTitle(value) !== null, "Use one line of plain text without control or bidirectional formatting characters.")
  .describe("Concise, meaningful title for the current Claude Code session.");

function describedSchema() {
  return z.object({ label, tone, description }).strict();
}

function success(text) {
  return { content: [{ type: "text", text }] };
}

function rejected(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

export function buildPomegrMcpServer() {
  const server = new McpServer(
    { name: "pomegr", version: "0.3.1" },
    { instructions: "Follow .pomegr/signals.md when present. Assign a concise native session title through rename_session after the work is clear, preserve any existing custom title, report bounded project-specific transitions, and clear resolved agent or session state when no replacement applies." },
  );

  server.registerTool("report_agent_signal", {
    title: "Report Pomegr agent signal",
    description: "Report one current project-specific status for the calling agent. A later report or clear from this agent replaces it. Never include prompts, responses, secrets, commands, or tool output.",
    inputSchema: describedSchema(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeDescribedSignal(input);
    return signal ? success(`Agent signal reported: ${signal.label} (${signal.tone}).`) : rejected("Signal rejected. Use a plain-text label of 1-20 characters, optional one-line description up to 160 characters, and a supported tone.");
  });

  server.registerTool("report_session_signal", {
    title: "Report Pomegr session signal",
    description: "Report one current project-specific status for the overall session. The latest session report or clear replaces it. Never include prompts, responses, secrets, commands, or tool output.",
    inputSchema: describedSchema(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeDescribedSignal(input);
    return signal ? success(`Session signal reported: ${signal.label} (${signal.tone}).`) : rejected("Signal rejected. Use a plain-text label of 1-20 characters, optional one-line description up to 160 characters, and a supported tone.");
  });

  server.registerTool("report_task_signal", {
    title: "Report Pomegr task signal",
    description: "Report a durable outcome for a recognized execution task. Use the background task ID or Bash tool-use ID. Later reports for the same task replace it; task signals cannot be cleared.",
    inputSchema: z.object({
      task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).describe("Stable execution-task identifier returned by Claude Code."),
      label,
      tone,
    }).strict(),
    annotations: reportingAnnotations,
    _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeTaskSignal(input);
    return signal ? success(`Task signal reported: ${signal.label} (${signal.tone}).`) : rejected("Task signal rejected. Use a safe task ID, a plain-text label of 1-20 characters, and a supported tone.");
  });

  server.registerTool("clear_agent_signal", {
    title: "Clear Pomegr agent signal",
    description: "Remove the calling agent's current project-specific status when it has resolved and no replacement state applies. Does not affect the session or tasks.",
    inputSchema: z.object({}).strict(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Agent signal cleared."));

  server.registerTool("clear_session_signal", {
    title: "Clear Pomegr session signal",
    description: "Remove the overall session's current project-specific status when it has resolved and no replacement state applies. Does not affect agents or tasks.",
    inputSchema: z.object({}).strict(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Session signal cleared."));

  server.registerTool("rename_session", {
    title: "Rename current Claude session",
    description: "Assign one concise, meaningful title to the calling Claude Code session after its purpose is clear. A trusted Pomegr hook binds the request to the current session and preserves any existing custom title.",
    inputSchema: z.object({ title: sessionTitle }).strict(),
    annotations: titleAnnotations,
    _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Session title request handled."));

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(() => buildPomegrMcpServer());
}
