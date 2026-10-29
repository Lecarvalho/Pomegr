import { execFile as execFileChild } from "node:child_process";
import path from "node:path";
import { environmentValue } from "./environment-policy.mjs";

export const REGISTRY_READ_TIMEOUT_MS = 3_000;
const REGISTRY_OUTPUT_BYTES = 1024 * 1024;

// Reads the machine and the user environment keys as Windows stores them, with REG_EXPAND_SZ values left unexpanded.
// Each value is one line of base64 fields, so no name or value depends on the console's code page.
const REGISTRY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$b={param($t) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t))}",
  "foreach($s in @(@('machine',[Microsoft.Win32.Registry]::LocalMachine,'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),@('user',[Microsoft.Win32.Registry]::CurrentUser,'Environment'))){"
    + "$k=$s[1].OpenSubKey($s[2]); if($k){ foreach($n in $k.GetValueNames()){ $t=$k.GetValueKind($n);"
    + " if($t -eq [Microsoft.Win32.RegistryValueKind]::String -or $t -eq [Microsoft.Win32.RegistryValueKind]::ExpandString){"
    + " [Console]::Out.WriteLine($s[0]+' '+$(if($t -eq [Microsoft.Win32.RegistryValueKind]::ExpandString){'x'}else{'s'})+' '+(& $b $n)+' '+(& $b $k.GetValue($n,'',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))) } }; $k.Close() } }",
].join("; ");
// An empty value leaves its field empty, so trimming the line may drop its last separator.
const LINE = /^(machine|user) ([sx]) ([A-Za-z0-9+/=]+)(?: ([A-Za-z0-9+/=]*))?$/u;

/** Parses the reader's lines into `{ machine, user }`, each a list of `{ name, value, expand }` in the key's order. */
export function parseRegistryEnvironment(output) {
  const scopes = { machine: [], user: [] };
  for (const line of String(output).split(/\r?\n/u)) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const name = Buffer.from(match[3], "base64").toString("utf8");
    if (name) scopes[match[1]].push({ name, value: Buffer.from(match[4] ?? "", "base64").toString("utf8"), expand: match[2] === "x" });
  }
  return scopes;
}

/** Reads the current Windows user and machine environment through Windows PowerShell; it rejects on failure or after `timeoutMs`. */
export function readWindowsEnvironment({ environment = process.env, execFile = execFileChild, timeoutMs = REGISTRY_READ_TIMEOUT_MS } = {}) {
  const systemRoot = environmentValue(environment, "SystemRoot");
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) return Promise.reject(new Error("SESSION_ENVIRONMENT_UNAVAILABLE"));
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    try {
      execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", REGISTRY_SCRIPT], {
        encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: REGISTRY_OUTPUT_BYTES,
      }, (error, stdout) => (error ? reject(new Error("SESSION_ENVIRONMENT_UNAVAILABLE")) : resolve(parseRegistryEnvironment(stdout))));
    } catch { reject(new Error("SESSION_ENVIRONMENT_UNAVAILABLE")); }
  });
}

function setVariable(environment, name, value) {
  for (const existing of Object.keys(environment)) if (existing.toLowerCase() === name.toLowerCase()) delete environment[existing];
  if (value !== undefined) environment[name] = value;
}

// Unknown names stay as written, as ExpandEnvironmentStrings leaves them.
function expand(value, environment) {
  return value.replace(/%([^%]+)%/gu, (whole, name) => environmentValue(environment, name) ?? whole);
}

const registryNames = (scopes) => new Set([...scopes.machine, ...scopes.user].map(({ name }) => name.toLowerCase()));
const pathName = (environment) => Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "Path";

/**
 * Lays the current registry environment over the startup copy as Windows builds a new logon's: the machine key, then
 * the user key, plain values before expandable ones, and PATH as the machine Path followed by the user Path.
 * A variable the registry held at startup and no longer holds is dropped. A variable only the process had is kept.
 */
export function refreshedEnvironment(startup, startupScopes, currentScopes) {
  const environment = { ...startup };
  if (startupScopes) {
    const current = registryNames(currentScopes);
    for (const name of registryNames(startupScopes)) if (!current.has(name)) setVariable(environment, name, undefined);
  }
  const paths = [];
  for (const scope of ["machine", "user"]) {
    for (const expandable of [false, true]) {
      for (const { name, value, expand: isExpandable } of currentScopes[scope]) {
        if (isExpandable !== expandable) continue;
        const resolved = expandable ? expand(value, environment) : value;
        if (name.toLowerCase() === "path") paths.push(resolved);
        else setVariable(environment, name, resolved);
      }
    }
  }
  if (paths.length > 0) setVariable(environment, pathName(startup), paths.filter(Boolean).join(";"));
  return environment;
}

/**
 * The environment as Windows would give a process started now: `() => Promise<environment>`, read again on each call.
 * A read that fails or times out answers the copy taken at startup, and so does every other platform.
 */
export function createWindowsEnvironment({ environment, platform = process.platform, readRegistry, timeoutMs = REGISTRY_READ_TIMEOUT_MS }) {
  const startup = { ...environment };
  if (platform !== "win32") return async () => ({ ...startup });
  const read = readRegistry || (() => readWindowsEnvironment({ environment: startup, timeoutMs }));
  const bounded = () => {
    let timer;
    return Promise.race([
      new Promise((resolve) => { resolve(read()); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SESSION_ENVIRONMENT_TIMEOUT")), timeoutMs); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
  };
  // What the registry held when the app started, so a variable deleted since is dropped. Unknown when this read fails.
  const startupScopes = bounded().catch(() => null);
  return async () => {
    let current;
    try { current = await bounded(); } catch { return { ...startup }; }
    if (!Array.isArray(current?.machine) || !Array.isArray(current?.user)) return { ...startup };
    return refreshedEnvironment(startup, await startupScopes, current);
  };
}
