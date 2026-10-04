import { isSafeSessionId } from "./notification-rules.mjs";
import { copyInputNotificationTime } from "../normalize/input-notification-facts.mjs";

/** Bounded notification facts from normalized catalog commits, before shell truncation. */
export function createNotificationCatalog({ projectVisibility, activeSessionIds = () => [] }) {
  const byProvider = new Map();
  const trackedActiveIds = new Set();
  let snapshot = null;

  function acceptProvider(providerId, normalized, readiness) {
    // Restored conditions need an explicit false row even before this process
    // has observed them active. Missing or partial evidence still cannot clear them.
    for (const id of activeSessionIds().slice(0, 100)) {
      if (trackedActiveIds.size >= 100) break;
      if (isSafeSessionId(id)) trackedActiveIds.add(id);
    }
    const previousActive = new Set([...trackedActiveIds].filter((id) => id.startsWith(`${providerId}:`)));
    const rows = [];
    let activeCount = 0;
    let activeSelected = 0;
    for (const row of normalized) {
      if (row.detailReadiness === "unavailable") continue;
      if (row.isLive && row.needsInput) activeCount += 1;
      if (previousActive.has(row.id)) {
        rows.push(row);
        if (row.isLive && row.needsInput) activeSelected += 1;
      }
    }
    for (const row of normalized) {
      if (activeSelected >= 100) break;
      if (row.detailReadiness === "unavailable") continue;
      if (row.isLive && row.needsInput && !previousActive.has(row.id)) {
        rows.push(row);
        activeSelected += 1;
      }
    }
    byProvider.set(providerId, readiness !== "ready"
      ? { rows: [], activeCount: 0, ready: false } : { rows, activeCount, ready: true });
  }

  function commit({ revision, readiness, checkedAt, incompleteSource }) {
    const candidates = [...byProvider.values()].flatMap((entry) => entry.rows)
      .map((entry) => copyInputNotificationTime(entry, projectVisibility(entry, checkedAt)));
    const selected = new Map();
    for (const entry of candidates) {
      if (!trackedActiveIds.has(entry.id)) continue;
      selected.set(entry.id, entry);
      // Missing rows reserve their slots until an explicit current false arrives.
      if (!entry.isLive || !entry.needsInput) trackedActiveIds.delete(entry.id);
    }
    for (const entry of candidates) {
      if (selected.size >= 200) break;
      if (entry.isLive && entry.needsInput && !selected.has(entry.id) && trackedActiveIds.size < 100) {
        selected.set(entry.id, entry);
        trackedActiveIds.add(entry.id);
      }
    }
    const selectedActiveCount = [...selected.values()].filter((entry) => entry.isLive && entry.needsInput).length;
    const readyActiveCount = [...byProvider.values()].reduce((count, entry) => count + (entry.ready ? entry.activeCount : 0), 0);
    const overflow = Math.max(0, readyActiveCount - selectedActiveCount);
    snapshot = Object.freeze({ revision, readiness,
      sessions: Object.freeze([...selected.values()].map((entry) => Object.freeze(entry))),
      activeSessionOverflow: Math.min(1_000_000, incompleteSource ? Math.max(snapshot?.activeSessionOverflow || 0, overflow) : overflow),
    });
    return snapshot;
  }

  return Object.freeze({ acceptProvider, commit, read: () => snapshot });
}
