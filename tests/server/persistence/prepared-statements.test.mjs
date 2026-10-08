import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MAX_CACHED_STATEMENTS, preparedStatement } from "../../../server/persistence/prepared-statements.mjs";

function openDatabase(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => { try { database.close(); } catch { /* already closed */ } });
  database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
  return database;
}

test("a statement text is prepared once per database and reused", (t) => {
  const database = openDatabase(t);
  let prepares = 0;
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => { prepares += 1; return prepare(sql); };
  const insert = "INSERT INTO items (id, label) VALUES (?, ?)";
  for (let id = 1; id <= 50; id += 1) preparedStatement(database, insert).run(id, `item ${id}`);
  assert.equal(prepares, 1);
  assert.equal(preparedStatement(database, insert), preparedStatement(database, insert));
  assert.equal(preparedStatement(database, "SELECT COUNT(*) AS n FROM items").get().n, 50);
  assert.equal(prepares, 2);
});

test("a reused statement returns each call's own rows", (t) => {
  const database = openDatabase(t);
  preparedStatement(database, "INSERT INTO items (id, label) VALUES (?, ?)").run(1, "first");
  preparedStatement(database, "INSERT INTO items (id, label) VALUES (?, ?)").run(2, "second");
  const select = "SELECT label FROM items WHERE id = ?";
  assert.equal(preparedStatement(database, select).get(1).label, "first");
  assert.equal(preparedStatement(database, select).get(2).label, "second");
  assert.equal(preparedStatement(database, select).get(3), undefined);
});

test("statements are kept per database", (t) => {
  const first = openDatabase(t);
  const second = openDatabase(t);
  const select = "SELECT COUNT(*) AS n FROM items";
  preparedStatement(first, "INSERT INTO items (id, label) VALUES (?, ?)").run(1, "only in first");
  assert.notEqual(preparedStatement(first, select), preparedStatement(second, select));
  assert.equal(preparedStatement(first, select).get().n, 1);
  assert.equal(preparedStatement(second, select).get().n, 0);
});

test("a reused statement follows a later schema change", (t) => {
  const database = openDatabase(t);
  const select = "SELECT * FROM items WHERE id = ?";
  preparedStatement(database, "INSERT INTO items (id, label) VALUES (?, ?)").run(1, "first");
  assert.deepEqual({ ...preparedStatement(database, select).get(1) }, { id: 1, label: "first" });
  database.exec("ALTER TABLE items ADD COLUMN note TEXT");
  assert.deepEqual({ ...preparedStatement(database, select).get(1) }, { id: 1, label: "first", note: null });
});

test("statement texts past the cap still run and are not retained", (t) => {
  const database = openDatabase(t);
  for (let index = 0; index < MAX_CACHED_STATEMENTS; index += 1) preparedStatement(database, `SELECT ${index} AS value`);
  const overflow = `SELECT ${MAX_CACHED_STATEMENTS} AS value`;
  assert.equal(preparedStatement(database, overflow).get().value, MAX_CACHED_STATEMENTS);
  assert.notEqual(preparedStatement(database, overflow), preparedStatement(database, overflow));
  assert.equal(preparedStatement(database, "SELECT 0 AS value"), preparedStatement(database, "SELECT 0 AS value"));
});
