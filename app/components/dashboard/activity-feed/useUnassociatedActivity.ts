import { useEffect, useState } from "react";
import type { HistoryActivity } from "../../../../shared/session-history-contract";
import { mergeCalls, parseUnassociatedPage } from "./feed-model";

const PAGE = 8;
const NO_CALLS: HistoryActivity[] = [];

export type UnassociatedActivity = {
  total: number;
  status: "idle" | "loading" | "ready" | "unavailable";
  calls: HistoryActivity[];
  remaining: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  loadMore: () => void;
  retry: () => void;
};

export const IDLE_UNASSOCIATED: UnassociatedActivity = {
  total: 0, status: "idle", calls: NO_CALLS, remaining: 0, open: false, setOpen: () => {}, loadMore: () => {}, retry: () => {},
};

type Marker = { scopeKey: string; revision: string };
type Rows = Marker & { calls: HistoryActivity[]; lowest: number };
type Failure = Marker & { offset: string; attempt: number };
type Older = Marker & { from: number };

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
        if (page.revision !== revision && !(Number(page.revision) > Number(revision))) return fail();
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
