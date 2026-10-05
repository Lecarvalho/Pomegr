import { useEffect, useState } from "react";
import type { HistoryActivity } from "../../../../shared/session-history-contract";
import { mergeCalls, parseUnassociatedPage } from "./feed-model";

/** The flat activity pager serves at most this many calls per read. */
const PAGE = 8;
const NO_CALLS: HistoryActivity[] = [];

export type UnassociatedActivity = {
  /** Scoped tool calls with no recorded request, from the feed page already fetched; 0 hides the section. */
  total: number;
  /** `idle`: nothing is read (closed, disabled, or no calls). `loading`: a read is in flight. `unavailable`: the last read failed. */
  status: "idle" | "loading" | "ready" | "unavailable";
  /** Loaded calls of the current session, scope and served revision, chronological, each once. */
  calls: HistoryActivity[];
  /** Calls not loaded yet: all of `total` before the first read, then the count older than the loaded ones. */
  remaining: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Reads the page of calls just older than the loaded ones. */
  loadMore: () => void;
  /** Repeats the read that failed. */
  retry: () => void;
};

/** A closed, empty section: for stubs and for a feed that is disabled. */
export const IDLE_UNASSOCIATED: UnassociatedActivity = {
  total: 0, status: "idle", calls: NO_CALLS, remaining: 0, open: false, setOpen: () => {}, loadMore: () => {}, retry: () => {},
};

type Marker = { scopeKey: string; revision: string };
type Rows = Marker & { calls: HistoryActivity[]; lowest: number };
type Failure = Marker & { offset: string; attempt: number };
type Older = Marker & { from: number };

/**
 * The calls of one session scope that have no recorded request, read on demand through the flat
 * pager (`unassociated=1`, oldest first). The newest page (`offset=latest`) loads first and each
 * further read is the page just before the loaded ones, so every call arrives exactly once.
 * Rows belong to one session, scope and served feed revision: another value drops them, and the
 * selected request never enters the query. `total` and `revision` come from the feed page.
 */
export function useUnassociatedActivity({ enabled, sessionId, scope, revision, total }: {
  enabled: boolean; sessionId: string; scope: string; revision: string; total: number;
}): UnassociatedActivity {
  const scopeKey = JSON.stringify([sessionId, scope]);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [older, setOlder] = useState<Older | null>(null);
  const [attempt, setAttempt] = useState(0);

  const open = sessionId !== "" && openSession === sessionId;
  const wanted = enabled && open && total > 0;
  const valid = rows && rows.scopeKey === scopeKey && rows.revision === revision ? rows : null;
  const lowest = valid?.lowest ?? null;
  const asked = valid !== null && valid.lowest > 0 && older?.scopeKey === scopeKey && older.revision === revision && older.from === valid.lowest;
  // The read still owed: the newest page first, then the page before the loaded ones, else none.
  const offset = valid === null ? "latest" : asked ? String(Math.max(0, valid.lowest - PAGE)) : null;
  const failed = wanted && offset !== null && failure?.scopeKey === scopeKey && failure.revision === revision
    && failure.offset === offset && failure.attempt === attempt;

  useEffect(() => {
    if (!wanted || offset === null || failed) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ sessionId, kind: "activity", scope, unassociated: "1", limit: String(PAGE), offset });
    const fail = () => setFailure({ scopeKey, revision, offset, attempt });
    fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok && response.status !== 204 ? parseUnassociatedPage(await response.json()) : null)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (!page || page.status !== "ready") return fail();
        // A reply from another revision would mix evidence. Drop it: the feed's next page for the
        // new revision changes `revision` and starts the read again.
        if (page.revision !== revision) return;
        // An older page must start before the loaded ones, or reading again would never finish.
        if (lowest !== null && page.offset >= lowest) return fail();
        setFailure(null);
        setRows((previous) => {
          const base = offset !== "latest" && previous?.scopeKey === scopeKey && previous.revision === revision ? previous.calls : NO_CALLS;
          return { scopeKey, revision, calls: mergeCalls(base, page.calls), lowest: page.offset };
        });
      })
      .catch(() => { if (!controller.signal.aborted) fail(); });
    return () => controller.abort();
  }, [wanted, offset, failed, lowest, sessionId, scope, scopeKey, revision, attempt]);

  return {
    total,
    status: !wanted ? "idle" : failed ? "unavailable" : offset !== null ? "loading" : "ready",
    calls: valid?.calls ?? NO_CALLS,
    remaining: valid ? valid.lowest : total,
    open,
    setOpen: (next) => setOpenSession(next && sessionId ? sessionId : null),
    loadMore: () => {
      if (wanted && valid && valid.lowest > 0 && offset === null) setOlder({ scopeKey, revision, from: valid.lowest });
    },
    retry: () => setAttempt((value) => value + 1),
  };
}
