import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const AGENT_ROLES = Object.freeze([
  "orchestrator",
  "explore",
  "plan",
  "builder",
  "reviewer",
  "tester",
  "researcher",
  "general-purpose",
  "workflow-worker",
  "fork",
  "compaction",
  "unknown",
]);

const ROLE_SET = new Set(AGENT_ROLES);
const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_MAPPINGS = 64;
const MAX_KEY_LENGTH = 64;
const CONFIG_FILE = path.join(".pomegr", "roles.json");

const EXACT_ROLES = new Map([
  ["orchestrator", "orchestrator"],
  ["primary", "orchestrator"],
  ["general-purpose", "general-purpose"],
  ["claude", "general-purpose"],
  ["subagent", "general-purpose"],
  ["agent", "general-purpose"],
  ["explore", "explore"],
  ["plan", "plan"],
  ["statusline-setup", "builder"],
  ["code-reviewer", "reviewer"],
  ["reviewer", "reviewer"],
  ["workflow-worker", "workflow-worker"],
  ["workflow-subagent", "workflow-worker"],
  ["fork", "fork"],
  ["compaction", "compaction"],
]);

// Ordered to make a composite provider-specific type deterministic. This is a
// display heuristic only; provider type text never reaches browser state.
const KEYWORD_ROLES = Object.freeze([
  ["review", "reviewer"],
  ["audit", "reviewer"],
  ["critic", "reviewer"],
  ["judge", "reviewer"],
  ["lint", "reviewer"],
  ["test", "tester"],
  ["qa", "tester"],
  ["spec", "tester"],
  ["verify", "tester"],
  ["explor", "explore"],
  ["search", "explore"],
  ["locate", "explore"],
  ["investigat", "explore"],
  ["discover", "explore"],
  ["scan", "explore"],
  ["map", "explore"],
  ["plan", "plan"],
  ["design", "plan"],
  ["architect", "plan"],
  ["research", "researcher"],
  ["docs", "researcher"],
  ["guide", "researcher"],
  ["study", "researcher"],
  ["build", "builder"],
  ["implement", "builder"],
  ["edit", "builder"],
  ["fix", "builder"],
  ["migrat", "builder"],
  ["refactor", "builder"],
  ["apply", "builder"],
  ["transform", "builder"],
  ["synthes", "builder"],
  ["writer", "builder"],
]);

export function normalizeAgentType(value) {
  if (typeof value !== "string") return "";
  const prepared = value.trim().toLowerCase();
  const terminal = prepared.slice(prepared.lastIndexOf(":") + 1);
  return terminal
    .replace(/[\s_./\\]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function roleConfigRoot(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  let candidate = path.resolve(cwd);
  while (true) {
    try {
      statSync(path.join(candidate, ".git"));
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(cwd);
      candidate = parent;
    }
  }
}

function configPath(cwd) {
  const root = roleConfigRoot(cwd);
  return root ? path.join(root, CONFIG_FILE) : "";
}

function diagnostic(status, roles = new Map(), errors = [], file = "") {
  return { status, roles, errors, file };
}

/** Read and validate a repository-local mapping without exposing it to clients. */
export function validateRoleConfig(cwd) {
  const file = configPath(cwd);
  if (!file) return diagnostic("missing");
  let size;
  try {
    size = statSync(file).size;
  } catch (error) {
    return error?.code === "ENOENT" ? diagnostic("missing", new Map(), [], file) : diagnostic("invalid", new Map(), ["roles file is unreadable"], file);
  }
  if (size > MAX_CONFIG_BYTES) return diagnostic("invalid", new Map(), [`roles file exceeds ${MAX_CONFIG_BYTES} bytes`], file);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return diagnostic("invalid", new Map(), ["roles file is not valid JSON"], file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return diagnostic("invalid", new Map(), ["roles file must be an object"], file);
  const topLevel = Object.keys(parsed);
  if (topLevel.some((key) => key !== "version" && key !== "roles")) return diagnostic("invalid", new Map(), ["roles file has unsupported top-level fields"], file);
  if (parsed.version !== CONFIG_VERSION) return diagnostic("invalid", new Map(), [`roles file must use version ${CONFIG_VERSION}`], file);
  if (!parsed.roles || typeof parsed.roles !== "object" || Array.isArray(parsed.roles)) return diagnostic("invalid", new Map(), ["roles must be an object"], file);

  const entries = Object.entries(parsed.roles);
  if (entries.length > MAX_MAPPINGS) return diagnostic("invalid", new Map(), [`roles contains more than ${MAX_MAPPINGS} mappings`], file);
  const roles = new Map();
  const errors = [];
  for (const [key, role] of entries) {
    const normalized = normalizeAgentType(key);
    if (key.length > MAX_KEY_LENGTH || key !== normalized || !normalized || normalized.length > MAX_KEY_LENGTH || !/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
      errors.push(`ignored invalid role key: ${String(key).slice(0, MAX_KEY_LENGTH)}`);
      continue;
    }
    if (roles.has(normalized)) {
      errors.push(`ignored duplicate role key: ${normalized}`);
      continue;
    }
    if (!ROLE_SET.has(role)) {
      errors.push(`ignored ${normalized}: unsupported role`);
      continue;
    }
    roles.set(normalized, role);
  }
  return diagnostic("ready", roles, errors, file);
}

export function repositoryRoleMappings(cwd) {
  const result = validateRoleConfig(cwd);
  return result.status === "ready" ? result.roles : new Map();
}

export function resolveAgentRole({ id = "", kind = "", workflowId = null, cwd = "", repositoryRoles = null } = {}) {
  if (id === "primary") return "orchestrator";
  const normalized = normalizeAgentType(kind);
  const configured = (repositoryRoles instanceof Map ? repositoryRoles : repositoryRoleMappings(cwd)).get(normalized);
  if (configured) return configured;
  const exact = EXACT_ROLES.get(normalized);
  if (exact) return exact;
  for (const [keyword, role] of KEYWORD_ROLES) {
    if (normalized.includes(keyword)) return role;
  }
  if (typeof workflowId === "string" && workflowId) return "workflow-worker";
  return "unknown";
}

function directInvocation() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "validate") return false;
  const cwdIndex = args.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
  const result = validateRoleConfig(cwd);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    file: result.file,
    mappings: [...result.roles.entries()],
    errors: result.errors,
  })}\n`);
  process.exitCode = result.status === "invalid" ? 1 : 0;
  return true;
}

directInvocation();
