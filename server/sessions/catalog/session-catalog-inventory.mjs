import { createHash, randomUUID } from "node:crypto";
import { preparedStatement } from "../../persistence/prepared-statements.mjs";
import { parseProviderSessionId } from "../../providers/provider-contract.mjs";
import { rowSummaryFields, sanitizeRowSummary } from "./session-catalog-row.mjs";

const PAGE_MAX = 100;
const MEMORY_MAX = 256;
const SOURCES = { claude: "Claude Code", codex: "Codex" };
const ACTIVITY = new Set(["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);
const COLUMNS = "provider,local_id AS localId,title,project,created_at AS createdAt,updated_at AS updatedAt,is_live AS isLive,needs_input AS needsInput,activity_status AS activityStatus,settled_status AS settledStatus,repository_id AS repositoryId,summary_json AS summaryJson";
// Durable non-live outcomes, separate from volatile presence. `open` and `unknown` are never settled.
const SETTLED = new Set(["idle", "closed", "stopped"]);
const CONFIRMED = new Set(["closed", "stopped"]);
const settledOf = (row) => !row.isLive && !row.needsInput && SETTLED.has(row.activityStatus) ? row.activityStatus : null;
// Provider-confirmed closed/stopped outranks the idle fallback; a null incoming value never overwrites.
const mergeSettled = (previous, incoming) => !incoming ? previous || null : CONFIRMED.has(incoming) || !CONFIRMED.has(previous) ? incoming : previous;
const ORDER = "created_ms DESC,provider,local_id";
const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max) : "";
const date = (value) => typeof value === "string" && value.length <= 48 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const safeRepository = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : null;
const key = (row) => `${row.provider}:${row.localId}`;
// Newest-created first, matching ORDER's binary provider/local_id tiebreak.
const compareCreation = (a, b) => b.createdMs - a.createdMs
  || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.localId < b.localId ? -1 : a.localId > b.localId ? 1 : 0);
function normalize(provider, value) {
  if (!SOURCES[provider] || typeof value?.localId !== "string" || !parseProviderSessionId(`${provider}:${value.localId}`)) return null;
  const createdAt = date(value.createdAt) || date(value.updatedAt);
  return withSettled({ provider, localId: value.localId, title: clean(value.title, 160) || "Untitled session",
    project: clean(value.project, 160) || "Unknown project", createdAt, updatedAt: date(value.updatedAt) || createdAt,
    isLive: Boolean(value.isLive), needsInput: Boolean(value.needsInput),
    activityStatus: ACTIVITY.has(value.activityStatus) ? value.activityStatus : "unknown", repositoryId: safeRepository(value.repositoryId) });
}
function withSettled(row) { return { ...row, settledStatus: settledOf(row) }; }
function publicRow(row, activityStatus = row.activityStatus) {
  return { id: key(row), provider: row.provider, source: SOURCES[row.provider], title: row.title, project: row.project,
    createdAt: row.createdAt, updatedAt: row.updatedAt, isLive: Boolean(row.isLive), needsInput: Boolean(row.needsInput),
    activityStatus, repositoryId: row.repositoryId || null, ...rowSummaryFields(row.summaryJson, Boolean(row.isLive)) };
}
function queryParts(query) {
  const pageSize = Math.max(1, Math.min(PAGE_MAX, Math.trunc(Number(query.pageSize) || 25)));
  const scope = { query: clean(query.query, 120).toLowerCase(), filter: ["live", "needs"].includes(query.filter) ? query.filter : "all",
    project: clean(query.project, 160), repositoryId: clean(query.repositoryId, 160), pageSize };
  const hash = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
  const where = [], args = [];
  if (scope.query) { where.push("instr(lower(title || ' ' || project || ' ' || CASE provider WHEN 'codex' THEN 'Codex' ELSE 'Claude Code' END), ?) > 0"); args.push(scope.query); }
  if (scope.project) { where.push("project = ?"); args.push(scope.project); }
  if (scope.repositoryId) { where.push("repository_id = ?"); args.push(scope.repositoryId); }
  if (scope.filter === "live") where.push("is_live = 1");
  if (scope.filter === "needs") where.push("(needs_input = 1 OR activity_status = 'needs_input')");
  return { scope, hash, where: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

/** A committed normalized index. Only mutation methods initialize or write SQLite. */
export function createSessionCatalogInventory({ store = () => null, now = Date.now, providers = [], scopeKey: initialScopeKey = "", maxMemoryRows = MEMORY_MAX } = {}) {
  const memory = new Map();
  const lifecycleIds = new Map();
  // Providers whose first presence pass has committed in this monitor run; settled status is shown only after it.
  const presenceObserved = new Set();
  const states = new Map(providers.filter((id) => SOURCES[id]).map((id) => [id, { status: "discovering", token: null, invalid: false }]));
  const memoryLimit = Math.max(1, Math.min(MEMORY_MAX, maxMemoryRows));
  let database = null, revision = 0, observedAt = null, lastCompletedTotal = null, lastCompletedAt = null, overflow = false;
  let scopeKey = typeof initialScopeKey === "string" && /^[a-f0-9]{64}$/u.test(initialScopeKey) ? initialScopeKey : "";
  const stamp = () => new Date(now()).toISOString();
  // Presence wins while live or needing input. Otherwise the settled outcome is shown, but only once
  // this run has observed the provider's presence, so a resumed session never flashes Idle before Working.
  // An expired Open row is not live but keeps its presence status, as in the shell feed.
  const shownStatus = (row) => row.isLive || row.needsInput || row.activityStatus === "needs_input" || row.activityStatus === "open" ? row.activityStatus
    : presenceObserved.has(row.provider) && SETTLED.has(row.settledStatus) ? row.settledStatus : "unknown";
  const toPublic = (row) => publicRow(row, shownStatus(row));
  function transaction(fn) { if (!database) return fn(); database.exec("BEGIN IMMEDIATE"); try { const value = fn(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } }
  function saveFacts() {
    if (!database) return;
    preparedStatement(database, "INSERT OR REPLACE INTO session_catalog_facts (id, revision, observed_at, completed_total, completed_at, scope_key) VALUES (1,?,?,?,?,?)")
      .run(revision, observedAt, lastCompletedTotal, lastCompletedAt, scopeKey);
  }
  function changed() { revision += 1; observedAt = stamp(); saveFacts(); }
  function initialize() {
    const candidate = store()?.database;
    if (!candidate || candidate === database) return Boolean(database);
    database = candidate;
    database.exec(`CREATE TABLE IF NOT EXISTS session_catalog_headers (
      provider TEXT NOT NULL, local_id TEXT NOT NULL, title TEXT NOT NULL, project TEXT NOT NULL,
      created_at TEXT, updated_at TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
      is_live INTEGER NOT NULL, needs_input INTEGER NOT NULL, activity_status TEXT NOT NULL, settled_status TEXT, repository_id TEXT, summary_json TEXT, summary_updated_ms INTEGER,
      generation TEXT NOT NULL, PRIMARY KEY(provider,local_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS session_catalog_created ON session_catalog_headers(created_ms,provider,local_id);
      CREATE INDEX IF NOT EXISTS session_catalog_title ON session_catalog_headers(title COLLATE NOCASE,provider,local_id);
      CREATE INDEX IF NOT EXISTS session_catalog_project ON session_catalog_headers(project,created_ms);
      CREATE INDEX IF NOT EXISTS session_catalog_repository ON session_catalog_headers(repository_id,created_ms);
      CREATE TABLE IF NOT EXISTS session_catalog_facts (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,observed_at TEXT,completed_total INTEGER,completed_at TEXT,scope_key TEXT NOT NULL DEFAULT '');`);
    // Additive migration: older inventories (before the settled status and the row summary) keep their rows.
    for (const [column, type] of [["settled_status", "TEXT"], ["summary_json", "TEXT"], ["summary_updated_ms", "INTEGER"]]) {
      if (!preparedStatement(database, "SELECT 1 AS found FROM pragma_table_info('session_catalog_headers') WHERE name=?").get(column)) database.exec(`ALTER TABLE session_catalog_headers ADD COLUMN ${column} ${type}`);
    }
    const facts = preparedStatement(database, "SELECT revision,observed_at,completed_total,completed_at,scope_key FROM session_catalog_facts WHERE id=1").get();
    if (facts) { revision = Math.max(revision, facts.revision); lastCompletedTotal = Number.isSafeInteger(facts.completed_total) ? facts.completed_total : null; lastCompletedAt = date(facts.completed_at); }
    transaction(() => {
      if (facts && facts.scope_key !== scopeKey) { preparedStatement(database, "DELETE FROM session_catalog_headers").run(); lastCompletedTotal = null; lastCompletedAt = null; }
      // Persisted identity survives restart; native writer/lifecycle presence does not.
      preparedStatement(database, "UPDATE session_catalog_headers SET is_live=0,needs_input=0,activity_status='unknown' WHERE is_live<>0 OR needs_input<>0 OR activity_status<>'unknown'").run();
      for (const row of memory.values()) writeRow(row, row.generation, true);
      if (states.size) {
        const ids = [...states.keys()];
        preparedStatement(database, `DELETE FROM session_catalog_headers WHERE provider NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
      }
      changed();
    });
    memory.clear(); overflow = false; presenceObserved.clear();
    for (const state of states.values()) { state.status = "discovering"; state.token = null; state.invalid = false; }
    return true;
  }
  function configureProviders(ids, options = {}) {
    const nextScope = typeof options.scopeKey === "string" && /^[a-f0-9]{64}$/u.test(options.scopeKey) ? options.scopeKey : scopeKey;
    const wanted = new Set(ids.filter((id) => SOURCES[id]));
    const rosterChanged = wanted.size !== states.size || [...wanted].some((id) => !states.has(id));
    if (nextScope === scopeKey && !rosterChanged) return;
    transaction(() => {
      if (nextScope !== scopeKey || rosterChanged) {
        scopeKey = nextScope;
        if (database) preparedStatement(database, "DELETE FROM session_catalog_headers").run();
        memory.clear(); lifecycleIds.clear(); presenceObserved.clear(); lastCompletedTotal = null; lastCompletedAt = null; overflow = false;
        for (const state of states.values()) {state.status="discovering";state.token=null;}
      }
      for (const id of states.keys()) if (!wanted.has(id)) states.delete(id);
      for (const id of wanted) if (!states.has(id)) states.set(id, { status: "discovering", token: null, invalid: false });
      changed();
    });
  }
  function writeRow(row, generation, overlay, preserveLifecycle = false) {
    if (database) {
      preparedStatement(database, `INSERT INTO session_catalog_headers (provider,local_id,title,project,created_at,updated_at,created_ms,updated_ms,is_live,needs_input,activity_status,settled_status,repository_id,generation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,local_id) DO UPDATE SET
        title=CASE WHEN ? OR (excluded.title<>'Untitled session' AND excluded.updated_ms >= updated_ms) THEN excluded.title ELSE title END,
        project=CASE WHEN ? OR (excluded.project<>'Unknown project' AND excluded.updated_ms >= updated_ms) THEN excluded.project ELSE project END,
        created_at=CASE WHEN excluded.created_ms > 0 AND (created_ms=0 OR excluded.created_ms < created_ms) THEN excluded.created_at ELSE created_at END,
        created_ms=CASE WHEN excluded.created_ms > 0 AND (created_ms=0 OR excluded.created_ms < created_ms) THEN excluded.created_ms ELSE created_ms END,
        updated_at=CASE WHEN excluded.updated_ms >= updated_ms THEN excluded.updated_at ELSE updated_at END,
        updated_ms=max(updated_ms,excluded.updated_ms),
        is_live=CASE WHEN ? THEN excluded.is_live ELSE is_live END,
        needs_input=CASE WHEN ? THEN excluded.needs_input ELSE needs_input END,
        activity_status=CASE WHEN ? THEN excluded.activity_status ELSE activity_status END,
        settled_status=CASE WHEN excluded.settled_status IS NULL THEN settled_status
          WHEN excluded.settled_status IN ('closed','stopped') OR settled_status IS NULL OR settled_status NOT IN ('closed','stopped') THEN excluded.settled_status ELSE settled_status END,
        repository_id=CASE WHEN ? THEN excluded.repository_id ELSE coalesce(excluded.repository_id,repository_id) END,
        generation=CASE WHEN excluded.generation='' THEN generation ELSE excluded.generation END`)
        .run(row.provider,row.localId,row.title,row.project,row.createdAt,row.updatedAt,Date.parse(row.createdAt)||0,Date.parse(row.updatedAt)||0,
          row.isLive?1:0,row.needsInput?1:0,row.activityStatus,row.settledStatus,row.repositoryId,generation || "",
          overlay?1:0,overlay?1:0,preserveLifecycle?0:overlay?1:0,preserveLifecycle?0:overlay?1:0,preserveLifecycle?0:overlay?1:0,overlay?1:0);
      return;
    }
    const id = key(row), previous = memory.get(id);
    if (!previous && memory.size >= memoryLimit) { overflow = true; return; }
    const newer = !previous || Date.parse(row.updatedAt) >= Date.parse(previous.updatedAt);
    memory.set(id, { ...(previous || row), ...(newer || overlay ? row : {}),
      createdAt: previous?.createdAt && (!row.createdAt || previous.createdAt < row.createdAt) ? previous.createdAt : row.createdAt,
      generation: generation || previous?.generation || "",
      ...(preserveLifecycle && previous ? { isLive: previous.isLive, needsInput: previous.needsInput, activityStatus: previous.activityStatus } : {}),
      ...(!overlay && previous ? {isLive:previous.isLive,needsInput:previous.needsInput,activityStatus:previous.activityStatus}: {}),
      settledStatus: mergeSettled(previous?.settledStatus, row.settledStatus) });
  }
  function beginProvider(provider) {
    if (!SOURCES[provider]) return null;
    initialize();
    const token = randomUUID(); states.set(provider, { status: "discovering", token, invalid: false }); changed(); return token;
  }
  function upsertHeaders(provider, entries, token, { overlay = false, preserveLifecycle = false } = {}) {
    const state = states.get(provider);
    if (!state || (token && state.token !== token)) return false;
    if (!Array.isArray(entries) || entries.length > PAGE_MAX) throw new RangeError("Catalog header batch exceeds bound");
    let invalid = false;
    let semanticChange = false;
    const previousOverflow = overflow;
    transaction(() => {
      for (const entry of entries) {
        const row = normalize(provider, entry);
        if (!row) { invalid = true; continue; }
        const before = JSON.stringify(get(key(row)));
        writeRow(row, token || (overlay ? state.token : null), overlay, preserveLifecycle);
        semanticChange ||= before !== JSON.stringify(get(key(row)));
      }
      if (invalid) state.invalid = true;
      if (semanticChange || previousOverflow !== overflow) changed();
    });
    return true;
  }
  // Persists one validated row summary bound to the recorded updatedAt. It never moves to an older
  // recorded time and writes only when the summary differs from the persisted one.
  function upsertSummary(provider, localId, summary, updatedAt) {
    initialize();
    const clean = sanitizeRowSummary(summary), ms = Date.parse(date(updatedAt) || "");
    if (!clean || !SOURCES[provider] || !parseProviderSessionId(`${provider}:${localId}`) || !Number.isFinite(ms)) return false;
    const json = JSON.stringify(clean);
    return transaction(() => {
      let written;
      if (database) written = Number(preparedStatement(database, "UPDATE session_catalog_headers SET summary_json=?,summary_updated_ms=? WHERE provider=? AND local_id=? AND coalesce(summary_updated_ms,-1)<=? AND summary_json IS NOT ?")
        .run(json, ms, provider, localId, ms, json).changes) > 0;
      else {
        const row = memory.get(`${provider}:${localId}`);
        written = Boolean(row) && (row.summaryMs ?? -1) <= ms && row.summaryJson !== json;
        if (written) Object.assign(row, { summaryJson: json, summaryMs: ms });
      }
      if (written) changed();
      return written;
    });
  }
  function countAll() { return database ? Number(preparedStatement(database, "SELECT COUNT(*) AS n FROM session_catalog_headers").get().n) : memory.size; }
  function finishProvider(provider, token, { complete = false } = {}) {
    const state = states.get(provider); if (!state || !token || state.token !== token) return false;
    const success = complete && !state.invalid && !overflow;
    transaction(() => {
      if (success) {
        if (database) preparedStatement(database, "DELETE FROM session_catalog_headers WHERE provider=? AND generation<>?").run(provider,token);
        else for (const [id,row] of memory) if (row.provider === provider && row.generation !== token) memory.delete(id);
      }
      state.status = success ? "complete" : "partial"; state.token = null;
      if ([...states.values()].every((entry) => entry.status === "complete")) { lastCompletedTotal = countAll(); lastCompletedAt = stamp(); }
      changed();
    }); return true;
  }
  function updateHeaders(provider, rows, { preserveLifecycle = false } = {}) {
    initialize(); if (!states.has(provider) && SOURCES[provider]) states.set(provider,{status:"discovering",token:null,invalid:false});
    for (let offset=0;offset<rows.length;offset+=PAGE_MAX) upsertHeaders(provider, rows.slice(offset,offset+PAGE_MAX), null,{overlay:true,preserveLifecycle});
  }
  function updateProviderLifecycle(provider, rows) {
    const bounded = Array.isArray(rows) ? rows.slice(0, PAGE_MAX) : [];
    const current = new Set(bounded.map((row) => normalize(provider, row)).filter(Boolean).map((row) => row.localId));
    updateHeaders(provider, bounded);
    transaction(() => {
      let removed = false;
      for (const id of lifecycleIds.get(provider) || []) {
        if (current.has(id)) continue;
        if (database) {
          const result = preparedStatement(database, "UPDATE session_catalog_headers SET is_live=0,needs_input=0,activity_status='unknown' WHERE provider=? AND local_id=? AND (is_live<>0 OR needs_input<>0 OR activity_status<>'unknown')").run(provider,id);
          removed = Number(result.changes) > 0 || removed;
        }
        else { const row=memory.get(`${provider}:${id}`); if (row) { removed ||= row.isLive || row.needsInput || row.activityStatus !== "unknown"; Object.assign(row,{isLive:false,needsInput:false,activityStatus:"unknown"}); } }
      }
      const firstPass = !presenceObserved.has(provider);
      lifecycleIds.set(provider,current); presenceObserved.add(provider); if (removed || firstPass) changed();
    });
  }
  // Compatibility publishers only overlay bounded lifecycle rows. A ready shell is not a complete enumeration.
  function replaceProvider(provider, entries, readiness = "ready") {
    updateHeaders(provider, Array.isArray(entries)?entries:[]);
    if (readiness === "unavailable" && states.has(provider)) { states.get(provider).status="partial"; changed(); }
    return snapshot();
  }
  function coverage() {
    const complete = states.size > 0 && [...states.values()].every((state) => state.status === "complete") && !overflow;
    return { status: complete ? "complete" : overflow || [...states.values()].some((state)=>state.status==="partial") ? "partial":"discovering",
      knownCount:countAll(),exactTotal:complete?countAll():null,observedAt:complete?lastCompletedAt:observedAt,lastCompletedTotal,lastCompletedAt };
  }
  function snapshot() { return {revision,coverage:coverage()}; }
  function get(id) {
    const parsed=parseProviderSessionId(id); if (!parsed) return null;
    const row=database?preparedStatement(database, `SELECT ${COLUMNS} FROM session_catalog_headers WHERE provider=? AND local_id=?`).get(parsed.providerId,parsed.localSessionId):memory.get(id);
    return row?toPublic(row):null;
  }
  function directory(query={}) {
    const {scope,hash,where,args}=queryParts(query);
    // Keyset cursors name the last row's creation position, so live updates and newly
    // created sessions never move a later page; new sessions appear only on the first page.
    let after=null,cursorReset=false;
    if (query.cursor) {
      let cursor;
      try { if (typeof query.cursor !== "string" || query.cursor.length>1024) throw new Error(); cursor=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")); } catch { cursor=null; }
      if (!Array.isArray(cursor) || cursor.length!==4 || cursor[0]!==hash || !Number.isSafeInteger(cursor[1]) || cursor[1]<0
        || !parseProviderSessionId(`${cursor[2]}:${cursor[3]}`) || !SOURCES[cursor[2]]) cursorReset=true;
      else after={createdMs:cursor[1],provider:cursor[2],localId:cursor[3]};
    }
    let rows,matchedCount,counts;
    if (database) {
      matchedCount=Number(preparedStatement(database, `SELECT COUNT(*) AS n FROM session_catalog_headers${where}`).get(...args).n);
      const tallies=preparedStatement(database, "SELECT COUNT(*) AS all_count,coalesce(SUM(is_live),0) AS live,coalesce(SUM(CASE WHEN needs_input=1 OR activity_status='needs_input' THEN 1 ELSE 0 END),0) AS needs FROM session_catalog_headers").get();
      counts={all:Number(tallies.all_count),live:Number(tallies.live),needs:Number(tallies.needs)};
      const keyset=after?`${where?" AND":" WHERE"} (created_ms < ? OR (created_ms = ? AND (provider,local_id) > (?,?)))`:"";
      rows=preparedStatement(database, `SELECT ${COLUMNS},created_ms AS createdMs FROM session_catalog_headers${where}${keyset} ORDER BY ${ORDER} LIMIT ?`)
        .all(...args,...(after?[after.createdMs,after.createdMs,after.provider,after.localId]:[]),scope.pageSize+1);
    } else {
      const all=[...memory.values()]; counts={all:all.length,live:all.filter(row=>row.isLive).length,needs:all.filter(row=>row.needsInput||row.activityStatus==="needs_input").length};
      const matches=all.filter(row=>(!scope.query||`${row.title} ${row.project} ${SOURCES[row.provider]}`.toLowerCase().includes(scope.query))&&(!scope.project||row.project===scope.project)&&(!scope.repositoryId||row.repositoryId===scope.repositoryId)&&(scope.filter!=="live"||row.isLive)&&(scope.filter!=="needs"||row.needsInput||row.activityStatus==="needs_input"))
        .map(row=>({...row,createdMs:Date.parse(row.createdAt)||0})).sort(compareCreation);
      const start=after?matches.findIndex(row=>compareCreation(row,after)>0):0;
      matchedCount=matches.length; rows=start<0?[]:matches.slice(start,start+scope.pageSize+1);
    }
    const more=rows.length>scope.pageSize; rows=rows.slice(0,scope.pageSize);
    const last=rows.at(-1);
    const facts=coverage();
    return {revision,coverage:facts,readiness:{catalog:facts.knownCount||facts.status==="complete"?"ready":facts.status==="partial"?"unavailable":"loading"},sessions:rows.map(toPublic),matchedCount,counts,pageSize:scope.pageSize,
      nextCursor:more?Buffer.from(JSON.stringify([hash,last.createdMs,last.provider,last.localId])).toString("base64url"):null,...(cursorReset?{cursorReset:true}:{})};
  }
  return Object.freeze({initialize,configureProviders,beginProvider,upsertHeaders,finishProvider,updateHeaders,updateProviderLifecycle,upsertSummary,replaceProvider,directory,snapshot,coverage,get,
    diagnostics:()=>({residentRows:memory.size,maxResidentRows:memoryLimit,maxPageSize:PAGE_MAX,durable:Boolean(database)})});
}
