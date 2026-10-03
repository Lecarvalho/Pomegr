const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 30;
const HOUR = 60 * 60_000;

function retryDelay(response, now, failures) {
  const raw = response?.headers?.get?.("retry-after");
  const seconds = raw && /^\d{1,5}$/u.test(raw) ? Number(raw) * 1000 : null;
  const date = raw && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) - now() : null;
  return Math.min(24 * HOUR, Math.max(60_000, seconds ?? date ?? Math.min(6 * HOUR, 60_000 * 2 ** Math.min(failures, 8))));
}

/** Fixed public endpoint; callers select only adapter-owned URLs and parsers. */
export function createOfficialReleaseReader({ url, parse, fetch: fetchImpl = fetch, now = Date.now, timeoutMs = 8_000 } = {}) {
  if (typeof url !== "string" || !["https://api.github.com/repos/anthropics/claude-code/releases?per_page=30",
    "https://releases.openai.com/codex/channels/latest"].includes(url)
    || typeof parse !== "function") throw new TypeError("Invalid official release reader");
  const deadlineMs = Number.isSafeInteger(timeoutMs) ? Math.max(1, Math.min(8_000, timeoutMs)) : 8_000;
  let committed = null;
  let etag = null;
  let retryAt = 0;
  let failures = 0;
  let pending = null;
  let stopped = false;
  const controllers = new Set();
  async function read() {
    if (stopped) return committed;
    if (now() < retryAt) return committed;
    if (pending) return pending;
    const controller = new AbortController();
    controllers.add(controller);
    pending = (async () => {
      let response = null;
      try {
        response = await fetchImpl(url, { redirect: "error", credentials: "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]),
          headers: { Accept: "application/vnd.github+json", ...(etag ? { "If-None-Match": etag } : {}) } });
        if (response.status === 304 && committed) { failures = 0; retryAt = now() + 6 * HOUR; return committed; }
        if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("release unavailable");
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw new Error("release too large");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const source = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (Array.isArray(source) && source.length > MAX_ITEMS) throw new Error("release list invalid");
        const value = parse(source, new Date(now()).toISOString());
        if (!value) throw new Error("release payload invalid");
        if (stopped) return committed;
        committed = value;
        const nextEtag = response.headers.get("etag");
        etag = typeof nextEtag === "string" && /^(?:W\/)?"[!#-~]{1,120}"$/u.test(nextEtag) ? nextEtag : null;
        failures = 0;
        retryAt = now() + 6 * HOUR;
        return committed;
      } catch {
        failures++;
        retryAt = now() + retryDelay(response, now, failures);
        return committed;
      }
    })();
    try { return await pending; } finally { pending = null; controllers.delete(controller); }
  }
  read.stop = () => { stopped = true; for (const controller of controllers) controller.abort(); };
  return read;
}
