import { preparedStatement } from "../persistence/prepared-statements.mjs";

export const SCORECARD_FORMULA = 2;

export function ensureScorecardSnapshots(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS task_scorecard_snapshots (
    repository_id TEXT NOT NULL, app_version TEXT NOT NULL, formula INTEGER NOT NULL, taken_at INTEGER NOT NULL,
    owner_turns REAL, owner_turns_n INTEGER NOT NULL, review_to_done_ms REAL, review_to_done_n INTEGER NOT NULL,
    first_pass REAL, first_pass_n INTEGER NOT NULL,
    PRIMARY KEY (repository_id, app_version, formula)
  ) WITHOUT ROWID`);
  const columns = database.prepare("PRAGMA table_info(task_scorecard_snapshots)").all();
  for (const [name, type] of [["rework_rate", "REAL"], ["rework_rate_n", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!columns.some((column) => column.name === name)) database.exec(`ALTER TABLE task_scorecard_snapshots ADD COLUMN ${name} ${type}`);
  }
}

function median(values) {
  const sample = values.length;
  values.sort((a, b) => a - b);
  return { value: sample === 0 ? null : (values[Math.floor((sample - 1) / 2)] + values[Math.floor(sample / 2)]) / 2, sample };
}

export function scorecardMeasures(rows) {
  const merged = rows.filter((row) => row.pull_request_state === "merged");
  const reviewed = merged.filter((row) => row.commits_after_review !== null);
  return {
    ownerTurns: median(merged.filter((row) => row.owner_turns !== null).map((row) => row.owner_turns)),
    reviewToDoneMs: median(merged.filter((row) => row.review_at !== null && row.done_at >= row.review_at).map((row) => row.done_at - row.review_at)),
    firstPass: { value: reviewed.length === 0 ? null : reviewed.filter((row) => row.commits_after_review === 0).length / reviewed.length, sample: reviewed.length },
    reworkRate: { value: merged.length === 0 ? null : merged.filter((row) => row.reworked || row.requeues > 0).length / merged.length, sample: merged.length },
  };
}

function snapshot(row) {
  return row ? { version: row.app_version, takenAt: row.taken_at, measures: {
    ownerTurns: { value: row.owner_turns, sample: row.owner_turns_n },
    reviewToDoneMs: { value: row.review_to_done_ms, sample: row.review_to_done_n },
    firstPass: { value: row.first_pass, sample: row.first_pass_n },
    reworkRate: { value: row.rework_rate, sample: row.rework_rate_n },
  } } : null;
}

export function readScorecardSnapshot(database, repositoryId, appVersion, nowMs) {
  const { ownerTurns, reviewToDoneMs, firstPass, reworkRate } = scorecardMeasures(
    preparedStatement(database, `SELECT o.*, (
      EXISTS (SELECT 1 FROM task_reviews r WHERE r.repository_id = o.repository_id AND r.number = o.number AND r.verdict = 'fail')
      OR EXISTS (SELECT 1 FROM meta m WHERE m.key = 'task_send_back:' || o.repository_id || ':T-' || o.number)
      OR EXISTS (SELECT 1 FROM task_events e WHERE e.repository_id = o.repository_id AND e.number = o.number AND e.kind = 'requeued')
      OR EXISTS (SELECT 1 FROM task_rework r WHERE r.repository_id = o.repository_id AND r.reworks IN ('T-' || o.number, '#' || o.pull_request))
    ) AS reworked FROM task_outcomes o WHERE o.repository_id = ?`).all(repositoryId),
  );
  preparedStatement(database, `INSERT INTO task_scorecard_snapshots
    (repository_id, app_version, formula, taken_at, owner_turns, owner_turns_n, review_to_done_ms, review_to_done_n, first_pass, first_pass_n, rework_rate, rework_rate_n)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repository_id, app_version, formula) DO UPDATE SET
      owner_turns = excluded.owner_turns, owner_turns_n = excluded.owner_turns_n,
      review_to_done_ms = excluded.review_to_done_ms, review_to_done_n = excluded.review_to_done_n,
      first_pass = excluded.first_pass, first_pass_n = excluded.first_pass_n,
      rework_rate = excluded.rework_rate, rework_rate_n = excluded.rework_rate_n`)
    .run(repositoryId, appVersion, SCORECARD_FORMULA, nowMs, ownerTurns.value, ownerTurns.sample, reviewToDoneMs.value, reviewToDoneMs.sample, firstPass.value, firstPass.sample, reworkRate.value, reworkRate.sample);
  const current = preparedStatement(database, "SELECT * FROM task_scorecard_snapshots WHERE repository_id = ? AND app_version = ? AND formula = ?")
    .get(repositoryId, appVersion, SCORECARD_FORMULA);
  const baseline = preparedStatement(database, `SELECT * FROM task_scorecard_snapshots
    WHERE repository_id = ? AND formula = ? AND app_version <> ? ORDER BY taken_at, app_version LIMIT 1`)
    .get(repositoryId, SCORECARD_FORMULA, appVersion);
  return { formula: SCORECARD_FORMULA, current: snapshot(current), baseline: snapshot(baseline) };
}
