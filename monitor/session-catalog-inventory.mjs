import { createHash, randomUUID } from "node:crypto";
import { parseProviderSessionId } from "./providers/provider-contract.mjs";

const PAGE_MAX = 100;
const MEMORY_MAX = 256;
const SOURCES = { claude: "Claude Code", codex: "Codex" };
const ACTIVITY = new Set(["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);
const COLUMNS = "provider,local_id AS localId,title,project,created_at AS createdAt,updated_at AS updatedAt,is_live AS isLive,needs_input AS needsInput,activity_status AS activityStatus,repository_id AS repositoryId";
const ORDERS = { newest: "created_ms DESC,provider,local_id", oldest: "created_ms ASC,provider,local_id", title: "title COLLATE NOCASE,provider,local_id" };
const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max) : "";
const date = (value) => typeof value === "string" && value.length <= 48 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const safeRepository = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : null;
const key = (row) => `${row.provider}:${row.localId}`;
function normalize(provider, value) {
  if (!SOURCES[provider] || typeof value?.localId !== "string" || !parseProviderSessionId(`${provider}:${value.localId}`)) return null;
  const createdAt = date(value.createdAt) || date(value.updatedAt);
  return { provider, localId: value.localId, title: clean(value.title, 160) || "Untitled session",
    project: clean(value.project, 160) || "Unknown project", createdAt, updatedAt: date(value.updatedAt) || createdAt,
    isLive: Boolean(value.isLive), needsInput: Boolean(value.needsInput),
    activityStatus: ACTIVITY.has(value.activityStatus) ? value.activityStatus : "unknown", repositoryId: safeRepository(value.repositoryId) };
}
function publicRow(row) {
  return { id: key(row), provider: row.provider, source: SOURCES[row.provider], title: row.title, project: row.project,
    createdAt: row.createdAt, updatedAt: row.updatedAt, isLive: Boolean(row.isLive), needsInput: Boolean(row.needsInput),
    activityStatus: row.activityStatus, repositoryId: row.repositoryId || null, summaryReadiness: "loading",
    agentCount: null, activeAgentCount: null, latestContextTotal: null, progress: null, currentActivity: null };
}
function queryParts(query) {
  const pageSize = Math.max(1, Math.min(PAGE_MAX, Math.trunc(Number(query.pageSize) || 25)));
  const scope = { query: clean(query.query, 120).toLowerCase(), filter: ["live", "needs"].includes(query.filter) ? query.filter : "all",
    project: clean(query.project, 160), repositoryId: clean(query.repositoryId, 160), sort: ORDERS[query.sort] ? query.sort : "newest", pageSize };
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
  const states = new Map(providers.filter((id) => SOURCES[id]).map((id) => [id, { status: "discovering", token: null, invalid: false }]));
  const memoryLimit = Math.max(1, Math.min(MEMORY_MAX, maxMemoryRows));
  const epoch = randomUUID();
  let database = null, revision = 0, observedAt = null, lastCompletedTotal = null, lastCompletedAt = null, overflow = false;
  let scopeKey = typeof initialScopeKey === "string" && /^[a-f0-9]{64}$/u.test(initialScopeKey) ? initialScopeKey : "";
  const stamp = () => new Date(now()).toISOString();
  function transaction(fn) { if (!database) return fn(); database.exec("BEGIN IMMEDIATE"); try { const value = fn(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } }
  function saveFacts() {
    if (!database) return;
    database.prepare("INSERT OR REPLACE INTO session_catalog_facts (id, revision, observed_at, completed_total, completed_at, scope_key) VALUES (1,?,?,?,?,?)")
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
      is_live INTEGER NOT NULL, needs_input INTEGER NOT NULL, activity_status TEXT NOT NULL, repository_id TEXT,
      generation TEXT NOT NULL, PRIMARY KEY(provider,local_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS session_catalog_created ON session_catalog_headers(created_ms,provider,local_id);
      CREATE INDEX IF NOT EXISTS session_catalog_title ON session_catalog_headers(title COLLATE NOCASE,provider,local_id);
      CREATE INDEX IF NOT EXISTS session_catalog_project ON session_catalog_headers(project,created_ms);
      CREATE INDEX IF NOT EXISTS session_catalog_repository ON session_catalog_headers(repository_id,created_ms);
      CREATE TABLE IF NOT EXISTS session_catalog_facts (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,observed_at TEXT,completed_total INTEGER,completed_at TEXT,scope_key TEXT NOT NULL DEFAULT '');`);
    const facts = database.prepare("SELECT revision,observed_at,completed_total,completed_at,scope_key FROM session_catalog_facts WHERE id=1").get();
    if (facts) { revision = Math.max(revision, facts.revision); lastCompletedTotal = Number.isSafeInteger(facts.completed_total) ? facts.completed_total : null; lastCompletedAt = date(facts.completed_at); }
    transaction(() => {
      if (facts && facts.scope_key !== scopeKey) { database.prepare("DELETE FROM session_catalog_headers").run(); lastCompletedTotal = null; lastCompletedAt = null; }
      // Persisted identity survives restart; native writer/lifecycle presence does not.
      database.prepare("UPDATE session_catalog_headers SET is_live=0,needs_input=0,activity_status='unknown' WHERE is_live<>0 OR needs_input<>0 OR activity_status<>'unknown'").run();
      for (const row of memory.values()) writeRow(row, row.generation, true);
      if (states.size) {
        const ids = [...states.keys()];
        database.prepare(`DELETE FROM session_catalog_headers WHERE provider NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
      }
      changed();
    });
    memory.clear(); overflow = false;
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
        if (database) database.prepare("DELETE FROM session_catalog_headers").run();
        memory.clear(); lifecycleIds.clear(); lastCompletedTotal = null; lastCompletedAt = null; overflow = false;
        for (const state of states.values()) {state.status="discovering";state.token=null;}
      }
      for (const id of states.keys()) if (!wanted.has(id)) states.delete(id);
      for (const id of wanted) if (!states.has(id)) states.set(id, { status: "discovering", token: null, invalid: false });
      changed();
    });
  }
  function writeRow(row, generation, overlay, preserveLifecycle = false) {
    if (database) {
      database.prepare(`INSERT INTO session_catalog_headers (provider,local_id,title,project,created_at,updated_at,created_ms,updated_ms,is_live,needs_input,activity_status,repository_id,generation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,local_id) DO UPDATE SET
        title=CASE WHEN ? OR (excluded.title<>'Untitled session' AND excluded.updated_ms >= updated_ms) THEN excluded.title ELSE title END,
        project=CASE WHEN ? OR (excluded.project<>'Unknown project' AND excluded.updated_ms >= updated_ms) THEN excluded.project ELSE project END,
        created_at=CASE WHEN excluded.created_ms > 0 AND (created_ms=0 OR excluded.created_ms < created_ms) THEN excluded.created_at ELSE created_at END,
        created_ms=CASE WHEN excluded.created_ms > 0 AND (created_ms=0 OR excluded.created_ms < created_ms) THEN excluded.created_ms ELSE created_ms END,
        updated_at=CASE WHEN excluded.updated_ms >= updated_ms THEN excluded.updated_at ELSE updated_at END,
        updated_ms=max(updated_ms,excluded.updated_ms),
        is_live=CASE WHEN ? THEN excluded.is_live ELSE is_live END,
        needs_input=CASE WHEN ? THEN excluded.needs_input ELSE needs_input END,
        activity_status=CASE WHEN ? THEN excluded.activity_status ELSE activity_status END,
        repository_id=CASE WHEN ? THEN excluded.repository_id ELSE coalesce(excluded.repository_id,repository_id) END,
        generation=CASE WHEN excluded.generation='' THEN generation ELSE excluded.generation END`)
        .run(row.provider,row.localId,row.title,row.project,row.createdAt,row.updatedAt,Date.parse(row.createdAt)||0,Date.parse(row.updatedAt)||0,
          row.isLive?1:0,row.needsInput?1:0,row.activityStatus,row.repositoryId,generation || "",
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
      ...(!overlay && previous ? {isLive:previous.isLive,needsInput:previous.needsInput,activityStatus:previous.activityStatus}: {}) });
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
  function countAll() { return database ? Number(database.prepare("SELECT COUNT(*) AS n FROM session_catalog_headers").get().n) : memory.size; }
  function finishProvider(provider, token, { complete = false } = {}) {
    const state = states.get(provider); if (!state || !token || state.token !== token) return false;
    const success = complete && !state.invalid && !overflow;
    transaction(() => {
      if (success) {
        if (database) database.prepare("DELETE FROM session_catalog_headers WHERE provider=? AND generation<>?").run(provider,token);
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
          const result = database.prepare("UPDATE session_catalog_headers SET is_live=0,needs_input=0,activity_status='unknown' WHERE provider=? AND local_id=? AND (is_live<>0 OR needs_input<>0 OR activity_status<>'unknown')").run(provider,id);
          removed = Number(result.changes) > 0 || removed;
        }
        else { const row=memory.get(`${provider}:${id}`); if (row) { removed ||= row.isLive || row.needsInput || row.activityStatus !== "unknown"; Object.assign(row,{isLive:false,needsInput:false,activityStatus:"unknown"}); } }
      }
      lifecycleIds.set(provider,current); if (removed) changed();
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
    const row=database?database.prepare(`SELECT ${COLUMNS} FROM session_catalog_headers WHERE provider=? AND local_id=?`).get(parsed.providerId,parsed.localSessionId):memory.get(id);
    return row?publicRow(row):null;
  }
  function directory(query={}) {
    const {scope,hash,where,args}=queryParts(query);
    let offset=0,cursorReset=false;
    if (query.cursor) {
      let cursor;
      try { if (typeof query.cursor !== "string" || query.cursor.length>1024) throw new Error(); cursor=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")); } catch { cursor=null; }
      if (!Array.isArray(cursor) || cursor[0]!==epoch || cursor[1]!==revision || cursor[2]!==hash || !Number.isSafeInteger(cursor[3]) || cursor[3]<0) cursorReset=true;
      else offset=cursor[3];
    }
    if (query.revision!==undefined && query.revision!=="" && String(query.revision)!==String(revision)) {offset=0;cursorReset=true;}
    let rows,matchedCount,counts;
    if (database) {
      matchedCount=Number(database.prepare(`SELECT COUNT(*) AS n FROM session_catalog_headers${where}`).get(...args).n);
      const tallies=database.prepare("SELECT COUNT(*) AS all_count,coalesce(SUM(is_live),0) AS live,coalesce(SUM(CASE WHEN needs_input=1 OR activity_status='needs_input' THEN 1 ELSE 0 END),0) AS needs FROM session_catalog_headers").get();
      counts={all:Number(tallies.all_count),live:Number(tallies.live),needs:Number(tallies.needs)};
      rows=database.prepare(`SELECT ${COLUMNS} FROM session_catalog_headers${where} ORDER BY ${ORDERS[scope.sort]} LIMIT ? OFFSET ?`).all(...args,scope.pageSize,offset);
    } else {
      const all=[...memory.values()]; counts={all:all.length,live:all.filter(row=>row.isLive).length,needs:all.filter(row=>row.needsInput||row.activityStatus==="needs_input").length};
      const matches=all.filter(row=>(!scope.query||`${row.title} ${row.project} ${SOURCES[row.provider]}`.toLowerCase().includes(scope.query))&&(!scope.project||row.project===scope.project)&&(!scope.repositoryId||row.repositoryId===scope.repositoryId)&&(scope.filter!=="live"||row.isLive)&&(scope.filter!=="needs"||row.needsInput||row.activityStatus==="needs_input"));
      matches.sort((a,b)=> (scope.sort==="title"?a.title.toLowerCase().localeCompare(b.title.toLowerCase()):(scope.sort==="oldest"?1:-1)*((Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0))) || key(a).localeCompare(key(b)));
      matchedCount=matches.length; rows=matches.slice(offset,offset+scope.pageSize);
    }
    const facts=coverage();
    return {revision,coverage:facts,readiness:{catalog:facts.knownCount||facts.status==="complete"?"ready":facts.status==="partial"?"unavailable":"loading"},sessions:rows.map(publicRow),matchedCount,counts,pageSize:scope.pageSize,
      nextCursor:offset+rows.length<matchedCount?Buffer.from(JSON.stringify([epoch,revision,hash,offset+rows.length])).toString("base64url"):null,...(cursorReset?{cursorReset:true}:{})};
  }
  return Object.freeze({initialize,configureProviders,beginProvider,upsertHeaders,finishProvider,updateHeaders,updateProviderLifecycle,replaceProvider,directory,snapshot,coverage,get,
    diagnostics:()=>({residentRows:memory.size,maxResidentRows:memoryLimit,maxPageSize:PAGE_MAX,durable:Boolean(database)})});
}
