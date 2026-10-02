import crypto from "node:crypto";
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
  "reply",
  "plan",
  "other",
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
  return memoizedKind(executionKinds, value, classifyCommand);
}

// Classification is pure over bounded text, and warm reads classify the same records again, so
// short inputs keep their result in a small, bounded LRU memo keyed by a SHA-256 digest of the
// text. Only digests and WorkKind values are held; the text itself is never retained.
const MAX_MEMOIZED_KINDS = 4_096;
const MAX_MEMOIZED_TEXT = 2_048;
const executionKinds = new Map();
function memoizedKind(memo, text, classify) {
  if (text.length > MAX_MEMOIZED_TEXT) return classify(text);
  const key = crypto.createHash("sha256").update(text).digest("base64");
  const cached = memo.get(key);
  if (cached !== undefined) {
    memo.delete(key);
    memo.set(key, cached);
    return cached;
  }
  const kind = classify(text);
  memo.set(key, kind);
  if (memo.size > MAX_MEMOIZED_KINDS) memo.delete(memo.keys().next().value);
  return kind;
}

// A program counts only where a command can start: the start of the text or a line, or after a
// separator or an assignment. A program name inside a quoted string or an argument never
// classifies the command.
const AT = String.raw`(?:^|[\n;&|({=])\s*`;
// Git's global options sit between the program and its subcommand. A quoted or path-embedded
// `git` is text, not the program.
const GIT = String.raw`(?<![\w./\\'"-])git(?:\.exe)?(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const GIT_PUSH = new RegExp(String.raw`${GIT}push\b`);
const GIT_ANY = new RegExp(String.raw`${GIT}[a-z][a-z-]*\b`);
const TEST = /\b(?:npm(?:\.cmd)?\s+(?:run\s+)?test|node\s+--test|vitest|jest|pytest|playwright\s+test|(?:cargo|dotnet|go)\s+test)\b/;
const CHECK = /\b(?:npm(?:\.cmd)?\s+run\s+(?:lint|typecheck|check|verify)|eslint|tsc)\b/;
const BUILD = /\b(?:npm(?:\.cmd)?\s+run\s+build|vinext\s+build|vite\s+build|next\s+build|cargo\s+build|dotnet\s+build)\b/;
const SEARCH = new RegExp(String.raw`${AT}(?:(?:rg|grep|findstr|find|fd|ls|dir)(?:\.exe)?|select-string|get-childitem)(?![\w.-])`);
const READ = new RegExp(String.raw`${AT}(?:get-content|read-file|cat|head|tail|type|less|more|bat)(?![\w.-])`);
const PROCESS = new RegExp(String.raw`restart-pomegr|${AT}(?:restart-service|start-process|stop-process|taskkill(?:\.exe)?|kill|pkill)(?![\w.-])|\bnpm(?:\.cmd)?\s+run\s+dev\b`);
const WEB = new RegExp(String.raw`${AT}(?:invoke-(?:restmethod|webrequest)|(?:curl|wget)(?:\.exe)?)(?![\w.-])`);
// GNU `timeout <seconds> <command>` wraps another command, so only the Windows `timeout /t` waits.
const WAIT = new RegExp(String.raw`${AT}(?:start-sleep|sleep(?:\.exe)?|timeout(?:\.exe)?\s+/t)(?![\w.-])`);

function classifyCommand(value) {
  if (/\bgh(?:\.exe)?\s+pr\b/.test(value)) return "pull_request";
  if (GIT_PUSH.test(value)) return "git_push";
  if (GIT_ANY.test(value)) return "git";
  if (TEST.test(value) || CHECK.test(value)) return "test";
  if (BUILD.test(value)) return "build";
  if (SEARCH.test(value)) return "search";
  if (READ.test(value)) return "read";
  if (PROCESS.test(value)) return "process";
  if (WEB.test(value)) return "web";
  if (WAIT.test(value)) return "wait";
  return "shell";
}

/** Marks a shell tool, whose kind comes from its command rather than its name. */
const SHELL_TOOL = Symbol("shell-tool");

// Exact tool identities, compared after lowercasing and dropping separators. Claude Code tool names
// and the fixed labels the Codex adapter authors share this table; the full inventory, with the
// harness versions it was taken from, is docs/internal/architecture/tool-inventory.md.
const TOOL_KINDS = new Map(Object.entries({
  shell: ["bash", "powershell", "shell", "execcommand", "shellcommand", "commandexecution", "localshell"],
  search: ["grep", "glob", "ls", "toolsearch"],
  read: ["read", "notebookread"],
  write: ["write", "edit", "multiedit", "notebookedit", "filechange", "applypatch"],
  web: ["webfetch", "websearch"],
  image: ["viewimage", "imagegeneration"],
  input: ["askuserquestion", "requestinput", "userinput"],
  transfer: ["senduserfile"],
  skill: ["skill"],
  agent: ["agent", "task", "workflow", "listagents", "sendmessage", "spawnagent", "sendtoagent", "resumeagent", "stopagent"],
  wait: ["wait", "waitforagent", "monitor", "schedulewakeup"],
  process: ["taskstop", "taskoutput", "bashoutput", "killshell", "killbash", "shellinput"],
  git: ["enterworktree", "exitworktree"],
  plan: ["taskcreate", "taskupdate", "tasklist", "taskget", "todowrite", "todoread", "enterplanmode", "exitplanmode", "planupdate"],
  reply: ["assistantreplied", "summaryupdated", "messagetouser"],
}).flatMap(([kind, names]) => names.map((name) => [name, kind === "shell" ? SHELL_TOOL : kind])));

const REPORT_TOOLS = new Set([
  "report_session_progress", "report_session_signal", "report_agent_signal", "report_task_signal",
  "clear_session_progress", "clear_session_signal", "clear_agent_signal",
]);

/** A carrier names another tool: an MCP or dynamic tool call, identified by its server and tool. */
function carriedTool(tool, name, detail) {
  if (/^mcp__/i.test(tool)) {
    const parts = tool.split("__");
    return { server: parts[1] || "", tool: parts.slice(2).join("__") };
  }
  if (name !== "mcp" && name !== "dynamictool") return null;
  const parts = String(detail || "").split(" / ");
  return parts.length > 1 ? { server: parts[0], tool: parts.slice(1).join(" / ") } : { server: "", tool: parts[0] };
}

// An MCP tool name is arbitrary third-party text, so it never classifies by resemblance. Only the
// two families Pomegr recognizes by exact identity leave the integration kind.
function carriedKind({ server, tool }) {
  const serverName = server.toLowerCase();
  const toolName = tool.toLowerCase();
  if (/pomegr/.test(serverName) && REPORT_TOOLS.has(toolName)) return "report";
  const words = toolName.split(/[^a-z0-9]+/).filter(Boolean);
  const github = serverName === "github" || words[0] === "github";
  const pullRequest = words.some((word, index) => word === "pr" || word === "prs"
    || (word === "pull" && /^requests?$/.test(words[index + 1] || "")));
  return github && pullRequest ? "pull_request" : "integration";
}

/**
 * Normalize a provider tool identity without asking React to interpret provider text. A tool is
 * classified by its exact identity alone: its detail is a file name, a label or free text, and
 * never decides the kind. An unrecognized tool is `other`, never a guess.
 */
export function toolWorkKind(tool, { detail = "", input = null } = {}) {
  const raw = String(tool || "");
  const name = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const carried = carriedTool(raw, name, detail);
  if (carried) return carriedKind(carried);
  const kind = TOOL_KINDS.get(name) ?? "other";
  return kind === SHELL_TOOL ? executionWorkKind(input) : kind;
}
