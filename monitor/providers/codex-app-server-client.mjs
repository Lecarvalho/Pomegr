import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * A deliberately small, account-only Codex app-server client.  It does not
 * share the provider's app-server seam: a short-lived process is used only to
 * read the authenticated account rate-limit snapshot.
 */
export const CODEX_APP_SERVER_TIMEOUT_MS = 8_000;
export const CODEX_APP_SERVER_MAX_LINE_BYTES = 64 * 1024;
export const CODEX_APP_SERVER_MAX_OUTPUT_BYTES = 256 * 1024;
export const CODEX_APP_SERVER_UNAVAILABLE = "Codex usage limits are temporarily unavailable.";

const VERSION_TIMEOUT_MS = 2_000;
const EXIT_GRACE_MS = 400;
const WINDOWS_STORE_DIRECTORY = /[\\/]WindowsApps[\\/]/i;
const WINDOWS_DESKTOP_DIRECTORY = /[\\/]AppData[\\/]Local[\\/]Programs[\\/]Codex(?:[\\/]|$)/i;

function unavailableError() {
  return new Error(CODEX_APP_SERVER_UNAVAILABLE);
}

function environmentPath(environment) {
  return environment.PATH || environment.Path || environment.path || "";
}

function executableName(platform) {
  return platform === "win32" ? "codex.exe" : "codex";
}

function nativeExecutable(candidate, platform) {
  if (
    typeof candidate !== "string" || !candidate
    || WINDOWS_STORE_DIRECTORY.test(candidate)
    || WINDOWS_DESKTOP_DIRECTORY.test(candidate)
  ) return false;
  const extension = path.extname(candidate).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") return false;
  return platform !== "win32" || extension === ".exe";
}

function fileExists(candidate, { fsImpl, platform }) {
  if (!nativeExecutable(candidate, platform)) return false;
  try {
    const stat = fsImpl.statSync(candidate);
    if (!stat.isFile()) return false;
    return platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function nativeVendorPackage(platform, architecture) {
  if (platform === "win32") return architecture === "arm64"
    ? { packageName: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
    : { packageName: "codex-win32-x64", target: "x86_64-pc-windows-msvc" };
  if (platform === "darwin") return architecture === "arm64"
    ? { packageName: "codex-darwin-arm64", target: "aarch64-apple-darwin" }
    : { packageName: "codex-darwin-x64", target: "x86_64-apple-darwin" };
  return architecture === "arm64"
    ? { packageName: "codex-linux-arm64", target: "aarch64-unknown-linux-gnu" }
    : { packageName: "codex-linux-x64", target: "x86_64-unknown-linux-gnu" };
}

function packageRoots({ environment, cwd, platform, moduleRoots }) {
  if (Array.isArray(moduleRoots)) return moduleRoots;
  const roots = [path.join(cwd, "node_modules")];
  const prefix = environment.npm_config_prefix || environment.NPM_CONFIG_PREFIX;
  if (prefix) roots.push(path.join(prefix, "node_modules"));
  if (platform === "win32") {
    if (environment.APPDATA) roots.push(path.join(environment.APPDATA, "npm", "node_modules"));
    if (environment.ProgramFiles) roots.push(path.join(environment.ProgramFiles, "nodejs", "node_modules"));
  } else {
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }
  return [...new Set(roots)];
}

/**
 * Locate a native Codex CLI without invoking a shell.  Resolution intentionally
 * excludes command wrappers and Microsoft Store application aliases.
 */
export function resolveCodexAppServerExecutable(options = {}) {
  const environment = options.env || process.env;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const fsImpl = options.fs || fs;
  const cwd = options.cwd || process.cwd();
  const name = executableName(platform);
  const candidates = [];
  const configured = environment.POMEGR_CODEX_EXECUTABLE;

  // Overrides deliberately need to be absolute so a hostile or surprising
  // working directory cannot influence a monitor-side executable choice.
  if (configured && path.isAbsolute(configured)) candidates.push(configured);

  for (const directory of environmentPath(environment).split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, name));
  }

  for (const root of packageRoots({ environment, cwd, platform, moduleRoots: options.moduleRoots })) {
    const vendor = nativeVendorPackage(platform, architecture);
    const vendorTail = ["vendor", vendor.target, "bin", name];
    // npm may place the platform-specific optional dependency beside @openai/codex
    // or nest it below that package. Codex 0.144.1 supports both layouts.
    candidates.push(path.join(root, "@openai", "codex", "node_modules", "@openai", vendor.packageName, ...vendorTail));
    candidates.push(path.join(root, "@openai", vendor.packageName, ...vendorTail));
  }

  return candidates.find((candidate) => fileExists(candidate, { fsImpl, platform })) || null;
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeChild(child) {
  if (!child) return;
  try { child.stdin?.end(); } catch { /* best effort only */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = onceExit(child);
  try { child.kill("SIGTERM"); } catch { /* best effort only */ }
  await Promise.race([exited, delay(EXIT_GRACE_MS)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* best effort only */ }
    await Promise.race([exited, delay(EXIT_GRACE_MS)]);
  }
}

function spawnOptions(stdio) {
  return { shell: false, windowsHide: true, stdio };
}

async function verifyExecutable(executable, { spawnFn, timeoutMs = VERSION_TIMEOUT_MS }) {
  let child;
  try {
    child = spawnFn(executable, ["--version"], spawnOptions(["ignore", "pipe", "pipe"]));
    let output = "";
    let total = 0;
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const fail = () => finish(reject, unavailableError());
      const timer = setTimeout(fail, timeoutMs);
      const append = (chunk) => {
        if (settled) return;
        total += Buffer.byteLength(chunk);
        if (total > 8 * 1024) { fail(); return; }
        output += String(chunk);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", fail);
      child.on("exit", (code) => finish(resolve, { code, output }));
    });
    return result.code === 0
      && /^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.output.trim());
  } catch {
    return false;
  } finally {
    await closeChild(child);
  }
}

function writeJson(child, value) {
  if (!child.stdin?.writable || child.stdin.destroyed) throw unavailableError();
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

async function requestRateLimits(executable, {
  spawnFn,
  timeoutMs = CODEX_APP_SERVER_TIMEOUT_MS,
  maximumLineBytes = CODEX_APP_SERVER_MAX_LINE_BYTES,
  maximumOutputBytes = CODEX_APP_SERVER_MAX_OUTPUT_BYTES,
}) {
  let child;
  try {
    child = spawnFn(executable, ["app-server", "--stdio"], spawnOptions(["pipe", "pipe", "pipe"]));
    return await new Promise((resolve, reject) => {
      let settled = false;
      let phase = "awaitInitialize";
      let buffer = "";
      let outputBytes = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const fail = () => finish(reject, unavailableError());
      const timer = setTimeout(fail, timeoutMs);
      const processLine = (line) => {
        if (settled || !line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch { fail(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        if (message.id === 1 && phase === "awaitInitialize") {
          if (Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) { fail(); return; }
          phase = "awaitRateLimits";
          try {
            writeJson(child, { jsonrpc: "2.0", method: "initialized", params: {} });
            writeJson(child, { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
          } catch { fail(); }
          return;
        }
        if (message.id === 2 && phase === "awaitRateLimits") {
          if (Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) { fail(); return; }
          finish(resolve, { result: message.result });
        }
      };
      child.stdout?.on("data", (chunk) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maximumOutputBytes) { fail(); return; }
        buffer += String(chunk);
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > maximumLineBytes) { fail(); return; }
          processLine(line);
          if (settled) return;
        }
        if (Buffer.byteLength(buffer) > maximumLineBytes) fail();
      });
      child.stderr?.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maximumOutputBytes) fail();
      });
      // Writable stream failures (notably an asynchronous EPIPE after a JSONL
      // write) do not necessarily surface through child.on("error"). Bind this
      // before the first write and keep it safe after settlement/cleanup.
      child.stdin?.on("error", fail);
      child.on("error", fail);
      child.on("exit", () => { if (!settled) fail(); });
      try {
        writeJson(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "Pomegr", version: "0.2.0" }, capabilities: {} },
        });
      } catch { fail(); }
    });
  } finally {
    await closeChild(child);
  }
}

/**
 * Create an account-only reader.  Its sole public operation deliberately
 * cannot call thread/list or thread/read, preventing this transient client
 * from becoming a second live-session discovery transport.
 */
export function createCodexAppServerRateLimitsReader(options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const resolver = options.resolveExecutable || (() => resolveCodexAppServerExecutable(options));
  let validation = null;

  async function executable() {
    if (!validation) validation = (async () => {
      try {
        const candidate = await resolver();
        return candidate && await verifyExecutable(candidate, { spawnFn, timeoutMs: options.versionTimeoutMs })
          ? candidate
          : null;
      } catch {
        return null;
      }
    })();
    return validation;
  }

  return {
    async isAvailable() {
      return Boolean(await executable());
    },
    async readRateLimits() {
      try {
        const candidate = await executable();
        if (!candidate) throw unavailableError();
        return await requestRateLimits(candidate, {
          spawnFn,
          timeoutMs: options.timeoutMs,
          maximumLineBytes: options.maximumLineBytes,
          maximumOutputBytes: options.maximumOutputBytes,
        });
      } catch {
        throw unavailableError();
      }
    },
  };
}
