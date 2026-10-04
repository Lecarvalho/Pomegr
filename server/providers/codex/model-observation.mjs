import { createHash } from "node:crypto";
import { validModelIdentifier, validModelLabel } from "../../../shared/model-notification.mjs";
import { createCodexAppServerModelCatalogReader } from "./app-server-client.mjs";

const SCOPE = /^[a-f0-9]{64}$/u;
const HOUR = 60 * 60_000;

export const CODEX_MODEL_SOURCE_CAPABILITIES = Object.freeze({
  clientCatalog: "supported",
  accountEntitlement: "unavailable",
  announcement: "supported",
  deprecation: "supported",
});

const OPENAI_NEWS_RSS = "https://openai.com/news/rss.xml";
const OPENAI_NEWS_SCOPE = createHash("sha256").update(OPENAI_NEWS_RSS).digest("hex");
// The official feed carried 1,245 items / 760 KiB when checked on 2026-10-03.
const MAX_RSS_BYTES = 1024 * 1024;
const MAX_RSS_ITEMS = 1_500;
const RSS_TITLE = /^(Introducing|Retiring) (GPT-[1-9][0-9]?(?:\.[1-9][0-9]?)?(?: (?:Sol|Astra|Luna|Pro|Mini))?)$/u;

function withDeadline(promise, controller, milliseconds) {
  if (controller.signal.aborted) return Promise.reject(new Error());
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(new Error());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error()); }, Math.max(1, milliseconds));
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  });
}

function retryDelay(response, now, failures) {
  const raw = response?.headers?.get?.("retry-after");
  const seconds = typeof raw === "string" && /^\d{1,5}$/u.test(raw) ? Number(raw) * 1000 : null;
  const date = typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) - now() : null;
  return Math.min(24 * HOUR, Math.max(60_000, seconds ?? date ?? 60_000 * 2 ** Math.min(failures, 8)));
}

function xmlField(item, name) {
  const matches = [...item.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "gu"))];
  if (matches.length !== 1) return null;
  const value = matches[0][1];
  if (/^<!\[CDATA\[[\s\S]*\]\]>$/u.test(value)) return value.slice(9, -3);
  if (/[<&]/u.test(value)) return null;
  return value;
}

/** Only first-party RSS title/date/link fields; never inspect article bodies. */
export function parseOpenAIModelNews(xml, observedAt) {
  if (typeof xml !== "string" || Buffer.byteLength(xml) > MAX_RSS_BYTES
    || !Number.isFinite(Date.parse(observedAt)) || /<!DOCTYPE|<!ENTITY/iu.test(xml)
    || !/<rss\b[^>]*>[\s\S]*<channel>[\s\S]*<\/channel>[\s\S]*<\/rss>/u.test(xml)) return null;
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)];
  if (items.length > MAX_RSS_ITEMS || (xml.match(/<item>/gu) || []).length !== items.length
    || (xml.match(/<\/item>/gu) || []).length !== items.length) return null;
  const announcements = [];
  const seen = new Set();
  for (const [, item] of items) {
    const title = xmlField(item, "title");
    if (title === null) return null;
    const match = RSS_TITLE.exec(title);
    if (!match) continue;
    const date = xmlField(item, "pubDate");
    const link = xmlField(item, "link");
    if (!date || !link || !Number.isFinite(Date.parse(date))
      || Date.parse(date) > Date.parse(observedAt)) return null;
    let url;
    try { url = new URL(link); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname !== "openai.com"
      || !/^\/(?:index|news)\/[a-z0-9/-]+\/?$/u.test(url.pathname)
      || url.search || url.hash) return null;
    const label = match[2];
    const modelId = label.toLowerCase().replaceAll(" ", "-");
    if (!validModelIdentifier(modelId) || !validModelLabel(label)) return null;
    const kind = match[1] === "Introducing" ? "announced" : "deprecated";
    const identity = `${kind}:${modelId}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    announcements.push({ modelId, label, kind, publishedAt: new Date(date).toISOString() });
  }
  return announcements;
}

/** Fixed official RSS only; no redirects, article fetches, account tokens or raw copy retention. */
export function createOpenAIModelAnnouncementReader({ fetch: fetchImpl = fetch, now = Date.now,
  timeoutMs = 8_000 } = {}) {
  const deadlineMs = Number.isSafeInteger(timeoutMs) ? Math.max(1, Math.min(8_000, timeoutMs)) : 8_000;
  let committed = null;
  let etag = null;
  let retryAt = 0;
  let failures = 0;
  let pending = null;
  let stopped = false;
  const controllers = new Set();
  const unavailable = () => ({ provider: "codex", status: "unavailable", complete: false,
    observedAt: null, sourceScope: OPENAI_NEWS_SCOPE, announcements: [] });
  async function read() {
    if (stopped) return committed || unavailable();
    if (now() < retryAt) return committed || unavailable();
    if (pending) return pending;
    const controller = new AbortController();
    controllers.add(controller);
    pending = (async () => {
      let response;
      try {
        const deadlineAt = Date.now() + deadlineMs;
        response = await withDeadline(fetchImpl(OPENAI_NEWS_RSS, { redirect: "error", credentials: "omit",
          signal: controller.signal,
          headers: { Accept: "application/rss+xml, application/xml", ...(etag ? { "If-None-Match": etag } : {}) } }),
        controller, deadlineAt - Date.now());
        if (response.status === 304 && committed) { retryAt = now() + 6 * HOUR; failures = 0; return committed; }
        const length = Number(response.headers?.get?.("content-length"));
        const contentType = response.headers?.get?.("content-type") || "";
        if (response.status !== 200 || !response.body || (Number.isFinite(length) && length > MAX_RSS_BYTES)
          || !/^(?:text\/xml|application\/(?:rss\+xml|xml))(?:\s*;|\s*$)/iu.test(contentType)) throw new Error();
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await withDeadline(reader.read(), controller, deadlineAt - Date.now());
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RSS_BYTES) throw new Error();
            chunks.push(value);
          }
        } finally { void reader.cancel().catch(() => {}); }
        const rows = parseOpenAIModelNews(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          new Date(now()).toISOString());
        if (!rows || stopped || controller.signal.aborted) throw new Error();
        committed = { provider: "codex", status: "ready", complete: true,
          observedAt: new Date(now()).toISOString(), sourceScope: OPENAI_NEWS_SCOPE, announcements: rows };
        const nextEtag = response.headers.get("etag");
        etag = typeof nextEtag === "string" && /^(?:W\/)?"[!#-~]{1,120}"$/u.test(nextEtag) ? nextEtag : null;
        retryAt = now() + 6 * HOUR;
        failures = 0;
        return committed;
      } catch {
        failures += 1;
        retryAt = now() + retryDelay(response, now, failures);
        return committed || unavailable();
      }
    })();
    try { return await pending; } finally { pending = null; controllers.delete(controller); }
  }
  return { read, stop() { stopped = true; for (const controller of controllers) controller.abort(); } };
}

/** Strictly validate the entire snapshot before accepting any visible row. */
export function normalizeCodexModelCatalog(value) {
  if (!value || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 4) return null;
  const models = [];
  const seen = new Set();
  const knownIds = new Set();
  let total = 0;
  for (let pageIndex = 0; pageIndex < value.pages.length; pageIndex++) {
    const page = value.pages[pageIndex];
    if (!page || !Array.isArray(page.data) || page.data.length > 32
      || (pageIndex === value.pages.length - 1 && page.nextCursor != null)
      || (pageIndex < value.pages.length - 1 && (typeof page.nextCursor !== "string" || !page.nextCursor))) return null;
    total += page.data.length;
    if (total > 128) return null;
    for (const row of page.data) {
      if (!row || typeof row !== "object" || Array.isArray(row)
        || !validModelIdentifier(row.id) || !validModelIdentifier(row.model)
        || !validModelLabel(row.displayName)
        || typeof row.hidden !== "boolean") return null;
      if (seen.has(row.id)) return null;
      seen.add(row.id);
      knownIds.add(row.id);
      knownIds.add(row.model);
      // An id mapping to another model is a client alias, not a distinct new model.
      if (row.hidden || row.id !== row.model) continue;
      models.push({ id: row.id, label: row.displayName });
    }
  }
  return { models, knownIds: [...knownIds] };
}

/** A complete client listing only. The source scope is monitor-private and opaque. */
export function createCodexModelObservation({ catalogReader = createCodexAppServerModelCatalogReader(),
  now = Date.now, sourceScope = () => null } = {}) {
  let committed = null;
  let retryAt = 0;
  let failures = 0;
  let pending = null;
  let stopped = false;
  const unavailable = () => ({ provider: "codex", status: "unavailable", complete: false,
    observedAt: null, sourceScope: null, models: [], knownIds: [] });
  async function read() {
    if (stopped) return unavailable();
    const scope = sourceScope();
    if (typeof scope !== "string" || !SCOPE.test(scope)) { committed = null; retryAt = 0; failures = 0; return unavailable(); }
    if (committed?.sourceScope !== scope) { committed = null; retryAt = 0; failures = 0; }
    if (now() < retryAt) return committed || unavailable();
    if (pending) return pending;
    pending = (async () => {
      try {
        const snapshot = normalizeCodexModelCatalog(await catalogReader.readCatalog());
        if (sourceScope() !== scope || stopped) { committed = null; retryAt = 0; return unavailable(); }
        if (!snapshot) throw new Error();
        const observedAt = new Date(now()).toISOString();
        committed = { provider: "codex", status: "ready", complete: true, observedAt,
          sourceScope: scope, ...snapshot };
        failures = 0;
        retryAt = now() + HOUR;
        return committed;
      } catch {
        failures += 1;
        retryAt = now() + Math.min(6 * HOUR, 60_000 * 2 ** Math.min(failures, 8));
        return committed || unavailable();
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { read, stop() { stopped = true; }, capabilities: CODEX_MODEL_SOURCE_CAPABILITIES };
}

/** Optional helper for integration: never expose a raw auth/config path as source scope. */
export function codexModelSourceScope(value) {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update(value).digest("hex");
}
