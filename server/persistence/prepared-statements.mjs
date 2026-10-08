// A node:sqlite prepared statement holds about 5 KB of native memory that V8 does not
// count, and it is released only when a major collection finalizes its JavaScript
// wrapper. Code that prepared a statement on every call (about 1,200 a second with four
// live sessions and an open dashboard) therefore kept tens of thousands of dead
// statements alive between collections: hundreds of megabytes of resident memory outside
// the JavaScript heap. Preparing each statement text once per database removes that
// backlog and the repeated SQL parse.
//
// Every use here is synchronous and runs a statement to completion (`run`, `get`, `all`),
// so one statement object is safe to share between callers. Do not use this for a
// statement that is iterated lazily.
//
// Callers pass fixed statement texts; the few built from a query shape (a filter clause,
// a placeholder list) are bounded by the shape, never by data. The cap guards against a
// caller that breaks that rule: past it a statement is prepared and not retained.
export const MAX_CACHED_STATEMENTS = 256;

const caches = new WeakMap();

/** Returns the database's prepared statement for `sql`, preparing it on first use. */
export function preparedStatement(database, sql) {
  let cache = caches.get(database);
  if (!cache) caches.set(database, cache = new Map());
  const cached = cache.get(sql);
  if (cached) return cached;
  const statement = database.prepare(sql);
  if (cache.size < MAX_CACHED_STATEMENTS) cache.set(sql, statement);
  return statement;
}
