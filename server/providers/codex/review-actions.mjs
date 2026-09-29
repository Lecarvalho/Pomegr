const MAX_REQUEST_TAIL_LENGTH = 64_000;
const MAX_COMMAND_EVIDENCE_LENGTH = 8_000;
const MAX_JUSTIFICATION_EVIDENCE_LENGTH = 1_000;

const REVIEW_ACTIONS = new Set([
  "build_or_test",
  "browser_interaction",
  "dependency_change",
  "file_change",
  "filesystem_action",
  "local_process",
  "network_access",
  "version_control",
  "shell_command",
  "privileged_action",
]);

function finalRequestObject(message) {
  if (typeof message !== "string" || !message) return null;
  const tail = message.slice(-MAX_REQUEST_TAIL_LENGTH);
  const end = tail.lastIndexOf("}");
  if (end < 0) return null;
  const starts = [];
  for (let start = tail.lastIndexOf("\n{", end); start >= 0; start = tail.lastIndexOf("\n{", start - 1)) {
    starts.push(start + 1);
  }
  if (tail.startsWith("{")) starts.push(0);
  for (const start of starts) {
    try {
      const value = JSON.parse(tail.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Earlier braces may belong to the request's bounded string fields.
    }
  }
  return null;
}

function finalToolName(message, request) {
  if (typeof request?.tool === "string") return request.tool.toLowerCase();
  if (typeof message !== "string") return "";
  const tail = message.slice(-512);
  const matches = [...tail.matchAll(/"tool"\s*:\s*"([a-z0-9_:-]+)"/gi)];
  return matches.at(-1)?.[1]?.toLowerCase() || "";
}

function commandEvidence(request) {
  const command = Array.isArray(request?.command)
    ? request.command.filter((value) => typeof value === "string").join(" ").slice(0, MAX_COMMAND_EVIDENCE_LENGTH)
    : "";
  const justification = typeof request?.justification === "string"
    ? request.justification.slice(0, MAX_JUSTIFICATION_EVIDENCE_LENGTH)
    : "";
  return `${command}\n${justification}`.toLowerCase();
}

function shellAction(evidence) {
  if (/restart|relaunch|start-process|\bnpm\s+run\s+(?:dev|start)\b|\bdev process\b|\blocal (?:monitor|server|dashboard)\b|\bports?\s+\d/.test(evidence)) return "local_process";
  if (/\b(npm|pnpm|yarn|pip|cargo)\s+(?:add|ci|install|uninstall|update)\b|\bdependency (?:install|change|update)\b|\bpackage (?:install|change|update)\b/.test(evidence)) return "dependency_change";
  if (/\bgit\s+(?:add|commit|push|pull|fetch|merge|rebase|switch|checkout|branch|tag)\b|\bgh\s+|\bpull request\b/.test(evidence)) return "version_control";
  if (/\b(curl|wget|invoke-webrequest)\b|\bnetwork access\b|\bdownload\b|https?:\/\//.test(evidence)) return "network_access";
  if (/\b(remove-item|move-item|copy-item|new-item|rm|mv|cp|mkdir|del)\b|\b(delete|remove|move|copy|rename)\s+(?:a\s+)?(?:file|directory|folder)\b/.test(evidence)) return "filesystem_action";
  if (/\b(npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint)\b|\b(vitest|jest|pytest)\b|\bnode\s+--test\b|\bcargo\s+test\b|\bgo\s+test\b|\btest suite\b|\bbuild step\b|\bplugin bundles?\b/.test(evidence)) return "build_or_test";
  return "shell_command";
}

export function normalizeCodexReviewAction(value) {
  return REVIEW_ACTIONS.has(value) ? value : "privileged_action";
}

export function classifyCodexApprovalAction(message) {
  const request = finalRequestObject(message);
  const tool = finalToolName(message, request);
  if (tool === "apply_patch") return "file_change";
  if (tool.includes("browser") || tool.includes("node_repl")) return "browser_interaction";
  if (tool.includes("web")) return "network_access";
  if (tool !== "exec_command") return "privileged_action";
  return shellAction(commandEvidence(request));
}
