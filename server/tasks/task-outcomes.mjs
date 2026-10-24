import { preparedStatement } from "../persistence/prepared-statements.mjs";

export function ensureTaskOutcomes(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_outcomes (
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      review_at INTEGER,
      done_at INTEGER NOT NULL,
      requeues INTEGER NOT NULL,
      sessions INTEGER NOT NULL,
      owner_turns INTEGER,
      commits_after_review INTEGER,
      pull_request INTEGER,
      pull_request_state TEXT CHECK (pull_request_state IS NULL OR pull_request_state IN ('open','merged','closed')),
      PRIMARY KEY (repository_id, number)
    ) WITHOUT ROWID;
  `);
}

export function writeTaskOutcome(database, repositoryId, number, outcome) {
  preparedStatement(database, `INSERT OR REPLACE INTO task_outcomes
    (repository_id, number, review_at, done_at, requeues, sessions, owner_turns, commits_after_review, pull_request, pull_request_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repositoryId, number, outcome.review_at, outcome.done_at, outcome.requeues, outcome.sessions,
      outcome.owner_turns, outcome.commits_after_review, outcome.pull_request, outcome.pull_request_state);
}

export function readTaskOutcome(database, repositoryId, number) {
  const row = preparedStatement(database, "SELECT * FROM task_outcomes WHERE repository_id = ? AND number = ?").get(repositoryId, number);
  return row ? { ...row } : null;
}

export function deleteTaskOutcome(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM task_outcomes WHERE repository_id = ? AND number = ?").run(repositoryId, number);
}

export function taskOutcome(events, facts, doneAt) {
  const reviewAt = events.find((event) => event.kind === "review")?.at ?? null;
  if (reviewAt === null) facts = null;
  return {
    review_at: reviewAt,
    done_at: doneAt,
    requeues: events.filter((event) => event.kind === "requeued").length,
    sessions: new Set(events.filter((event) => ["started", "assigned"].includes(event.kind) && event.sessionId !== null).map((event) => event.sessionId)).size,
    owner_turns: Number.isInteger(facts?.owner_turns) && facts.owner_turns >= 0 ? facts.owner_turns : null,
    commits_after_review: Number.isInteger(facts?.commits_after_review) && facts.commits_after_review >= 0 ? facts.commits_after_review : null,
    pull_request: Number.isInteger(facts?.pull_request) && facts.pull_request > 0 ? facts.pull_request : null,
    pull_request_state: ["open", "merged", "closed"].includes(facts?.pull_request_state) ? facts.pull_request_state : null,
  };
}
