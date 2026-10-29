import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { sessionEnvironmentFits, userSessionEnvironment } from "./environment-policy.mjs";
import { CODEX_INLINE_FLAG, resolveSessionExecutable } from "./task-dispatch.mjs";

export const SESSION_CONTINUE_CHANNEL = "pomegr:session-continue";
const ID = /^(claude|codex):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const REASONS = new Set(["live", "unknown", "folder_missing", "history_missing"]);
const ERRORS = new Set(["invalid", "not_found", "unavailable"]);
const result = (status) => ({ status });
const directoryExists = (folder) => { try { return statSync(folder).isDirectory(); } catch { return false; } };

export async function confirmSessionContinue(dialog, getWindow, plan) {
  const window = getWindow();
  if (!window || window.isDestroyed()) return false;
  const answer = await dialog.showMessageBox(window, {
    type: "question", title: "Continue a session", message: "Continue this session in Pomegr?",
    detail: `${plan.title}\n${plan.provider === "claude" ? "Claude Code" : "Codex"}\n${plan.cwd}`,
    buttons: ["Continue", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
  });
  return answer.response === 0;
}

/** Only the owner's trusted desktop action may resume; no plan or path leaves main. */
export function createSessionContinue(options = {}) {
  const active = new Set(), uncertain = new Set();
  const fetchImpl = options.fetch || fetch;
  const hasDirectory = options.directoryExists || directoryExists;
  const startupEnvironment = options.environment || process.env;
  // Read again for each continue, so the session gets the user's environment as it is now.
  const sessionEnvironment = typeof options.sessionEnvironment === "function" ? options.sessionEnvironment : async () => startupEnvironment;
  let disposed = false, origin;
  try {
    const url = new URL(options.monitorOrigin);
    if (url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) origin = url.origin;
  } catch { /* Fail closed until configured. */ }
  const trusted = (event) => options.isTrustedEvent?.(event) === true && event.senderFrame
    && event.senderFrame === event.sender?.mainFrame && !event.sender.isDestroyed();

  async function readPlan(sessionId) {
    const response = await fetchImpl(`${origin}/internal/sessions/continue-plan`, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { [DESKTOP_AUTH_HEADER]: options.authorizationToken, "content-type": "application/json" }, body: JSON.stringify({ sessionId }),
    });
    const body = await response.json();
    if (body?.ok === false && REASONS.has(body.reason)) return result(body.reason);
    if (ERRORS.has(body?.error)) return result(body.error);
    const plan = body?.plan, match = ID.exec(sessionId);
    if (!response.ok || body?.ok !== true || !plan || plan.sessionId !== sessionId || plan.provider !== match[1] || plan.localId !== match[2]
      || typeof plan.title !== "string" || plan.title.length > 160 || /[\u0000-\u001f\u007f]/u.test(plan.title)
      || typeof plan.cwd !== "string" || /[\u0000\r\n"]/u.test(plan.cwd) || !path.isAbsolute(plan.cwd) || path.resolve(plan.cwd) !== plan.cwd) return result("unavailable");
    if (!hasDirectory(plan.cwd)) return result("folder_missing");
    return { plan: { provider: plan.provider, sessionId, localId: plan.localId, cwd: plan.cwd, title: plan.title } };
  }

  async function run(event, sessionId) {
    if (!trusted(event) || typeof sessionId !== "string" || !ID.test(sessionId)) return result("invalid");
    if (disposed || !origin || !options.authorizationToken) return result("unavailable");
    if (active.has(sessionId) || uncertain.has(sessionId)) return result("busy");
    active.add(sessionId);
    try {
      const first = await readPlan(sessionId);
      if (!first.plan) return first;
      if (disposed || !trusted(event) || await options.confirm?.(first.plan) !== true) return result("cancelled");
      if (disposed || !trusted(event)) return result("cancelled");
      const listing = await options.terminal.run(event, "list");
      if (!listing.ok || listing.hosts?.some((host) => host.state !== "ready")) return result("unavailable");
      if (listing.sessions?.some((row) => (row.sessionId === sessionId || row.continuedFrom === sessionId) && row.state !== "exited")) return result("busy");
      let environment;
      try { environment = await sessionEnvironment(); } catch { environment = startupEnvironment; }
      const executable = resolveSessionExecutable(first.plan.provider, environment, options.fileExists || existsSync, options.platform || process.platform);
      if (!executable) return result("cli_missing");
      const env = userSessionEnvironment(environment);
      if (!sessionEnvironmentFits(env)) return result("environment_invalid");
      await options.terminal.ensureHost();
      const current = await readPlan(sessionId);
      if (!current.plan) return current;
      if (current.plan.cwd !== first.plan.cwd) return result("folder_missing");
      if (disposed || !trusted(event)) return result("cancelled");
      const plan = current.plan;
      // A lost create reply is ambiguous. Do not issue a second resume in this app process.
      uncertain.add(sessionId);
      try {
        await options.terminal.create({ key: `continue/${plan.provider}/${plan.localId}/${randomBytes(16).toString("hex")}`,
          executable, args: plan.provider === "claude" ? ["--resume", plan.localId] : ["resume", CODEX_INLINE_FLAG, plan.localId], cwd: plan.cwd,
          env, cols: 80, rows: 24 });
        uncertain.delete(sessionId);
      } catch (error) {
        if (["TERMINAL_INVALID", "TERMINAL_CAPACITY", "TERMINAL_SPAWN_FAILED"].includes(error.message)) uncertain.delete(sessionId);
        return result("failed");
      }
      return result("started");
    } catch { return result("unavailable"); }
    finally { active.delete(sessionId); }
  }
  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installSessionContinueIpc(options = {}) {
  const action = options.action || createSessionContinue(options);
  options.ipcMain.removeHandler(SESSION_CONTINUE_CHANNEL);
  options.ipcMain.handle(SESSION_CONTINUE_CHANNEL, async (event, sessionId) => {
    try { return await action.run(event, sessionId); } catch { return result("unavailable"); }
  });
  return () => { options.ipcMain.removeHandler(SESSION_CONTINUE_CHANNEL); action.dispose(); };
}
