export const WORK_KINDS = Object.freeze([
  "shell",
  "search",
  "read",
  "write",
  "test",
  "build",
  "git",
  "git_push",
  "pull_request",
  "process",
  "web",
  "image",
  "input",
  "transfer",
  "skill",
  "report",
  "agent",
  "integration",
  "wait",
]);

const WORK_KIND_SET = new Set(WORK_KINDS);

export function normalizedWorkKind(value, fallback = "shell") {
  return WORK_KIND_SET.has(value) ? value : fallback;
}

function commandText(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => commandText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  return [
    value.command,
    value.cmd,
    value.action,
    value.commands,
    value.commandActions,
    value.parsed_cmd,
    value.parsedCmd,
  ].map((item) => commandText(item, depth + 1)).filter(Boolean).join("\n");
}

/**
 * Reduce monitor-private shell evidence to one bounded, provider-neutral purpose.
 * The command itself is never retained or returned by this module.
 */
export function executionWorkKind(command) {
  const value = commandText(command).toLowerCase();
  if (!value) return "shell";

  if (/\bgh(?:\.exe)?\s+pr\b/.test(value)) return "pull_request";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,200}\bpush\b/.test(value)) return "git_push";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,200}\b(?:status|diff|log|show|branch|rev-parse|remote|fetch|add|commit|pull|restore|checkout|switch|merge|rebase)\b/.test(value)) return "git";
  if (/\b(?:npm(?:\.cmd)?\s+(?:run\s+)?test|node\s+--test|vitest|jest|pytest|cargo\s+test|dotnet\s+test)\b/.test(value)) return "test";
  if (/\b(?:npm(?:\.cmd)?\s+run\s+(?:lint|typecheck|check)|eslint|tsc)\b/.test(value)) return "test";
  if (/\b(?:npm(?:\.cmd)?\s+run\s+build|vinext\s+build|vite\s+build|next\s+build|cargo\s+build|dotnet\s+build)\b/.test(value)) return "build";
  if (/restart-pomegr|\brestart-service\b|\bstart-process\b|\bstop-process\b|\bnpm(?:\.cmd)?\s+run\s+dev\b/.test(value)) return "process";
  if (/\b(?:rg|grep|findstr)(?:\.exe)?\b|\bselect-string\b|\bget-childitem\b/.test(value)) return "search";
  if (/\bget-content\b|\bread-file\b/.test(value)) return "read";
  if (/\binvoke-(?:restmethod|webrequest)\b|\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b/.test(value)) return "web";
  if (/\b(?:start-sleep|sleep|timeout)\b/.test(value)) return "wait";
  return "shell";
}

/** Normalize a provider tool identity without asking React to interpret provider text. */
export function toolWorkKind(tool, { detail = "", input = null } = {}) {
  const name = String(tool || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const context = `${name} ${String(detail || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")}`;

  if (/reportsessionprogress|reportsessionsignal|reportagentsignal|reporttasksignal|clearsessionprogress/.test(context)) return "report";
  if (/senduserfile|filetransfer|uploadfile|downloadfile/.test(context)) return "transfer";
  if (/pullrequest|pull\s+requests?|\bpr\b/.test(context)) return "pull_request";
  if (/gitpush/.test(context)) return "git_push";
  if (/git|versioncontrol/.test(context)) return "git";
  if (/imagegen|imagegeneration|viewimage|imageview|screenshot/.test(context)) return "image";
  if (/websearch|webrun|browser|openpage|findinpage/.test(context)) return "web";
  if (/requestinput|requestuserinput|askuserquestion|userinput/.test(context)) return "input";
  if (/spawnagent|sendtoagent|sendmessage|followuptask|resumeagent|stopagent|interruptagent/.test(context)) return "agent";
  if (/waitforagent|waitagent|sleep|wait/.test(context)) return "wait";
  if (/skill/.test(context)) return "skill";
  if (/applypatch|filechange|\bwrite\b|\bedit\b|notebookedit/.test(context)) return "write";
  if (/\bread\b|viewfile|openfile/.test(context)) return "read";
  if (/toolsearch|searchworkspace|\bgrep\b|\bglob\b|\bsearch\b/.test(context)) return "search";
  if (/\btest\b|vitest|jest|pytest/.test(context)) return "test";
  if (/\bbuild\b|compile/.test(context)) return "build";
  if (/restart|localprocess|developmentserver/.test(context)) return "process";
  if (/shell|bash|execcommand|commandexecution/.test(context)) return executionWorkKind(input);
  if (/mcp|dynamictool|plugin|connector/.test(context)) return "integration";
  return "shell";
}
