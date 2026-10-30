"use client";

import { useEffect, useMemo, useState } from "react";
import type { TaskHome } from "../../../shared/task-contract";
import { readDesktopTaskLog } from "../tasks/task-desktop";
import { logBoards, type HomeLogReads } from "./home-model";

const REFRESH_MS = 60_000;

/**
 * The task logs of the boards that changed last, read through the desktop bridge or the paired route. Only where the client can read
 * a log (`enabled`). The first read ends with `reading` false; later reads replace what was read without going back to reading, so
 * nothing Home drew is withdrawn. A log that could not be read is null. Reading never acknowledges an entry. `at` is the time of the
 * newest read, where the line's window of 24 hours ends.
 */
export function useHomeLogs(home: TaskHome, enabled: boolean): { reading: boolean; reads: HomeLogReads; at: number } {
  const ids = logBoards(home);
  const key = ids.join(",");
  const targets = useMemo(() => (key === "" ? [] : key.split(",")), [key]);
  const [held, setHeld] = useState<{ reads: HomeLogReads; at: number } | null>(null);

  useEffect(() => {
    if (!enabled || targets.length === 0) return;
    let live = true;
    let sequence = 0;
    const read = async () => {
      sequence += 1;
      const mine = sequence;
      const answers = await Promise.all(targets.map(async (id) => {
        const answer = await readDesktopTaskLog(id).catch(() => ({ ok: false as const }));
        return [id, answer.ok ? answer.log : null] as const;
      }));
      if (live && mine === sequence) setHeld({ reads: new Map(answers), at: Date.now() });
    };
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void read(); }, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled, targets]);

  // The boards that stopped being the newest take their logs out of the line.
  return useMemo(() => {
    if (!enabled || targets.length === 0) return { reading: false, reads: new Map(), at: 0 };
    if (held === null) return { reading: true, reads: new Map(), at: 0 };
    return { reading: false, reads: new Map(targets.filter((id) => held.reads.has(id)).map((id) => [id, held.reads.get(id) ?? null])), at: held.at };
  }, [enabled, targets, held]);
}
