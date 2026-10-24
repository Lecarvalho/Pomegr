import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, chmod, writeFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VERSION, encodeFrame, decodeFrames } from './protocol.mjs';
import { Scrollback } from './scrollback.mjs';

const run = promisify(execFile);
const ENVIRONMENT_NAMES = new Set(('LANG LANGUAGE LC_ALL LC_CTYPE NUMBER_OF_PROCESSORS OS PATHEXT PROCESSOR_ARCHITECTURE PROCESSOR_IDENTIFIER PROCESSOR_LEVEL PROCESSOR_REVISION SYSTEMDRIVE SYSTEMROOT TEMP TMP TZ WINDIR APPDATA CLAUDE_CONFIG_DIR CODEX_HOME HOME HOMEDRIVE HOMEPATH LOCALAPPDATA USERPROFILE PATH POMEGR_CODEX_EXECUTABLE POMEGR_TASK_TOKEN').split(' '));
const keyValid = (key) => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(key);
const sizeValid = (cols, rows) => Number.isInteger(cols) && cols >= 1 && cols <= 1000 && Number.isInteger(rows) && rows >= 1 && rows <= 1000;
const stringValid = (value, max) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
function planValid(plan) {
  return plan && keyValid(plan.key) && stringValid(plan.executable, 32768) && path.isAbsolute(plan.executable)
    && stringValid(plan.cwd, 32768) && path.isAbsolute(plan.cwd) && Array.isArray(plan.args) && plan.args.length <= 128
    && plan.args.every((arg) => stringValid(arg, 16384)) && Buffer.byteLength(JSON.stringify(plan.args)) <= 32768
    && sizeValid(plan.cols, plan.rows) && plan.env && typeof plan.env === 'object' && !Array.isArray(plan.env)
    && Object.entries(plan.env).every(([key, value]) => ENVIRONMENT_NAMES.has(key.toUpperCase()) && stringValid(value, 32768))
    && Buffer.byteLength(JSON.stringify(plan.env)) <= 32768;
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

export async function startTerminalHost({ runtimeDirectory, spawnPty, setTimer = setTimeout, clearTimer = clearTimeout, idleMilliseconds = 60000, onIdle = () => {} }) {
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
    const queueLimit = client.replaying ? 2 * 1024 * 1024 : 512 * 1024;
    if (client.socket.writableLength + bytes.length > queueLimit) {
      if (output) {
        detach(client, frame.key);
        // A detached notification is tiny; if even that cannot fit, disconnect.
        if (client.socket.writableLength < 512 * 1024) client.socket.write(encodeFrame({ event: 'detached', key: frame.key, reason: 'slow_client' }));
        else client.socket.destroy();
      } else client.socket.destroy();
      return false;
    }
    client.socket.write(bytes); return true;
  }
  function output(client, key, data, replay = false) {
    let chunk = '';
    for (const character of data) {
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
      const session = { key: plan.key, pty, clients: new Set(), writer: null, replay: new Scrollback(), exited: false };
      sessions.set(plan.key, session);
      pty.onData((data) => {
        if (session.exited) return;
        session.replay.append(data);
        for (const attached of [...session.clients]) output(attached, plan.key, data);
      });
      pty.onExit(({ exitCode }) => {
        session.exited = true; session.exitCode = Number.isInteger(exitCode) ? exitCode : -1; session.replay.clear();
        for (const attached of session.clients) send(attached, { event: 'exit', key: plan.key, exitCode: session.exitCode });
        checkIdle();
      });
      checkIdle(); reply({ key: plan.key, pid: pty.pid }); return;
    }
    if (!['attach', 'input', 'resize', 'detach'].includes(frame.command)) { fail('UNKNOWN_COMMAND'); return; }
    const session = sessions.get(frame.key);
    if (!session) { fail('TERMINAL_NOT_FOUND'); return; }
    if (frame.command === 'attach') {
      session.clients.add(client); client.attached.add(frame.key);
      if (!session.exited && !session.writer) session.writer = client;
      client.replaying = true;
      for (const data of session.replay.read()) if (!output(client, frame.key, data, true)) { client.replaying = false; return; }
      reply({ readOnly: session.exited || session.writer !== client });
      if (session.exited) send(client, { event: 'exit', key: frame.key, exitCode: session.exitCode });
      client.replaying = false; return;
    }
    if (frame.command === 'detach') {
      detach(client, frame.key);
      if (frame.acknowledge === true && session.exited) {
        for (const attached of [...session.clients]) detach(attached, frame.key);
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
      }
      reply({});
    } catch { fail('TERMINAL_INVALID'); }
  }
  const server = net.createServer((socket) => {
    if (clients.size >= 8 || [...clients].filter((client) => !client.authenticated).length >= 4) { socket.destroy(); return; }
    const client = { socket, authenticated: false, first: false, attached: new Set() };
    clients.add(client);
    client.authTimer = setTimer(() => socket.destroy(), 2000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimer(client.authTimer); for (const key of [...client.attached]) detach(client, key); clients.delete(client); checkIdle();
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


