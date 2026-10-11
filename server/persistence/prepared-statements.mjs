export const MAX_CACHED_STATEMENTS = 256;

const caches = new WeakMap();

export function preparedStatement(database, sql) {
  let cache = caches.get(database);
  if (!cache) caches.set(database, cache = new Map());
  const cached = cache.get(sql);
  if (cached) return cached;
  const statement = database.prepare(sql);
  if (cache.size < MAX_CACHED_STATEMENTS) cache.set(sql, statement);
  return statement;
}
