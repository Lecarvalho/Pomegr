// The transport of the effort routing's one call (agent-chat-jev.mjs). A turn's preparation keeps the libuv thread pool busy with file and Git
// work, and the pool is also where the operating system's name lookup (`getaddrinfo`, behind `fetch`) runs, so the call used to queue behind
// that work and missed its 1.5 second bound. This transport takes the pool out of the path:
//  - the host name is resolved with the DNS library (`dns.promises.resolve4`/`resolve6`, c-ares, no thread pool) and the address is kept
//    while its TTL lasts; the operating system's lookup is only the fallback when the DNS library has no answer;
//  - the connection is made to that address with the host name as TLS server name, so the certificate is still checked against the host;
//  - the connection stays open (a keep-alive agent) for the next call, and `preconnect()` opens it before the owner sends. A pre-connect is
//    a name lookup and a TLS handshake and nothing else: no request, no key, no text.
// Only one host is reachable through it, no redirect is followed, and nothing it holds keeps the process alive.

import dns from "node:dns";
import https from "node:https";

export const JEV_HOST = "api.typesafe.ai";
// A connection is not trusted after this long without use: the server closes idle connections, and a stale one would fail the call.
export const JEV_IDLE_MS = 30_000;
// A cached address is dropped after its TTL, and never kept longer than this.
export const JEV_DNS_TTL_CAP_MS = 10 * 60_000;
// A pre-connect that has not completed its handshake in this time is given up.
export const JEV_CONNECT_MS = 1_500;
const BODY_LIMIT = 64 * 1024;

const TLS = Object.freeze({ module: https, secure: true, ready: "secureConnect" });

/**
 * A transport for one host. `fetch(url, init)` answers `{ ok, status, text() }` like the part of `fetch` the routing uses (`method`,
 * `headers`, `body`, `signal`), and `init.watch(read)` receives, once, a function that answers where a call is while it waits: `dns`,
 * `connect`, or `response`. `preconnect()` opens a connection ahead and answers true when one is ready. `resolver`, `lookup`, `protocol`
 * (`{ module, secure, ready }`), and the clock are for tests; production uses the DNS library, the operating system's lookup as fallback,
 * and TLS.
 */
export function createJevTransport({ host = JEV_HOST, port = 443, resolver = dns.promises, lookup: osLookup = dns.lookup, protocol = TLS, now = Date.now, idleMs = JEV_IDLE_MS, connectMs = JEV_CONNECT_MS } = {}) {
  const { module: transportModule, secure, ready } = protocol;
  const scheme = secure ? "https:" : "http:";
  // The resolved addresses and when they expire; one resolution at a time; and how many lookups wait, for the phase.
  let cached = null;
  let resolving = null;
  let waiting = 0;
  let lastUsed = 0;
  // A connection opened ahead, not yet taken by a request, and the pre-connect in flight.
  let held = null;
  let connecting = null;

  function resolveAddresses() {
    if (cached && cached.expires > now()) return Promise.resolve(cached.list);
    resolving ??= (async () => {
      try {
        for (const [family, resolve] of [[4, resolver.resolve4], [6, resolver.resolve6]]) {
          try {
            const answers = await resolve.call(resolver, host, { ttl: true });
            if (!Array.isArray(answers) || answers.length === 0) continue;
            const ttl = Math.min(...answers.map((answer) => answer.ttl));
            cached = { list: answers.map(({ address }) => ({ address, family })), expires: now() + Math.min(Math.max(ttl, 0) * 1000, JEV_DNS_TTL_CAP_MS) };
            return cached.list;
          } catch { /* the other family, then the operating system */ }
        }
        return null;
      } finally { resolving = null; }
    })();
    return resolving;
  }

  // The `lookup` of every connection to the host: the DNS library's answer, else the operating system's.
  function lookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (hostname !== host) return osLookup(hostname, options, callback);
    waiting += 1;
    const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
    resolveAddresses().then((list) => {
      const wanted = list?.filter((entry) => family === 0 || entry.family === family) ?? [];
      if (wanted.length === 0) return osLookup(hostname, options, (...answer) => { waiting -= 1; callback(...answer); });
      waiting -= 1;
      return options?.all ? callback(null, wanted.map((entry) => ({ ...entry }))) : callback(null, wanted[0].address, wanted[0].family);
    }, () => { waiting -= 1; callback(new Error("lookup failed")); });
  }

  // The keep-alive agent: connections to the host are shared by the calls and by a connection opened ahead.
  let agent = null;
  const usable = (socket) => socket && !socket.destroyed && socket.readyState === "open";
  const fresh = () => now() - lastUsed < idleMs;
  const freeSockets = () => Object.values(agent.freeSockets ?? {}).flat();
  const dropFree = () => { for (const socket of freeSockets()) socket.destroy(); };
  function dropHeld() {
    if (!held) return;
    clearTimeout(held.timer);
    held.socket.destroy();
    held = null;
  }
  function takeHeld() {
    if (!held || !usable(held.socket) || !fresh()) { dropHeld(); return null; }
    const { socket, timer, quiet } = held;
    held = null;
    clearTimeout(timer);
    socket.off("error", quiet);
    socket.ref();
    return socket;
  }

  class JevAgent extends transportModule.Agent {
    // A connection opened ahead is the next one this agent uses; otherwise the agent connects as it always does, through `lookup`.
    createConnection(options, callback) {
      return takeHeld() ?? super.createConnection(options, callback);
    }
  }
  agent = new JevAgent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, lookup });

  function preconnect() {
    if (connecting) return connecting;
    if (!fresh()) { dropFree(); dropHeld(); }
    if (usable(held?.socket) || freeSockets().length > 0) return Promise.resolve(true);
    connecting = new Promise((resolve) => {
      let socket = null;
      let timer = null;
      let done = false;
      const finish = (opened) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        connecting = null;
        if (!opened) socket?.destroy();
        resolve(opened);
      };
      try {
        const options = { ...agent.options, host, port, ...(secure ? { servername: host } : {}) };
        options._agentKey = agent.getName(options);
        socket = transportModule.Agent.prototype.createConnection.call(agent, options);
        // A connection that is only waiting never keeps the process alive.
        socket.unref();
        const quiet = () => {};
        socket.on("error", quiet);
        socket.once("error", () => finish(false));
        socket.once("close", () => { if (held?.socket === socket) { clearTimeout(held.timer); held = null; } finish(false); });
        socket.once(ready, () => {
          lastUsed = now();
          const drop = setTimeout(dropHeld, idleMs);
          drop.unref?.();
          held = { socket, timer: drop, quiet };
          finish(true);
        });
        timer = setTimeout(() => finish(false), connectMs);
        timer.unref?.();
      } catch { finish(false); }
    });
    return connecting;
  }

  function request(url, init) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.protocol !== scheme || target.hostname !== host) { reject(new TypeError("This transport reaches one host")); return; }
      const body = Buffer.from(typeof init.body === "string" ? init.body : "", "utf8");
      const req = transportModule.request({
        agent, host, port, method: init.method ?? "GET", path: `${target.pathname}${target.search}`, signal: init.signal,
        headers: { ...init.headers, "content-length": body.length }, ...(secure ? { servername: host } : {}),
      }, (response) => {
        lastUsed = now();
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        // A refusal or a redirect is not read: the connection is drained and kept.
        if (!ok) { response.resume(); resolve({ ok, status: response.statusCode, text: async () => "" }); return; }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > BODY_LIMIT) { response.destroy(); reject(new Error("The answer is too large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ ok, status: response.statusCode, text: async () => Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      req.on("error", reject);
      req.on("finish", () => { init.sent?.(); });
      req.end(body);
    });
  }

  return Object.freeze({
    preconnect,
    fetch(url, init = {}) {
      let sent = false;
      // Where the call waits: in a name lookup, in the connection, or for the answer once the request went out.
      init.watch?.(() => (waiting > 0 ? "dns" : sent ? "response" : "connect"));
      const run = () => { if (!fresh()) dropFree(); return request(url, { ...init, sent: () => { sent = true; } }); };
      // A connection being opened ahead is waited for, not duplicated: it ends within the connect bound.
      return connecting ? connecting.then(run) : run();
    },
  });
}
