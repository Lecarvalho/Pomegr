// One chat turn is one headless run of the owner's own provider CLI, signed in as the owner. The run is read-only:
// it gets a fixed argument list, the prompt on stdin, and no way to ask for a permission. Nothing the owner typed
// reaches a command line or a path. The images of a conversation are files desktop main named itself.

export const TURN_TIMEOUT_MS = 10 * 60_000;
export const STDOUT_LINE_LIMIT = 4 * 1024 * 1024;
export const ANSWER_LIMIT = 32_000;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
// The effort levels of a run; the same values the task dispatcher passes to a session.
export const CHAT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
// A random version 4 UUID that desktop main made for one turn.
export const CHAT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// The read tools of the chat's own MCP server (`mcp/agent-chat-server.mjs`); it has no tool that writes.
export const POMEGR_READ_TOOLS = Object.freeze([
  "list_sessions", "get_session_report", "list_session_agents", "get_agent_context", "get_recent_failures", "get_usage_limits", "get_provider_health", "get_task", "list_tasks",
]);
export const CLAUDE_FILE_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);
const MCP_SERVER_NAME = "pomegr";
const CHAT_TASK_ENV = Object.freeze(["POMEGR_CHAT_TASK_ORIGIN", "POMEGR_CHAT_TASK_KEY"]);

// A server the desktop itself names: an absolute executable, absolute script arguments, and fixed environment values.
function validServer(server) {
  const plain = (value) => typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/u.test(value);
  return server !== null && typeof server === "object" && plain(server.command)
    && Array.isArray(server.args) && server.args.every(plain)
    && server.env !== null && typeof server.env === "object" && Object.entries(server.env).every(([name, value]) => /^[A-Z][A-Z0-9_]*$/u.test(name) && plain(value));
}

const tomlString = (value) => JSON.stringify(value);

const IMAGES_PER_MESSAGE = 4;
const IMAGE_FILE = /^img-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/u;
// A drive path or a rooted path, without a trailing separator.
const ABSOLUTE_FOLDER = /^(?:[A-Za-z]:[\\/]|[\\/]).*[^\\/]$/u;

// The image folder of one conversation and the image files of the newest message, as desktop main built them: an
// absolute, normalized folder, and files that sit directly in it under the fixed image name. Anything else is no image.
function validImages(images) {
  const folder = images !== null && typeof images === "object" ? images.folder : null;
  if (typeof folder !== "string" || !ABSOLUTE_FOLDER.test(folder) || /[\u0000-\u001f"]/u.test(folder) || /(?:^|[\\/])\.\.?(?:[\\/]|$)/u.test(folder)) return null;
  const files = Array.isArray(images.files) ? images.files : [];
  if (files.length > IMAGES_PER_MESSAGE || new Set(files).size !== files.length) return null;
  const inFolder = (file) => typeof file === "string" && file.length > folder.length + 1 && file.startsWith(folder)
    && /[\\/]/u.test(file[folder.length]) && IMAGE_FILE.test(file.slice(folder.length + 1));
  return files.every(inFolder) ? { folder, files: [...files] } : null;
}

export function validInstructionsFile(instructions) {
  const folder = instructions?.folder;
  const file = instructions?.file;
  return validImages({ folder, files: [] }) !== null && typeof file === "string" && file.startsWith(folder)
    && /[\\/]/u.test(file[folder.length]) && /^instructions-[0-9a-f]{64}\.md$/u.test(file.slice(folder.length + 1));
}

/**
 * The fixed arguments of one turn. Only a validated model identifier, a validated effort level, the desktop's own MCP
 * server, and the desktop's own image folder, files, instructions file, and session ID vary. The effort is passed as the
 * task dispatcher passes it: `--effort` to Claude Code and `-c model_reasoning_effort=` to Codex.
 * The run uses provider-native read access, the conversation images, and Pomegr's read tools. Native permissions
 * can permit reads outside the repository. User settings and hooks are excluded; managed provider policy still
 * applies. No write access or interactive approval is enabled.
 */
export function chatArguments(provider, model = null, mcpServer = null, images = null, sessionId = null, instructionsFile = null, effort = null, tools = "read") {
  const chosen = typeof model === "string" && MODEL.test(model) ? model : null;
  const level = typeof effort === "string" && CHAT_EFFORTS.includes(effort) ? effort : null;
  const identity = typeof sessionId === "string" && CHAT_SESSION_ID.test(sessionId) ? sessionId : null;
  const server = validServer(mcpServer) ? { command: mcpServer.command, args: [...mcpServer.args], env: { ...mcpServer.env } } : null;
  // Pass the turn capability through process environments, never provider argv or an on-disk config.
  const inherited = server ? CHAT_TASK_ENV.filter((name) => Object.hasOwn(server.env, name)) : [];
  for (const name of inherited) delete server.env[name];
  const shown = validImages(images);
  // `tools` is `"read"` (the files and Pomegr's read tools) or `"none"`; anything else reads as `"read"`.
  const noTools = tools === "none";
  if (provider === "claude") {
    return [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
      // Claude Code registers even a run that keeps no session file. The ID desktop main gave the run is the one the
      // monitor holds for the turn, so the registration never shows as a session.
      ...(identity ? ["--session-id", identity] : []),
      // Leave out user/project/local settings and hooks; native tool allowlists keep the run read-only without confining reads to cwd.
      "--setting-sources", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: server ? { [MCP_SERVER_NAME]: server } : {} }),
      // A tool outside the allow list is refused, never asked about. A run with no tools (the compaction of a thread) is
      // given the empty tool list and no allow list.
      "--permission-mode", "dontAsk",
      "--tools", noTools ? "" : CLAUDE_FILE_TOOLS.join(","),
      ...(noTools ? [] : ["--allowedTools", [...CLAUDE_FILE_TOOLS, ...POMEGR_READ_TOOLS.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`)].join(",")]),
      ...(chosen ? ["--model", chosen] : []),
      ...(level ? ["--effort", level] : []),
      // The conversation image folder remains a desktop-owned working directory.
      ...(shown ? ["--add-dir", shown.folder] : []),
      ...(validInstructionsFile(instructionsFile) ? ["--append-system-prompt-file", instructionsFile.file, "--exclude-dynamic-system-prompt-sections"] : []),
    ];
  }
  if (provider === "codex") {
    return [
      // The read-only sandbox lets the shell read files and write nothing; a tool that needs an approval is refused.
      "exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--disable", "apps",
      // Ignoring user config also drops the Windows sandbox selection. Prefer native MXC, with the provisioned
      // elevated sandbox as fallback; managed policy still applies. Never request an unsandboxed retry.
      "-c", 'approval_policy="never"', "-c", "features.prefer_mxc=true", "-c", 'windows.sandbox="elevated"',
      ...(server ? [
        "-c", `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(server.command)}`,
        "-c", `mcp_servers.${MCP_SERVER_NAME}.args=[${server.args.map(tomlString).join(", ")}]`,
        "-c", `mcp_servers.${MCP_SERVER_NAME}.env={${Object.entries(server.env).map(([name, value]) => `${name}=${tomlString(value)}`).join(", ")}}`,
        ...(inherited.length > 0 ? ["-c", `mcp_servers.${MCP_SERVER_NAME}.env_vars=[${inherited.map(tomlString).join(", ")}]`] : []),
      ] : []),
      ...(chosen ? ["--model", chosen] : []),
      ...(level ? ["-c", `model_reasoning_effort=${level}`] : []),
      "-",
      // The image flag takes a list of values, so it follows the prompt marker: before it, it would swallow the marker.
      ...(shown && shown.files.length > 0 ? ["--image", ...shown.files] : []),
    ];
  }
  return null;
}

function activityForTool(name) {
  const tool = String(name).replace(/^mcp__[A-Za-z0-9_]+?__/u, "");
  if (["Read", "Grep", "Glob", "command_execution"].includes(tool)) return "reading_files";
  if (["get_usage_limits", "get_provider_health"].includes(tool)) return "reading_usage";
  if (POMEGR_READ_TOOLS.includes(tool)) return "reading_sessions";
  return "thinking";
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads the provider's JSON lines and reports only three things: the answer text so far, one fixed activity label,
 * and how the turn ended. Tool input, tool output, and error text are never reported.
 * The turn is "starting" only until the process writes its first event. That event, whatever it holds, makes the activity
 * "thinking", and a tool, text, or other block then changes it. A label is reported when it changes.
 */
export function createTurnReader(provider, { onText = () => {}, onActivity: report = () => {}, onEvent = () => {}, onFirstText = () => {} } = {}) {
  let buffer = "";
  let overflow = false;
  let text = "";
  let final = null;
  let failed = false;
  let begun = false;
  let shown = null;
  const onActivity = (activity) => { if (activity !== shown) { shown = activity; report(activity); } };

  // `onEvent` and `onFirstText` only tell that something arrived, for the run's timing; they carry no content.
  const setText = (next) => { text = next.length > ANSWER_LIMIT ? next.slice(0, ANSWER_LIMIT) : next; if (text !== "") onFirstText(); onText(text); };

  function claude(event) {
    if (event.type === "stream_event" && isObject(event.event) && !event.parent_tool_use_id) {
      const inner = event.event;
      // Each message of the turn starts the shown text again: the last one is the answer.
      if (inner.type === "message_start") setText("");
      else if (inner.type === "content_block_start" && isObject(inner.content_block)) {
        if (inner.content_block.type === "tool_use") onActivity(activityForTool(inner.content_block.name));
        else if (inner.content_block.type === "text") onActivity("writing");
        else onActivity("thinking");
      } else if (inner.type === "content_block_delta" && isObject(inner.delta) && inner.delta.type === "text_delta" && typeof inner.delta.text === "string") {
        setText(text + inner.delta.text);
      }
      return;
    }
    if (event.type === "result") {
      failed = event.is_error === true || event.subtype !== "success";
      if (!failed && typeof event.result === "string") final = event.result;
    }
  }

  function codex(event) {
    const item = isObject(event.item) ? event.item : null;
    if (event.type === "turn.started") onActivity("thinking");
    else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && item) {
      if (item.type === "agent_message" && typeof item.text === "string") {
        onActivity("writing");
        setText(item.text);
        if (event.type === "item.completed") final = item.text;
      } else if (item.type === "mcp_tool_call") onActivity(activityForTool(item.tool));
      else if (item.type === "command_execution") onActivity("reading_files");
      else onActivity("thinking");
    } else if (event.type === "turn.failed" || event.type === "error") failed = true;
  }

  function line(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return;
    let event;
    try { event = JSON.parse(trimmed); } catch { return; }
    if (!isObject(event) || typeof event.type !== "string") return;
    onEvent();
    // The first event shows the provider process is up and working on the turn. Claude writes its `system` init first and
    // Codex its `thread.started`; a block in the same event then replaces the label.
    if (!begun) { begun = true; onActivity("thinking"); }
    if (provider === "claude") claude(event); else codex(event);
  }

  return {
    push(chunk) {
      if (overflow) return;
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
      // One line past the bound is not an answer; the turn then ends as failed.
      if (buffer.length > STDOUT_LINE_LIMIT) { overflow = true; buffer = ""; failed = true; }
    },
    end() {
      if (!overflow && buffer) line(buffer);
      buffer = "";
      const answer = typeof final === "string" ? (final.length > ANSWER_LIMIT ? final.slice(0, ANSWER_LIMIT) : final) : null;
      return { ok: !failed && answer !== null, text: answer ?? text };
    },
  };
}

/**
 * Starts one turn and answers `{ status, text }` when the run ends: `complete`, `failed`, `timed_out`, or `stopped`.
 * `stop()` ends Pomegr's own headless run; it is never a session the owner started. `timing()` answers the milliseconds the run
 * took, from the start of the process to its first provider event, to the first words of the answer, and to its end, or null before
 * the process started. They are numbers only. `clock` is a monotonic clock in milliseconds.
 */
export function runChatTurn({ spawn, executable, provider, model = null, effort = null, mcpServer = null, images = null, sessionId = null, instructionsFile = null, tools = "read", cwd, env, prompt, timeoutMs = TURN_TIMEOUT_MS, onText, onActivity, clock = () => performance.now() }) {
  const args = chatArguments(provider, model, mcpServer, images, sessionId, instructionsFile, effort, tools);
  let child = null;
  let stopped = false;
  let timedOut = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  if (!args || typeof executable !== "string" || typeof prompt !== "string" || !prompt) {
    settle({ status: "failed", text: "" });
    return { done, stop() {}, timing: () => null };
  }
  let begun = null;
  let eventAt = null;
  let textAt = null;
  let doneAt = null;
  const reader = createTurnReader(provider, { onText, onActivity, onEvent: () => { eventAt ??= clock(); }, onFirstText: () => { textAt ??= clock(); } });
  let finished = false;
  let timer;
  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    doneAt = clock();
    const result = reader.end();
    const status = stopped ? "stopped" : timedOut ? "timed_out" : result.ok && exitCode === 0 ? "complete" : "failed";
    settle({ status, text: result.text });
  };
  const kill = () => { try { child?.kill?.(); } catch { /* already gone */ } };
  try {
    const capability = validServer(mcpServer) ? Object.fromEntries(CHAT_TASK_ENV
      .filter((name) => Object.hasOwn(mcpServer.env, name)).map((name) => [name, mcpServer.env[name]])) : {};
    const processEnvironment = Object.keys(capability).length > 0 ? { ...env, ...capability } : env;
    begun = clock();
    child = spawn(executable, args, { cwd, env: processEnvironment, shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => reader.push(String(chunk)));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    // A closed pipe is reported by the exit, not here.
    child.stdin?.on?.("error", () => {});
    child.stdin?.end?.(prompt, "utf8");
    timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref?.();
  } catch {
    finish(null);
  }
  const since = (instant) => (begun === null || instant === null ? null : Math.max(0, instant - begun));
  return {
    done,
    stop() { if (!finished) { stopped = true; kill(); } },
    timing: () => (begun === null || doneAt === null ? null : { eventMs: since(eventAt), textMs: since(textAt), doneMs: since(doneAt) }),
  };
}
