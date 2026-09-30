import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { environmentValue, nativeClaudeEnvironment, nativeCodexEnvironment } from "./environment-policy.mjs";
import { isSafeClaudeExecutable, resolveClaudeExecutable } from "./claude-auth.mjs";

const TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PLUGIN_ID = "pomegr@pomegr";
const MARKETPLACE = "Lecarvalho/pomegr";

function profileDirectory(environment) {
  return environmentValue(environment, "USERPROFILE") || environmentValue(environment, "HOME") || null;
}

function vendorPackage(platform, architecture) {
  if (platform === "win32") return architecture === "arm64"
    ? { name: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
    : { name: "codex-win32-x64", target: "x86_64-pc-windows-msvc" };
  if (platform === "darwin") return architecture === "arm64"
    ? { name: "codex-darwin-arm64", target: "aarch64-apple-darwin" }
    : { name: "codex-darwin-x64", target: "x86_64-apple-darwin" };
  return architecture === "arm64"
    ? { name: "codex-linux-arm64", target: "aarch64-unknown-linux-gnu" }
    : { name: "codex-linux-x64", target: "x86_64-unknown-linux-gnu" };
}

function executableName(platform) { return platform === "win32" ? "codex.exe" : "codex"; }

function isExplicitNativeExecutable(value, platform) {
  if (typeof value !== "string" || /[\u0000\r\n"]/u.test(value) || !path.isAbsolute(value)) return false;
  const resolved = path.resolve(value);
  if (resolved !== value && resolved.toLowerCase() !== value.toLowerCase()) return false;
  const name = path.basename(resolved).toLowerCase();
  if (name !== executableName(platform)) return false;
  return !/[\\/]WindowsApps[\\/]/iu.test(resolved) && !/[\\/]AppData[\\/]Local[\\/]Programs[\\/]Codex(?:[\\/]|$)/iu.test(resolved);
}

function nativeCodexCandidates(environment, platform, architecture) {
  const home = profileDirectory(environment);
  if (!home) return [];
  const executable = executableName(platform);
  const candidates = [path.join(home, ".local", "bin", executable)];
  const appData = environmentValue(environment, "APPDATA");
  if (typeof appData !== "string" || !appData) return candidates;
  const root = path.join(appData, "npm", "node_modules");
  const vendor = vendorPackage(platform, architecture);
  const tail = ["vendor", vendor.target, "bin", executable];
  candidates.push(
    path.join(root, "@openai", "codex", "node_modules", "@openai", vendor.name, ...tail),
    path.join(root, "@openai", vendor.name, ...tail),
  );
  return candidates;
}

export function isSafeCodexExecutable(value, environment = {}, options = {}) {
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  if (!isExplicitNativeExecutable(value, platform)) return false;
  const resolved = path.resolve(value);
  const configured = environmentValue(environment, "POMEGR_CODEX_EXECUTABLE");
  if (typeof configured === "string" && configured && resolved.toLowerCase() === path.resolve(configured).toLowerCase()) return true;
  return nativeCodexCandidates(environment, platform, architecture).some((candidate) => candidate.toLowerCase() === resolved.toLowerCase());
}

export function resolveCodexExecutable(environment = {}, fileExists = existsSync, options = {}) {
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const configured = environmentValue(environment, "POMEGR_CODEX_EXECUTABLE");
  if (configured !== undefined) return isSafeCodexExecutable(configured, environment, { platform, architecture }) && fileExists(configured) ? path.resolve(configured) : null;
  return nativeCodexCandidates(environment, platform, architecture).find((candidate) => fileExists(candidate)) || null;
}

export function pluginCommands(plan) {
  if (!plan || !["claude", "codex"].includes(plan.provider) || !["install", "update"].includes(plan.operation)) return null;
  if (plan.provider === "claude") {
    const commands = [];
    if (!plan.marketplaceRegistered) commands.push(["plugin", "marketplace", "add", MARKETPLACE]);
    else commands.push(["plugin", "marketplace", "update", "pomegr"]);
    commands.push(plan.operation === "install"
      ? ["plugin", "install", PLUGIN_ID, "--scope", plan.scope]
      : ["plugin", "update", PLUGIN_ID, "--scope", plan.scope]);
    return commands;
  }
  if (plan.operation === "install") {
    const commands = [];
    if (!plan.marketplaceRegistered) commands.push(["plugin", "marketplace", "add", MARKETPLACE, "--ref", plan.ref]);
    else commands.push(["plugin", "marketplace", "upgrade", "pomegr"]);
    commands.push(["plugin", "add", PLUGIN_ID]);
    return commands;
  }
  return [["plugin", "marketplace", "upgrade", "pomegr"], ["plugin", "add", PLUGIN_ID]];
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let shutdown;
    const clean = () => { clearTimeout(timer); clearTimeout(shutdown); child.removeListener?.("exit", onExit); child.removeListener?.("error", onError); };
    const finish = (status) => { if (settled) return; settled = true; clean(); resolve(status); };
    const onExit = (code) => finish(timedOut ? "timed_out" : code === 0 ? "completed" : "failed");
    const onError = () => finish("failed");
    const stop = () => { if (settled) return; timedOut = true; shutdown = setTimeout(() => finish("timed_out"), SHUTDOWN_TIMEOUT_MS); try { child.kill?.(); } catch { /* Child may have exited. */ } };
    child.once?.("exit", onExit); child.once?.("error", onError); timer = setTimeout(stop, timeoutMs);
  });
}

/** Executes only fixed official provider commands. It never accepts renderer-supplied paths or arguments. */
export function createRepositoryPluginCli(options = {}) {
  const sourceEnvironment = Object.freeze({ ...(options.environment || process.env) });
  const fileExists = options.fileExists || existsSync;
  const spawn = options.spawn || spawnChild;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const nativeClaude = Object.freeze({ ...(options.nativeClaudeEnvironment || nativeClaudeEnvironment(sourceEnvironment)) });
  const nativeCodex = Object.freeze({ ...(options.nativeCodexEnvironment || nativeCodexEnvironment(sourceEnvironment)) });
  let activeChild = null;
  let disposed = false;

  async function run(plan) {
    if (disposed) return "unavailable";
    const commands = pluginCommands(plan);
    const executable = plan?.provider === "claude"
      ? resolveClaudeExecutable(sourceEnvironment, fileExists)
      : plan?.provider === "codex" ? resolveCodexExecutable(sourceEnvironment, fileExists) : null;
    if (!commands || !executable || (plan.provider === "claude" && !isSafeClaudeExecutable(executable))) return "unavailable";
    for (const args of commands) {
      if (disposed) return "cancelled";
      let child;
      try {
        child = spawn(executable, args, { cwd: plan.root, env: plan.provider === "claude" ? nativeClaude : nativeCodex, shell: false, stdio: "ignore", windowsHide: true });
      } catch { return "failed"; }
      activeChild = child;
      const status = await waitForChild(child, timeoutMs);
      activeChild = null;
      if (status !== "completed") return status;
    }
    return "completed";
  }

  return Object.freeze({ run, dispose() { disposed = true; try { activeChild?.kill?.(); } catch { /* Owned child may already be gone. */ } } });
}
