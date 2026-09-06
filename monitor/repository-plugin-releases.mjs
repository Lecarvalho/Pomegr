import { pluginVersionSchema } from "../shared/repository-plugin-state.mjs";

const MANIFESTS = Object.freeze({ claude: "plugins/claude-code/.claude-plugin/plugin.json", codex: "plugins/pomegr/.codex-plugin/plugin.json" });
const SAFE_REF = /^(?:main|v\d{1,4}\.\d{1,4}\.\d{1,4}|[a-f0-9]{40})$/u;
const MAX_BYTES = 32 * 1024;

/** Fixed official public source, no credentials, redirects, or provider API requests. */
export function createRepositoryPluginReleaseReader({ fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  const controllers = new Set();
  const read = async (provider, ref = "main") => {
    if (!Object.hasOwn(MANIFESTS, provider) || !SAFE_REF.test(ref)) return { status: "unavailable", version: null, checkedAt: null };
    const key = `${provider}:${ref}`;
    const cached = entries.get(key);
    if (cached && now() < cached.retryAt) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const controller = new AbortController();
    controllers.add(controller);
    const work = (async () => {
      let value;
      try {
        const response = await fetchImpl(`https://raw.githubusercontent.com/Lecarvalho/pomegr/${ref}/${MANIFESTS[provider]}`, {
          redirect: "error", credentials: "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]), headers: { Accept: "application/json" },
        });
        if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) throw new Error("unavailable");
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
            if (size > MAX_BYTES) throw new Error("unavailable"); chunks.push(chunk.value); }
        } finally { await reader.cancel().catch(() => {}); }
        const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const version = pluginVersionSchema.parse(manifest.version);
        if (manifest.name !== "pomegr") throw new Error("unavailable");
        value = { status: "ready", version, checkedAt: new Date(now()).toISOString() };
      } catch { value = { status: "unavailable", version: cached?.value?.version || null, checkedAt: cached?.value?.checkedAt || null }; }
      if (entries.size >= 64 && !entries.has(key)) entries.delete(entries.keys().next().value);
      entries.set(key, { value, retryAt: now() + (value.status === "ready" ? 60 * 60_000 : 5 * 60_000) });
      return value;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); controllers.delete(controller); }
  };
  read.stop = () => { for (const controller of controllers) controller.abort(); };
  return read;
}
