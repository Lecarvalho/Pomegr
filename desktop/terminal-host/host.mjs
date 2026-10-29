import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, chmod, writeFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { VERSION, encodeFrame, decodeFrames } from './protocol.mjs';

const run = promisify(execFile);
const { Terminal } = headless;
const { SerializeAddon } = serialize;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
function snapshot(session) {
  let scrollback = 5000;
  for (;;) {
    const data = session.serializer.serialize({ scrollback }) + session.mouseEncoding;
    if (Buffer.byteLength(data) <= MAX_REPLAY_BYTES) return data;
    // Drop whole oldest lines, never slice serialized cursor or mode sequences.
    if (scrollback === 0) return null;
    scrollback = Math.floor(scrollback / 2);
  }
}
// The serializer restores mouse tracking but not its encoding; without SGR, a fresh view
// reports the wheel in the default encoding and the session never receives it.
function trackMouseEncoding(session) {
  const modes = (set) => (params) => {
    for (const mode of params) if (mode === 1006 || mode === 1016) session.mouseEncoding = set ? `\x1b[?${mode}h` : '';
    return false;
  };
  session.screen.parser.registerCsiHandler({ prefix: '?', final: 'h' }, modes(true));
  session.screen.parser.registerCsiHandler({ prefix: '?', final: 'l' }, modes(false));
  session.screen.parser.registerEscHandler({ final: 'c' }, () => { session.mouseEncoding = ''; return false; });
}
function disposeScreen(session) {
  session.screen?.dispose(); session.screen = null; session.serializer = null;
}
const keyValid = (key) => typeof key === 'string' && (/^[a-zA-Z0-9_-]{1,128}$/u.test(key)
  || /^repo-[a-f0-9]{24}\/T-[1-9][0-9]{0,8}\/(?:review-)?[a-f0-9]{32}$/u.test(key)
  || /^continue\/(?:claude|codex)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{32}$/iu.test(key));
const sizeValid = (cols, rows) => Number.isInteger(cols) && cols >= 1 && cols <= 1000 && Number.isInteger(rows) && rows >= 1 && rows <= 1000;
const stringValid = (value, max) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
function planValid(plan) {
  return plan && keyValid(plan.key) && stringValid(plan.executable, 32768) && path.isAbsolute(plan.executable)
    && stringValid(plan.cwd, 32768) && path.isAbsolute(plan.cwd) && Array.isArray(plan.args) && plan.args.length <= 128
    && plan.args.every((arg) => stringValid(arg, 16384)) && Buffer.byteLength(JSON.stringify(plan.args)) <= 32768
    && sizeValid(plan.cols, plan.rows) && plan.env && typeof plan.env === 'object' && !Array.isArray(plan.env)
    && Object.keys(plan.env).length <= 512
    && Object.entries(plan.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/u.test(key)
      && typeof value === 'string' && value.length <= 32767 && !value.includes('\0'))
    && Buffer.byteLength(JSON.stringify(plan.env)) <= 48 * 1024;
}

export async function restrictDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  } catch { throw new Error('TERMINAL_RUNTIME_PRIVATE'); }
  const script = `$ErrorActionPreference='Stop'; $p='${directory.replaceAll("'", "''")}'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); ([System.IO.DirectoryInfo]::new($p)).SetAccessControl($acl)`;
  try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }); }
  catch { throw new Error('TERMINAL_RUNTIME_PRIVATE'); }
}

// Ends the process with this ID and every process it started, such as the MCP servers a provider CLI runs.
// The ID is one the caller read from a terminal it owns; nothing else is named, and no shell sees the call.
export async function killProcessTree(pid, runner = run) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (process.platform !== 'win32') { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } }
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  try { await runner(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); return true; }
  catch { return false; }
}

export async function startTerminalHost({ runtimeDirectory, spawnPty, killTree = killProcessTree, setTimer = setTimeout, clearTimer = clearTimeout, idleMilliseconds = 60000, onIdle = () => {} }) {
  // Desktop main prepares the private directory before launching this process.
  const suffix = createHash('sha256').update(path.resolve(runtimeDirectory).toLowerCase()).digest('hex').slice(0, 32);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\pomegr-terminal-${suffix}` : path.join(runtimeDirectory, 'host.sock');
  const token = randomBytes(32).toString('hex');
  const clients = new Set(); const sessions = new Map();
  let idleTimer; let closing = false;
  function checkIdle() {
    const active = [...clients].some((client) => client.authenticated) || [...sessions.values()].some((session) => !session.exited);
    if (active && idleTimer !== undefined) { clearTimer(idleTimer); idleTimer = undefined; }
    if (!closing && !active && idleTimer === undefined) {
      idleTimer = setTimer(() => { idleTimer = undefined; if (!closing) onIdle(); }, idleMilliseconds);
    }
  }
  function detach(client, key) {
    const session = sessions.get(key);
    if (session) { session.clients.delete(client); if (session.writer === client) session.writer = null; }
    client.attached.delete(key);
  }
  function send(client, frame, output = false) {
    if (client.socket.destroyed) return false;
    const bytes = encodeFrame(frame);
    // JSON can expand one replay byte to six; pending replay never spends the live budget.
    const replay = frame.replay === true;
    const queueLimit = replay ? MAX_REPLAY_BYTES * 6 + 512 * 1024 : 512 * 1024 + client.replayBytes;
    if (client.socket.writableLength + bytes.length > queueLimit) {
      if (output) {
        detach(client, frame.key);
        // A detached notification is tiny; if even that cannot fit, disconnect.
        if (client.socket.writableLength < 512 * 1024) client.socket.write(encodeFrame({ event: 'detached', key: frame.key, reason: 'slow_client' }));
        else client.socket.destroy();
      } else client.socket.destroy();
      return false;
    }
    if (replay) client.replayBytes += bytes.length;
    client.socket.write(bytes, () => { if (replay) client.replayBytes -= bytes.length; }); return true;
  }
  function output(client, key, data, replay = false) {
    let chunk = '';
    for (const character of data) {
      if (chunk.length + character.length > 4096) {
        if (!send(client, { event: 'output', key, data: chunk, ...(replay ? { replay: true } : {}) }, true)) return false;
        chunk = '';
      }
      chunk += character;
      if (chunk.length >= 4096) { if (!send(client, { event: 'output', key, data: chunk, ...(replay ? { replay: true } : {}) }, true)) return false; chunk = ''; }
    }
    return !chunk || send(client, { event: 'output', key, data: chunk, ...(replay ? { replay: true } : {}) }, true);
  }
  function command(client, frame) {
    const id = frame.id;
    if (!(typeof id === 'string' && id.length <= 128) && !(Number.isSafeInteger(id) && id >= 0)) { client.socket.destroy(); return; }
    const reply = (fields) => send(client, { id, ok: true, ...fields });
    const fail = (error) => send(client, { id, ok: false, error });
    if (!client.authenticated) {
      const supplied = typeof frame.token === 'string' ? Buffer.from(frame.token) : Buffer.alloc(0);
      if (client.first || frame.command !== 'hello' || supplied.length !== 64 || !timingSafeEqual(supplied, Buffer.from(token))) {
        client.socket.destroy(); return;
      }
      client.first = true;
      if (frame.protocol !== VERSION) { client.socket.destroy(); return; }
      client.authenticated = true; clearTimer(client.authTimer); checkIdle(); reply({ protocol: VERSION }); return;
    }
    if (frame.command === 'list') {
      reply({ sessions: [...sessions.values()].map(({ key, pty, exited, exitCode }) => ({ key, pid: pty.pid, exited, ...(exited ? { exitCode } : {}) })) }); return;
    }
    if (frame.command === 'create') {
      if (!planValid(frame.plan)) { fail('TERMINAL_INVALID'); return; }
      const plan = frame.plan;
      if (sessions.has(plan.key)) { fail('TERMINAL_INVALID'); return; }
      if (sessions.size >= 16) { fail('TERMINAL_CAPACITY'); return; }
      let pty;
      try { pty = spawnPty(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, cols: plan.cols, rows: plan.rows, name: 'xterm-256color', useConptyDll: true }); }
      catch { fail('TERMINAL_SPAWN_FAILED'); return; }
      const screen = new Terminal({ cols: plan.cols, rows: plan.rows, scrollback: 5000, allowProposedApi: true });
      const serializer = new SerializeAddon(); screen.loadAddon(serializer);
      const session = { key: plan.key, pty, clients: new Set(), writer: null, screen, serializer, mouseEncoding: '', exited: false };
      trackMouseEncoding(session);
      sessions.set(plan.key, session);
      pty.onData((data) => {
        if (session.exited || closing) return;
        screen.write(data, () => {
          for (const attached of [...session.clients]) output(attached, plan.key, data);
        });
      });
      pty.onExit(({ exitCode }) => {
        if (session.exited || closing) return;
        session.exited = true; session.exitCode = Number.isInteger(exitCode) ? exitCode : -1;
        screen.write('', () => {
          disposeScreen(session);
          for (const attached of session.clients) send(attached, { event: 'exit', key: plan.key, exitCode: session.exitCode });
        });
        checkIdle();
      });
      checkIdle(); reply({ key: plan.key, pid: pty.pid }); return;
    }
    if (frame.command === 'end') {
      const target = sessions.get(frame.key);
      if (!target) { fail('TERMINAL_NOT_FOUND'); return; }
      if (target.exited) { reply({}); return; }
      // The process tree ends here, in the host that started it; the exit event and `list` then report it.
      void (async () => {
        if (!await killTree(target.pty.pid) && !target.exited) {
          try { target.pty.kill(); } catch { fail('TERMINAL_INVALID'); return; }
        }
        reply({});
      })();
      return;
    }
    if (!['attach', 'input', 'resize', 'detach'].includes(frame.command)) { fail('UNKNOWN_COMMAND'); return; }
    const session = sessions.get(frame.key);
    if (!session) { fail('TERMINAL_NOT_FOUND'); return; }
    if (frame.command === 'attach') {
      session.clients.delete(client);
      const attachment = {};
      client.attached.set(frame.key, attachment);
      const attach = () => {
        if (closing || client.socket.destroyed || client.attached.get(frame.key) !== attachment || sessions.get(frame.key) !== session) return;
        const replay = session.screen ? snapshot(session) : '';
        if (replay === null) { detach(client, frame.key); fail('TERMINAL_CAPACITY'); return; }
        if (!output(client, frame.key, replay, true)) return;
        // This callback is the stream boundary: prior writes are in replay; later
        // write callbacks see this client only after its complete replay is sent.
        session.clients.add(client);
        if (!session.exited && !session.writer) session.writer = client;
        reply({ readOnly: session.exited || session.writer !== client });
        if (!session.screen) send(client, { event: 'exit', key: frame.key, exitCode: session.exitCode });
      };
      if (session.screen) session.screen.write('', attach); else attach();
      return;
    }
    if (frame.command === 'detach') {
      detach(client, frame.key);
      if (frame.acknowledge === true && session.exited) {
        for (const attached of [...session.clients]) detach(attached, frame.key);
        disposeScreen(session);
        sessions.delete(frame.key);
      }
      reply({}); return;
    }
    if (session.exited || session.writer !== client) { fail('TERMINAL_READ_ONLY'); return; }
    try {
      if (frame.command === 'input') {
        if (typeof frame.data !== 'string' || Buffer.byteLength(frame.data) > 16 * 1024) { fail('TERMINAL_INVALID'); return; }
        session.pty.write(frame.data);
      } else {
        if (!sizeValid(frame.cols, frame.rows)) { fail('TERMINAL_INVALID'); return; }
        session.pty.resize(frame.cols, frame.rows);
        session.screen.resize(frame.cols, frame.rows);
      }
      reply({});
    } catch { fail('TERMINAL_INVALID'); }
  }
  const server = net.createServer((socket) => {
    if (clients.size >= 8 || [...clients].filter((client) => !client.authenticated).length >= 4) { socket.destroy(); return; }
    const client = { socket, authenticated: false, first: false, attached: new Map(), replayBytes: 0 };
    clients.add(client);
    client.authTimer = setTimer(() => socket.destroy(), 2000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimer(client.authTimer); for (const key of client.attached.keys()) detach(client, key); clients.delete(client); checkIdle();
    });
    decodeFrames(socket, (frame) => command(client, frame));
  });
  // Windows can retain a pipe instance briefly after its owning process exits.
  // Binding still decides singleton ownership; publish no token or state until it succeeds.
  const bindDeadline = Date.now() + 1000;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const listening = () => { server.off('error', failed); resolve(); };
        const failed = (error) => { server.off('listening', listening); reject(error); };
        server.once('error', failed); server.once('listening', listening); server.listen(pipe);
      });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= bindDeadline) throw new Error('TERMINAL_UNAVAILABLE', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async function close() {
    if (closing) return; closing = true;
    if (idleTimer !== undefined) clearTimer(idleTimer);
    for (const client of clients) client.socket.destroy();
    for (const session of sessions.values()) disposeScreen(session);
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    for (const [name, data] of [['host.token', token], ['host.json', JSON.stringify({ pid: process.pid, pipe, protocol: VERSION })]]) {
      const temporary = path.join(runtimeDirectory, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path.join(runtimeDirectory, name)); }
      finally { await rm(temporary, { force: true }); }
    }
  } catch (error) { await close(); throw new Error('TERMINAL_RUNTIME_PRIVATE', { cause: error }); }
  checkIdle();
  return { pipe, protocol: VERSION, close };
}


