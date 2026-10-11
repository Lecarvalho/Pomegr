import os from "node:os";
import path from "node:path";

const MAX_DIRECTORY_LENGTH = 4_096;

function directory(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DIRECTORY_LENGTH) return null;
  try { return path.resolve(value); } catch { return null; }
}

export function resolveClaudeProfileRoots(options = {}) {
  const environment = options.env ?? options.environment ?? process.env;
  const homeDir = directory(options.homeDir) || os.homedir();
  const defaultConfigRoot = path.join(homeDir, ".claude");
  const configRoot = directory(options.claudeConfigDir)
    || directory(options.configRoot)
    || directory(environment?.CLAUDE_CONFIG_DIR)
    || defaultConfigRoot;
  return {
    configRoot,
    projectsRoot: directory(options.projectsRoot)
      || directory(environment?.CLAUDE_PROJECTS_DIR)
      || path.join(configRoot, "projects"),
    registryRoot: directory(options.registryRoot) || path.join(configRoot, "sessions"),
    tasksRoot: directory(options.tasksRoot) || path.join(configRoot, "tasks"),
  };
}
