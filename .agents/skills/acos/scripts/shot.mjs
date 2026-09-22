#!/usr/bin/env node
// Capture a cropped PNG of a running page, so a part can show what it changed.
//
//   node shot.mjs --url <url> --out <file.png> (--selector <css> | --full) [options]
//
// No install step: reuse Codex's bundled Playwright when present, otherwise
// drive a headless Chromium with Node's own fetch and WebSocket. Chrome is
// tried first, then Edge.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const USAGE = `shot - capture a cropped PNG of a running page

  node shot.mjs --url <url> --out <file.png> (--selector <css> | --full) [options]

  --url <url>         page to open (required)
  --out <file.png>    where to write the capture (required)
  --selector <css>    clip to this element's box
  --full              clip to the whole viewport instead
  --width <px>        viewport width (default 1440)
  --height <px>       viewport height (default 900)
  --dpr <n>           device pixel ratio (default 2)
  --pad <px>          pixels around the clip (default 0)
  --wait-for <css>    wait until this element exists before --eval runs
  --eval <js>         run after load, for a state no URL reaches
  --settle <ms>       wait after load and again after --eval (default 1500)
  --timeout <ms>      give up after this (default 30000)

Order of operations: navigate, load, --wait-for, --settle, --eval, --settle,
capture.
The --selector target is polled until --timeout, so it may be an element that
only --eval brings into existence.
Set ACOS_CHROME or CHROME_PATH to choose the browser binary. Set
ACOS_PLAYWRIGHT to an installed Playwright package directory to use it, or
to "off" to force the dependency-free CDP transport.`;

// Exit codes are distinct so a check command can tell the failures apart.
const E_USAGE = 2, E_NO_BROWSER = 3, E_NO_PORT = 4, E_TIMEOUT = 5, E_NO_MATCH = 6,
      E_EMPTY_BOX = 7, E_NO_IMAGE = 8, E_CDP = 9;

function die(code, message) {
  process.stderr.write(`shot: ${message}\n`);
  process.exit(code);
}

function failure(code, message) {
  return Object.assign(new Error(message), { exitCode: code });
}

function parseArgs(argv) {
  const flags = { width: 1440, height: 900, dpr: 2, pad: 0, settle: 1500, timeout: 30000 };
  const numeric = new Set(['width', 'height', 'dpr', 'pad', 'settle', 'timeout']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    if (!arg.startsWith('--')) die(E_USAGE, `unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'full') { flags.full = true; continue; }
    const value = argv[++i];
    if (value === undefined) die(E_USAGE, `${arg} needs a value`);
    if (numeric.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) die(E_USAGE, `${arg} needs a positive number`);
      flags[key] = n;
    } else {
      flags[key] = value;
    }
  }
  if (!flags.url) die(E_USAGE, 'missing --url');
  if (!flags.out) die(E_USAGE, 'missing --out');
  if (!!flags.selector === !!flags.full) die(E_USAGE, 'pass exactly one of --selector and --full');
  return flags;
}

function browserCandidates() {
  const env = [process.env.ACOS_CHROME, process.env.CHROME_PATH].filter(Boolean);
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean);
    return [
      ...env,
      ...roots.map(r => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(r => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ...env,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    ...env,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
  ];
}

function findBrowser() {
  for (const path of browserCandidates()) {
    try { if (statSync(path).isFile()) return path; } catch { /* next */ }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome writes the port it actually took into the profile directory, which
// avoids racing another process for a port we picked ourselves.
async function readDevToolsPort(profile, deadline) {
  while (Date.now() < deadline) {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); }
    catch { await sleep(100); }
  }
  return null;
}

function connect(wsUrl, deadline) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let closed = false;
  const rejectPending = error => {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message)); else done(message.result);
    } else if (message.method) {
      events.push(message.method);
    }
  });
  ws.addEventListener('close', () => rejectPending(new Error('the browser closed the DevTools connection')));
  ws.addEventListener('error', () => rejectPending(new Error('the DevTools connection failed')));
  let id = 0;
  const ready = new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out opening the DevTools connection')),
      Math.max(1, deadline - Date.now()),
    );
    ws.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('the browser closed the DevTools connection')); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the DevTools connection failed')); }, { once: true });
  });
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    if (closed || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`cannot send ${method}: the DevTools connection is closed`));
      return;
    }
    const n = ++id;
    const timer = setTimeout(() => {
      pending.delete(n);
      reject(new Error(`${method} timed out`));
    }, Math.max(1, deadline - Date.now()));
    pending.set(n, { resolve: done, reject, timer });
    try {
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(n);
      reject(error);
    }
  });
  return { ready, send, events, close: () => ws.close() };
}

async function waitFor(predicate, deadline, step = 150) {
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(step);
  }
  return false;
}

function findPlaywright() {
  if (process.env.ACOS_PLAYWRIGHT === 'off') return null;
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.ACOS_PLAYWRIGHT,
    join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime',
      'dependencies', 'node', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const playwright = require(candidate);
      if (playwright?.chromium) return playwright;
    } catch { /* optional runtime; use dependency-free CDP below */ }
  }
  return null;
}

async function captureWithPlaywright(playwright, binary, flags) {
  const launched = await playwright.chromium.launch({
    executablePath: binary,
    headless: true,
    timeout: flags.timeout,
  });
  try {
    const context = await launched.newContext({
      viewport: { width: flags.width, height: flags.height },
      deviceScaleFactor: flags.dpr,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(flags.timeout);
    try { await page.goto(flags.url, { waitUntil: 'load', timeout: flags.timeout }); }
    catch (error) {
      if (error?.name === 'TimeoutError') {
        throw failure(E_TIMEOUT, `${flags.url} did not finish loading within ${flags.timeout}ms`);
      }
      throw error;
    }
    if (flags.waitFor) {
      try { await page.waitForSelector(flags.waitFor, { state: 'attached' }); }
      catch (error) {
        if (error?.name === 'TimeoutError') {
          throw failure(E_NO_MATCH, `--wait-for ${flags.waitFor} never matched`);
        }
        throw error;
      }
    }
    await page.waitForTimeout(flags.settle);
    if (flags.eval) { await page.evaluate(flags.eval); await page.waitForTimeout(flags.settle); }

    let box = { x: 0, y: 0, width: flags.width, height: flags.height };
    if (flags.selector) {
      const locator = page.locator(flags.selector).first();
      try { await page.waitForSelector(flags.selector, { state: 'attached' }); }
      catch (error) {
        if (error?.name === 'TimeoutError') {
          throw failure(E_NO_MATCH, `--selector ${flags.selector} matched no element`);
        }
        throw error;
      }
      await locator.scrollIntoViewIfNeeded();
      box = await locator.boundingBox();
      if (!box) {
        throw failure(E_EMPTY_BOX, `${flags.selector} has no area to capture`);
      }
    }
    const left = Math.max(0, box.x - flags.pad);
    const top = Math.max(0, box.y - flags.pad);
    const right = Math.min(flags.width, box.x + box.width + flags.pad);
    const bottom = Math.min(flags.height, box.y + box.height + flags.pad);
    const clip = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
    if (clip.width <= 0 || clip.height <= 0) {
      throw failure(E_EMPTY_BOX, `${flags.selector ?? 'the viewport'} has no area to capture`);
    }
    const out = resolve(flags.out);
    mkdirSync(dirname(out), { recursive: true });
    const bytes = await page.screenshot({ path: out, type: 'png', clip });
    if (!bytes.length) throw failure(E_NO_IMAGE, 'the browser returned no image');
    const w = Math.round(clip.width * flags.dpr), h = Math.round(clip.height * flags.dpr);
    process.stdout.write(`${out}  ${w}x${h}  ${bytes.length} bytes\n`);
  } finally {
    await launched.close();
  }
}

const flags = parseArgs(process.argv.slice(2));
const binary = findBrowser();
if (!binary) die(E_NO_BROWSER, 'no Chrome or Edge found; set ACOS_CHROME to the browser binary');

// Codex already ships Playwright for browser automation. Reuse it when present;
// Claude and standalone installs keep the dependency-free CDP path below.
const playwright = findPlaywright();
if (playwright) {
  try { await captureWithPlaywright(playwright, binary, flags); process.exit(0); }
  catch (error) {
    die(error?.exitCode ?? E_CDP, error instanceof Error ? error.message : String(error));
  }
}

// A profile can stay locked by the browser's children for longer than an exit handler can
// wait, so each run clears what earlier runs left behind rather than letting them pile up.
const sweepStaleProfiles = () => {
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith('acos-shot-')) continue;
      const stale = join(tmpdir(), entry);
      try {
        if (Date.now() - statSync(stale).mtimeMs < 60000) continue;   // may be a live capture
        rmSync(stale, { recursive: true, force: true });
      } catch { /* still locked; the next run tries again */ }
    }
  } catch { /* best effort */ }
};

sweepStaleProfiles();
const profile = mkdtempSync(join(tmpdir(), 'acos-shot-'));
let browser = null;
const killBrowser = (child) => {
  // On Windows child.kill() ends only the process it spawned; the browser's own children
  // (crashpad, gpu, renderers) survive and keep the profile directory locked, so it can
  // never be removed. taskkill /T ends the tree.
  if (process.platform === 'win32' && child.pid) {
    const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (killed.status === 0) return;
  }
  try { child.kill(); } catch { /* already gone */ }
};

const cleanup = () => {
  if (browser) { killBrowser(browser); browser = null; }
  // The browser releases its locks on the profile only once it has actually exited, a moment
  // after it is killed, so on Windows the first remove fails with EBUSY or EPERM and a single
  // attempt leaves the profile behind on every run. rmSync retries those codes when asked to.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch { /* best effort */ }
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

const deadline = Date.now() + flags.timeout;
browser = spawn(binary, [
  '--headless=new',
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  `--window-size=${flags.width},${flags.height}`,
  'about:blank',
], { stdio: 'ignore' });
browser.on('error', () => die(E_NO_BROWSER, `could not start ${binary}`));

const port = await readDevToolsPort(profile, deadline);
if (!port) die(E_NO_PORT, 'the browser never opened a debugging port');

let wsUrl = null;
await waitFor(async () => {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
  catch { return false; }
  return Boolean(wsUrl);
}, deadline);
if (!wsUrl) die(E_NO_PORT, 'the browser opened a port but never answered on it');

const cdp = connect(wsUrl, deadline);
try {
  await cdp.ready;

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  // deviceScaleFactor alone decides the output resolution: the clip below stays in
  // CSS pixels at scale 1, or the two multiply and the capture comes out dpr times
  // larger than asked for.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: flags.width, height: flags.height, deviceScaleFactor: flags.dpr, mobile: false,
  }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const evaluate = async expression => {
    const { result, exceptionDetails } = await cdp.send(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluation failed');
    return result?.value;
  };

  await cdp.send('Page.navigate', { url: flags.url }, sessionId);
  if (!await waitFor(() => cdp.events.includes('Page.loadEventFired'), deadline)) {
    die(E_TIMEOUT, `${flags.url} did not finish loading within ${flags.timeout}ms`);
  }

  if (flags.waitFor) {
    const found = await waitFor(
      () => evaluate(`Boolean(document.querySelector(${JSON.stringify(flags.waitFor)}))`), deadline);
    if (!found) die(E_NO_MATCH, `--wait-for ${flags.waitFor} never matched`);
  }
// --settle is waited on both sides of --eval: the first covers the gap between
// the load event and a framework finishing hydration, without which the click
// lands on markup nothing is listening to yet.
  await sleep(flags.settle);
  if (flags.eval) { await evaluate(flags.eval); await sleep(flags.settle); }

// The clip target is polled rather than read once, so an element --eval brings
// into existence needs no second wait flag.
  const boxScript = flags.full
    ? `({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })`
    : `(() => {
      const el = document.querySelector(${JSON.stringify(flags.selector ?? '')});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()`;
  let box = null;
  await waitFor(async () => Boolean(box = await evaluate(boxScript)), deadline);
  if (!box) die(E_NO_MATCH, `--selector ${flags.selector} matched no element`);

  const clip = {
    x: Math.max(0, box.x - flags.pad),
    y: Math.max(0, box.y - flags.pad),
    width: box.width + flags.pad * 2,
    height: box.height + flags.pad * 2,
    scale: 1,
  };
  if (clip.width <= 0 || clip.height <= 0) {
    die(E_EMPTY_BOX, `${flags.selector ?? 'the viewport'} has no area to capture`);
  }

  const { data } = await cdp.send(
    'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip }, sessionId);
  if (!data) die(E_NO_IMAGE, 'the browser returned no image');

  const out = resolve(flags.out);
  mkdirSync(dirname(out), { recursive: true });
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(out, bytes);
  cdp.close();

  const w = Math.round(clip.width * flags.dpr), h = Math.round(clip.height * flags.dpr);
  process.stdout.write(`${out}  ${w}x${h}  ${bytes.length} bytes\n`);
  process.exit(0);
} catch (error) {
  die(E_CDP, error instanceof Error ? error.message : String(error));
}
