import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";
import { appendTaskLog } from "./task-log.mjs";

const seenKey = (repositoryId, number) => `task_pull_request_seen:${repositoryId}:${taskIdFromNumber(number)}`;

export function deleteTaskPullRequestSeen(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(seenKey(repositoryId, number));
}

function readFacts(resolveFacts, sessionId, taskId) {
  try {
    const facts = resolveFacts(sessionId, taskId);
    if (!facts || !Number.isSafeInteger(facts.number) || facts.number < 1
      || !["open", "merged", "closed"].includes(facts.state)
      || !(facts.headOid === null || typeof facts.headOid === "string" && /^[a-f0-9]{40}$/iu.test(facts.headOid))
      || ![null, "passed", "failed"].includes(facts.checks)) return null;
    return facts;
  } catch { return null; }
}

export function logPullRequests({ database, transaction, resolveFacts, now }) {
  if (typeof resolveFacts !== "function") return { ok: true };
  return transaction(() => {
    const rows = preparedStatement(database, "SELECT repository_id, number, session_id FROM tasks WHERE session_id IS NOT NULL AND state != 'done'").all();
    for (const row of rows) {
      if (!isTaskSessionId(row.session_id)) continue;
      const facts = readFacts(resolveFacts, row.session_id, taskIdFromNumber(row.number));
      if (!facts) continue;
      const key = seenKey(row.repository_id, row.number);
      const stored = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
      const seen = JSON.parse(stored ?? "null");
      const { number, headOid, checks } = facts;
      const sameHead = seen?.number === number && seen?.headOid === headOid;
      const merged = facts.state === "merged" || seen?.number === number && seen.merged === true;
      const at = now();
      if (checks !== null && (!sameHead || seen?.checks !== checks)) {
        appendTaskLog(database, row.repository_id, row.number, `checks_${checks}`, at, number);
      }
      if (facts.state === "merged" && !(seen?.number === number && seen.merged)) {
        appendTaskLog(database, row.repository_id, row.number, "merged", at, number);
      }
      // A head whose checks read as unknown again keeps its result, so a later identical result is not logged twice.
      // An unchanged reading writes nothing, so a quiet sweep leaves the store as it was.
      const value = JSON.stringify({ number, headOid, checks: checks ?? (sameHead ? seen.checks ?? null : null), merged });
      if (value === stored) continue;
      preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
    return { ok: true };
  });
}
