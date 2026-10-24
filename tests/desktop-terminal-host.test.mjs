import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import childProcess, { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restrictDirectory, startTerminalHost } from '../desktop/terminal-host/host.mjs';
import { VERSION, encodeFrame, decodeFrames } from '../desktop/terminal-host/protocol.mjs';
import { Scrollback } from '../desktop/terminal-host/scrollback.mjs';

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
class FakePty extends EventEmitter {
  pid = 123;
  writes = [];
  sizes = [];
  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
  write(data) { this.writes.push(data); }
  resize(...size) { this.sizes.push(size); }
  output(data) { this.emit('data', data); }
  exit(exitCode = 0) { this.emit('exit', { exitCode }); }
}
async function fixture(t, options = {}) {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'pomegr-terminal-test-'));
  await restrictDirectory(runtimeDirectory);
  const ptys = [];
  const calls = [];
  const host = await startTerminalHost({ runtimeDirectory, spawnPty(...args) {
    calls.push(args);
    const pty = new FakePty(); ptys.push(pty); return pty;
  }, ...options });
  const clients = [];
  t.after(async () => { for (const client of clients) client.socket.destroy(); await host.close(); await rm(runtimeDirectory, { recursive: true, force: true }); });
  const token = await readFile(path.join(runtimeDirectory, 'host.token'), 'utf8');
  async function connect(authenticate = true) {
    const socket = net.connect(host.pipe);
    await once(socket, 'connect');
    const frames = [];
    const waiting = [];
    decodeFrames(socket, (frame) => { frames.push(frame); for (const wake of waiting.splice(0)) wake(); });
    let id = 0;
    async function next(predicate) {
      for (;;) {
        const index = frames.findIndex(predicate);
        if (index !== -1) return frames.splice(index, 1)[0];
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('frame timeout')), 2000); waiting.push(() => { clearTimeout(timer); resolve(); }); });
      }
    }
    const client = { socket, frames, next, async request(command, fields = {}) {
      const requestId = ++id; socket.write(encodeFrame({ id: requestId, command, ...fields }));
      return next((frame) => frame.id === requestId);
    } };
    clients.push(client);
    if (authenticate) assert.deepEqual(await client.request('hello', { token, protocol: VERSION }), { id: 1, ok: true, protocol: 1 });
    return client;
  }
  const plan = (key = 'synthetic') => ({ key, executable: process.execPath, args: ['fake.mjs'], cwd: runtimeDirectory, env: { PATH: process.env.PATH || '', POMEGR_TASK_TOKEN: 'test-token' }, cols: 80, rows: 24 });
  return { host, connect, ptys, calls, plan, runtimeDirectory, token };
}

test('framing handles fragmentation and rejects oversized and malformed input', async () => {
  const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
  const frames = []; decodeFrames(socket, (frame) => frames.push(frame));
  const bytes = encodeFrame({ id: 1, command: 'list' });
  socket.emit('data', bytes.subarray(0, 2)); socket.emit('data', bytes.subarray(2, 7)); socket.emit('data', bytes.subarray(7));
  assert.deepEqual(frames, [{ id: 1, command: 'list' }]);
  const header = Buffer.alloc(4); header.writeUInt32BE(65537); socket.emit('data', header);
  assert.equal(socket.destroyed, true);
  assert.throws(() => encodeFrame({ data: 'x'.repeat(65536) }));
});

test('managed keys preserve repository, task and nonce while rejecting arbitrary slash paths', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const key = `repo-${'a'.repeat(24)}/T-3/${'b'.repeat(32)}`;
  assert.equal((await client.request('create', { plan: f.plan(key) })).ok, true);
  assert.equal((await client.request('list')).sessions[0].key, key);
  for (const key of ['repo/T-3/nonce', '../synthetic', `repo-${'a'.repeat(24)}/T-03/${'b'.repeat(32)}`]) {
    assert.equal((await client.request('create', { plan: f.plan(key) })).error, 'TERMINAL_INVALID');
  }
});

test('continue host keys accept only supported providers and UUID session identity', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  for (const provider of ['claude', 'codex']) {
    const key = `continue/${provider}/${id}/${'b'.repeat(32)}`;
    assert.equal((await client.request('create', { plan: f.plan(key) })).ok, true);
  }
  for (const key of [`continue/other/${id}/${'b'.repeat(32)}`, `continue/codex/../${'b'.repeat(32)}`, `continue/claude/not-a-uuid/${'b'.repeat(32)}`]) {
    assert.equal((await client.request('create', { plan: f.plan(key) })).error, 'TERMINAL_INVALID');
  }
});

test('a prepared host starts without any ACL subprocess', async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'pomegr-terminal-test-'));
  await restrictDirectory(runtimeDirectory);
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  t.mock.method(childProcess.ChildProcess.prototype, 'spawn', () => { throw new Error('unexpected startup subprocess'); });
  const host = await startTerminalHost({ runtimeDirectory, spawnPty() {} });
  await host.close();
});

test('a temporarily occupied pipe is retried without replacing the incumbent token', async (t) => {
  const f = await fixture(t);
  // Release the incumbent only after the replacement has actually attempted to bind.
  const listen = net.Server.prototype.listen;
  let attempts = 0;
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    attempts++;
    if (attempts === 1) this.once('error', async (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      assert.equal(await readFile(path.join(f.runtimeDirectory, 'host.token'), 'utf8'), f.token);
      await f.host.close();
    });
    return listen.apply(this, args);
  });
  const replacement = await startTerminalHost({ runtimeDirectory: f.runtimeDirectory, spawnPty() {} });
  t.after(() => replacement.close());
  assert.ok(attempts > 1);
  assert.notEqual(await readFile(path.join(f.runtimeDirectory, 'host.token'), 'utf8'), f.token);
});

test('scrollback cap preserves Unicode and complete ANSI across chunks', () => {
  const replay = new Scrollback(48);
  replay.append('old'.repeat(40)); replay.append('\x1b[38;2;'); replay.append('1;2;3m'); replay.append('\u{1f600}'.repeat(12));
  const text = replay.read().join('');
  assert.ok(Buffer.byteLength(text) <= 48);
  assert.equal(text.includes('\ufffd'), false);
  assert.equal(text.startsWith('[38'), false);
  assert.equal(text, '\u{1f600}'.repeat(12));
  const split = new Scrollback(128); split.append('a\x1b]title');
  assert.equal(split.read().join(''), 'a'); split.append('\x1b\\b\ud83d'); split.append('\ude00');
  assert.equal(split.read().join(''), 'a\x1b]title\x1b\\b\u{1f600}');
});

test('auth gates all commands; token and state remain private and singleton bind preserves token', async (t) => {
  const f = await fixture(t);
  assert.match(f.token, /^[a-f0-9]{64}$/u);
  const state = JSON.parse(await readFile(path.join(f.runtimeDirectory, 'host.json'), 'utf8'));
  assert.deepEqual(state, { pid: process.pid, pipe: f.host.pipe, protocol: 1 });
  await assert.rejects(startTerminalHost({ runtimeDirectory: f.runtimeDirectory, spawnPty() {} }));
  assert.equal(await readFile(path.join(f.runtimeDirectory, 'host.token'), 'utf8'), f.token);
  for (const [command, fields] of [['list', {}], ['hello', { token: f.token, protocol: 2 }], ['hello', { token: '0'.repeat(64), protocol: 1 }]]) {
    const unauth = await f.connect(false);
    const closed = once(unauth.socket, 'close');
    unauth.socket.write(encodeFrame({ id: 1, command, ...fields }));
    await closed; assert.deepEqual(unauth.frames, []);
  }
  assert.equal(f.calls.length, 0);
});

test('create, list, attach, input, resize, detach and exit preserve one writer', async (t) => {
  const f = await fixture(t); const a = await f.connect(); const b = await f.connect();
  assert.equal((await a.request('create', { plan: f.plan() })).ok, true);
  assert.equal(f.calls[0][2].useConptyDll, true);
  assert.equal(f.calls[0][0], process.execPath); assert.deepEqual(f.calls[0][1], ['fake.mjs']);
  assert.equal((await a.request('attach', { key: 'synthetic' })).readOnly, false);
  assert.equal((await b.request('attach', { key: 'synthetic' })).readOnly, true);
  assert.equal((await b.request('input', { key: 'synthetic', data: 'no' })).error, 'TERMINAL_READ_ONLY');
  assert.equal((await a.request('input', { key: 'synthetic', data: 'hello\r' })).ok, true);
  assert.equal((await a.request('resize', { key: 'synthetic', cols: 120, rows: 40 })).ok, true);
  assert.deepEqual(f.ptys[0].writes, ['hello\r']); assert.deepEqual(f.ptys[0].sizes, [[120, 40]]);
  f.ptys[0].output('synthetic output');
  assert.equal((await a.next((frame) => frame.event === 'output')).data, 'synthetic output');
  assert.equal((await b.next((frame) => frame.event === 'output')).data, 'synthetic output');
  await a.request('detach', { key: 'synthetic' }); await b.request('detach', { key: 'synthetic' });
  assert.equal((await b.request('attach', { key: 'synthetic' })).readOnly, false);
  f.ptys[0].exit(7); assert.equal((await b.next((frame) => frame.event === 'exit')).exitCode, 7);
  const list = await a.request('list'); assert.equal(list.sessions[0].exitCode, 7);
  await b.request('detach', { key: 'synthetic', acknowledge: true });
  assert.deepEqual((await a.request('list')).sessions, []);
});

test('validates start plans, session cap, dimensions, commands and input byte bounds', async (t) => {
  const f = await fixture(t); const a = await f.connect();
  for (const bad of [{ executable: 'relative.exe' }, { cwd: 'relative' }, { args: ['ok', 3] }, { env: { 'BAD-NAME': 'value' } }, { cols: 0 }, { rows: 1001 }, { key: '../bad' }]) {
    assert.equal((await a.request('create', { plan: { ...f.plan(), ...bad } })).error, 'TERMINAL_INVALID');
  }
  assert.equal(f.calls.length, 0);
  for (let i = 0; i < 16; i++) assert.equal((await a.request('create', { plan: f.plan(`s${i}`) })).ok, true);
  assert.equal((await a.request('create', { plan: f.plan('extra') })).error, 'TERMINAL_CAPACITY');
  await a.request('attach', { key: 's0' });
  assert.equal((await a.request('resize', { key: 's0', cols: 0, rows: 20 })).error, 'TERMINAL_INVALID');
  assert.equal((await a.request('kill', { key: 's0' })).error, 'UNKNOWN_COMMAND');
  for (let i = 0; i < 3; i++) {
    f.ptys[i].exit();
    assert.equal((await a.request('detach', { key: `s${i}`, acknowledge: true })).ok, true);
    assert.equal((await a.request('create', { plan: f.plan(`replacement${i}`) })).ok, true);
  }
  assert.equal((await a.request('list')).sessions.length, 16);
});

test('create preserves inherited environment names and fits a 48 KiB environment plus a task prompt in one frame', async (t) => {
  const f = await fixture(t); const client = await f.connect();
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', HTTPS_PROXY: 'http://proxy.test:8080',
    NODE_EXTRA_CA_CERTS: 'C:\\certs\\owner.pem', GIT_SSH_COMMAND: 'ssh', ANTHROPIC_API_KEY: 'synthetic-key',
    NODE_OPTIONS: '--max-old-space-size=4096', PATH: 'C:\\Windows;C:\\Program Files\\nodejs',
    OWNER_SETTING: 'x'.repeat(32767), OWNER_SETTINGS_REST: '' };
  env.OWNER_SETTINGS_REST = 'x'.repeat(48 * 1024 - Buffer.byteLength(JSON.stringify(env)));
  assert.equal(Buffer.byteLength(JSON.stringify(env)), 48 * 1024);
  const plan = { ...f.plan(), env, args: ['--model', 'synthetic', 'task '.repeat(1600)] };
  assert.ok(encodeFrame({ id: 2, command: 'create', plan }).length <= 64 * 1024 + 4);
  assert.equal((await client.request('create', { plan })).ok, true);
  assert.deepEqual(f.calls[0][2].env, env);
  const many = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`OWNER_${i}`, 'value']));
  assert.equal((await client.request('create', { plan: { ...f.plan('many'), env: many } })).ok, true);
  assert.deepEqual(f.calls[1][2].env, many);
});

test('create refuses malformed and oversized environments without spawning', async (t) => {
  const f = await fixture(t); const client = await f.connect();
  const oversized = { PATH: 'x'.repeat(24000), HOME: 'x'.repeat(25132) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 48 * 1024);
  for (const env of [null, [], 'value', { 'BAD-NAME': 'value' }, { '1NAME': 'value' },
    { ['A'.repeat(129)]: 'value' }, Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`OWNER_${i}`, 'value'])),
    { PATH: 'x'.repeat(32768) }, { 'PA\0TH': 'value' }, { PATH: 'bad\0value' }, { PATH: 42 }, oversized]) {
    assert.equal((await client.request('create', { plan: { ...f.plan(), env } })).error, 'TERMINAL_INVALID');
  }
  assert.equal(f.calls.length, 0);
});

test('replay is bounded and split into legal frames; exit discards replay', async (t) => {
  const f = await fixture(t); const a = await f.connect();
  await a.request('create', { plan: f.plan() });
  f.ptys[0].output('\x1b[32m' + '\u{1f600}'.repeat(90000));
  assert.equal((await a.request('attach', { key: 'synthetic' })).ok, true);
  const replay = a.frames.filter((frame) => frame.replay);
  assert.equal(Buffer.byteLength(replay.map((frame) => frame.data).join('')), 256 * 1024);
  for (const frame of replay) assert.ok(encodeFrame(frame).length <= 65540);
  f.ptys[0].exit(); await a.request('detach', { key: 'synthetic' });
  a.frames.length = 0; await a.request('attach', { key: 'synthetic' });
  assert.equal(a.frames.some((frame) => frame.replay), false);
  assert.equal((await a.next((frame) => frame.event === 'exit')).exitCode, 0);
});

test('idle waits for both live PTYs and authenticated clients and authentication has a deadline', async (t) => {
  const timers = new Map(); let sequence = 0; let idle = 0;
  const f = await fixture(t, { setTimer(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimer(id) { timers.delete(id); }, onIdle() { idle++; } });
  assert.equal([...timers.values()].filter((timer) => timer.ms === 60000).length, 1);
  const initialIdleId = [...timers].find(([, timer]) => timer.ms === 60000)[0];
  const pending = await f.connect(false); await pause();
  const deadline = [...timers.values()].find((timer) => timer.ms === 2000); assert.ok(deadline); deadline.fn();
  await once(pending.socket, 'close'); await pause(); assert.equal(timers.has(initialIdleId), true);
  const a = await f.connect(); assert.equal([...timers.values()].some((timer) => timer.ms === 60000), false);
  await a.request('create', { plan: f.plan() }); a.socket.destroy(); await pause(); await pause();
  assert.equal([...timers.values()].some((timer) => timer.ms === 60000), false);
  f.ptys[0].exit();
  const timer = [...timers.values()].find((entry) => entry.ms === 60000); assert.ok(timer); timer.fn();
  assert.equal(idle, 1);
});




test('malformed JSON, invalid UTF8 and oversized input disconnect', () => {
  for (const body of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from(JSON.stringify({ command: 'input', data: 'x'.repeat(16384) }))]) {
    const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
    let called = false; decodeFrames(socket, () => { called = true; });
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length); socket.emit('data', Buffer.concat([header, body]));
    assert.equal(socket.destroyed, true); assert.equal(called, false);
  }
});

test('four unauthenticated and eight total connections are hard caps', async (t) => {
  const f = await fixture(t); const unauthenticated = [];
  for (let i = 0; i < 4; i++) unauthenticated.push(await f.connect(false));
  await pause(); const fifth = net.connect(f.host.pipe); await once(fifth, 'close');
  for (const client of unauthenticated) client.socket.destroy(); await pause();
  for (let i = 0; i < 8; i++) await f.connect();
  const ninth = net.connect(f.host.pipe); await once(ninth, 'close');
});

test('a slow socket detaches without blocking PTY writes or another attachment', async (t) => {
  const f = await fixture(t); const a = await f.connect();
  await a.request('create', { plan: f.plan() }); await a.request('attach', { key: 'synthetic' });
  a.socket.pause(); f.ptys[0].output('x'.repeat(4 * 1024 * 1024)); a.socket.resume();
  assert.equal((await a.next((frame) => frame.event === 'detached')).reason, 'slow_client');
  assert.equal((await a.request('input', { key: 'synthetic', data: 'no' })).error, 'TERMINAL_READ_ONLY');
  const b = await f.connect(); assert.equal((await b.request('attach', { key: 'synthetic' })).readOnly, false);
  await b.request('input', { key: 'synthetic', data: '/exit\r' }); assert.deepEqual(f.ptys[0].writes, ['/exit\r']);
});

test('worst-case JSON escaping still delivers bounded replay and attach response', async (t) => {
  const f = await fixture(t); const a = await f.connect();
  await a.request('create', { plan: f.plan() }); f.ptys[0].output('\x01'.repeat(256 * 1024));
  assert.equal((await a.request('attach', { key: 'synthetic' })).ok, true);
  assert.equal(a.frames.filter((frame) => frame.replay).reduce((size, frame) => size + Buffer.byteLength(frame.data), 0), 256 * 1024);
});

test('scrollback prefers complete lines and drops oversized unfinished ANSI sequences', () => {
  const lines = new Scrollback(12); lines.append('old\npartial\nlast\n'); assert.equal(lines.read().join(''), 'last\n');
  const escaped = new Scrollback(32); escaped.append('\x1b]' + 'x'.repeat(10000)); escaped.append('\x07safe');
  assert.equal(escaped.read().join(''), 'safe');
  const controls = new Scrollback(32); controls.append('\x9b31'); assert.deepEqual(controls.read(), []);
  controls.append('mred'); assert.equal(controls.read().join(''), '\x9b31mred');
});

test('real ConPTY fake CLI supports Unicode, resize, paste, interrupt and natural idle exit', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pomegr-native-terminal-'));
  await restrictDirectory(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
    import net from 'node:net';
    import pty from 'node-pty';
    import { readFile } from 'node:fs/promises';
    import { once } from 'node:events';
    import { createHash } from 'node:crypto';
    const { startTerminalHost } = await import(process.argv[2] + 'desktop/terminal-host/host.mjs');
    const { encodeFrame, decodeFrames } = await import(process.argv[2] + 'desktop/terminal-host/protocol.mjs');
    const host = await startTerminalHost({ runtimeDirectory: process.argv[1], spawnPty: pty.spawn, idleMilliseconds: 1500, onIdle: () => process.exit(0) });
    const socket = net.connect(host.pipe); await once(socket, 'connect');
    const responses = new Map(); let output = ''; let exited = false; let id = 0;
    decodeFrames(socket, (frame) => { if (frame.id) { responses.get(frame.id)?.(frame); responses.delete(frame.id); } else if (frame.event === 'output') output += frame.data; else if (frame.event === 'exit') exited = true; });
    function request(command, fields = {}) { return new Promise((resolve) => { const current = ++id; responses.set(current, resolve); socket.write(encodeFrame({ id: current, command, ...fields })); }); }
    async function until(predicate) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('synthetic timeout: ' + output); }
    const auth = await request('hello', { token: await readFile(process.argv[1] + '/host.token', 'utf8'), protocol: 1 });
    if (!auth.ok) throw new Error('auth');
    const started = await request('create', { plan: { key: 'native', executable: process.execPath, args: [process.argv[3]], cwd: process.argv[1], env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' }, cols: 80, rows: 24 } });
    if (!started.ok) throw new Error('spawn');
    await request('attach', { key: 'native' }); await until(() => output.includes('READY synthetic ' + String.fromCodePoint(0x1f600)));
    await request('resize', { key: 'native', cols: 120, rows: 40 });
    await request('input', { key: 'native', data: '/size\r' }); await until(() => output.includes('SIZE 120x40'));
    const pasted = '0123456789'.repeat(1024); const digest = createHash('sha256').update(pasted).digest('hex');
    await request('input', { key: 'native', data: pasted + '\r' }); await until(() => output.includes('ECHO 10240 ' + digest));
    await request('input', { key: 'native', data: '\x03' }); await until(() => output.includes('INTERRUPT'));
    await request('input', { key: 'native', data: '/exit\r' }); await until(() => exited);
    socket.destroy(); console.log('SYNTHETIC_NATIVE_PASS');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, directory, new URL('../', import.meta.url).href, fileURLToPath(new URL('./fixtures/terminal-fake-cli.mjs', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; let error = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { error += data; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, error); assert.match(output, /SYNTHETIC_NATIVE_PASS/u);
});


