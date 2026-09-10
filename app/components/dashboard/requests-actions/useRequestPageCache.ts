import { useEffect, useMemo } from "react";
import type { HistoryRequest, RequestHistoryPage } from "../../../../shared/session-history-contract";

/** Only the viewed session/scope is resident. Positions are valid within one committed revision. */
class RequestPageCache {
  page: RequestHistoryPage | null = null;
  private items = new Map<number, HistoryRequest>();
  private positions = new Map<string, number>();
  private nextMissing = 0;

  add(page: RequestHistoryPage) {
    if (page.status !== "ready") return;
    const sameRevision = page.revision === this.page?.revision && page.total === this.page?.total;
    if (!sameRevision) { this.items.clear(); this.positions.clear(); this.nextMissing = 0; }
    this.page = { ...page, overview: page.overview ?? (sameRevision ? this.page?.overview : null) ?? null };
    page.items.forEach((item, index) => {
      this.items.set(page.offset + index, item);
      this.positions.set(item.id, page.offset + index);
    });
  }

  window(offset: number, size: number): RequestHistoryPage | null {
    if (!this.page) return null;
    const items: HistoryRequest[] = [];
    for (let index = offset; index < Math.min(offset + size, this.page.total); index += 1) {
      const item = this.items.get(index);
      if (!item) return null;
      items.push(item);
    }
    return { ...this.page, offset, items, linkedCount: 0 };
  }

  firstMissing(): number | null {
    while (this.items.has(this.nextMissing)) this.nextMissing += 1;
    return this.nextMissing < (this.page?.total ?? 0) ? this.nextMissing : null;
  }

  locate(id: string, size: number): RequestHistoryPage | null {
    const position = this.positions.get(id);
    if (position === undefined || !this.page) return null;
    const length = Math.min(size, this.page.total);
    let first = position;
    let last = position;
    while (position - first < length - 1 && this.items.has(first - 1)) first -= 1;
    while (last - position < length - 1 && this.items.has(last + 1)) last += 1;
    if (last - first + 1 < length) return null;
    // Keep an available complete window when centering would cross an unloaded gap.
    const offset = Math.max(first, Math.min(position - Math.floor(size / 2), last - length + 1));
    return this.window(offset, size);
  }
}

/** Preload committed pages independently of pointer navigation; never cache across revisions or scopes. */
export function useRequestPageCache(key: string, sessionId: string, scope: string, page: RequestHistoryPage | null) {
  const cache = useMemo(() => new RequestPageCache(), [key]);
  const revision = page?.revision;
  const total = page?.total;
  const canPreload = Array.isArray(page?.overview) && page.overview.length === total;
  useEffect(() => { if (page) cache.add(page); }, [cache, page]);
  useEffect(() => {
    if (!canPreload || !revision || total === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preload = async () => {
      while (!controller.signal.aborted && cache.page?.revision === revision) {
        const offset = cache.firstMissing();
        if (offset === null) return;
        const params = new URLSearchParams({ sessionId, kind: "requests", scope, limit: "60", offset: String(offset), overview: "0" });
        try {
          const response = await fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal });
          const value: RequestHistoryPage | null = response.ok ? await response.json() : null;
          if (controller.signal.aborted || cache.page?.revision !== revision) return;
          // A changing live revision is adopted by foreground refresh, never mixed into this cache.
          if (!value || value.kind !== "requests" || value.status !== "ready" || value.revision !== revision
            || value.total !== total || value.offset !== offset || !Array.isArray(value.items)
            || value.items.length !== Math.min(60, total - offset)) break;
          cache.add(value);
        } catch { break; }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void preload(); }, 5_000);
    };
    void preload();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [cache, canPreload, revision, scope, sessionId, total]);
  return cache;
}
