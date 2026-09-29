import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMonitorStore } from "../monitor/monitor-store.mjs";
import { createSessionCatalogInventory } from "../monitor/session-catalog-inventory.mjs";

const row = (index, extras = {}) => ({ localId: `session-${index}`, title: `Session ${String(index).padStart(5,"0")}`, project: index % 2 ? "Other" : "Pomegr", createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), isLive: false, needsInput: false, activityStatus: "idle", ...extras });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(),"pomegr-catalog-"));
  const store = await openMonitorStore({ directory });
  t.after(async () => { store.close(); await rm(directory,{recursive:true,force:true}); });
  const inventory = createSessionCatalogInventory({store:()=>store,providers:["codex","claude"],...options});
  inventory.initialize();
  return {inventory,store};
}
function load(inventory, provider, count, extra = {}) {
  const token = inventory.beginProvider(provider);
  for(let offset=0;offset<count;offset+=100) inventory.upsertHeaders(provider,Array.from({length:Math.min(100,count-offset)},(_,i)=>row(offset+i,extra)),token);
  inventory.finishProvider(provider,token,{complete:true});
}

test("all 3000 identities are reachable through bounded SQL pages without a resident global array",async(t)=>{
  const {inventory,store}=await fixture(t);
  load(inventory,"codex",3000); load(inventory,"claude",0);
  assert.equal(inventory.coverage().exactTotal,3000);
  const seen=new Set(); let cursor;
  do {
    const page=inventory.directory({pageSize:100,cursor});
    assert.ok(page.sessions.length<=100); assert.equal(page.matchedCount,3000);
    for(const item of page.sessions) {assert.ok(!seen.has(item.id));seen.add(item.id);}
    cursor=page.nextCursor;
  } while(cursor);
  assert.equal(seen.size,3000);
  assert.equal(inventory.diagnostics().residentRows,0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM session_catalog_headers").get().n,3000);
  assert.equal(inventory.directory({pageSize:99999}).sessions.length,100);
});

test("all configured providers must finish, failures preserve identities and prior completed ages",async(t)=>{
  let clock=1_800_000_000_000;
  const {inventory}=await fixture(t,{now:()=>clock});
  load(inventory,"codex",2);
  assert.equal(inventory.coverage().status,"discovering"); assert.equal(inventory.coverage().exactTotal,null);
  load(inventory,"claude",1);
  const complete=inventory.coverage(); assert.equal(complete.exactTotal,3);
  clock+=60_000;
  const scan=inventory.beginProvider("codex");
  assert.equal(inventory.coverage().exactTotal,null);
  inventory.upsertHeaders("codex",[row(10)],scan);
  inventory.finishProvider("codex",scan,{complete:false});
  assert.equal(inventory.coverage().status,"partial"); assert.equal(inventory.coverage().knownCount,4);
  assert.equal(inventory.coverage().lastCompletedTotal,3); assert.equal(inventory.coverage().lastCompletedAt,complete.lastCompletedAt);
  assert.ok(inventory.get("codex:session-0"));
  inventory.replaceProvider("codex",[],"ready");
  assert.equal(inventory.coverage().exactTotal,null,"a ready shell cannot promote incomplete enumeration");
});

test("dedupe uses provider identity, retains earliest creation and validates privacy fields",async(t)=>{
  const {inventory,store}=await fixture(t);
  const token=inventory.beginProvider("codex");
  inventory.upsertHeaders("codex",[row(1,{prompt:"SECRET",transcriptPath:"PRIVATE",rawId:"RAW"}),row(1,{createdAt:"2020-01-01T00:00:00.000Z"})],token);
  inventory.finishProvider("codex",token,{complete:true}); load(inventory,"claude",2);
  assert.equal(inventory.coverage().exactTotal,3);
  const serialized=JSON.stringify(inventory.directory());
  for(const secret of ["SECRET","PRIVATE","RAW","transcriptPath","prompt"]) assert.ok(!serialized.includes(secret));
  assert.equal(inventory.get("codex:session-1").createdAt,"2020-01-01T00:00:00.000Z");
  const bad=inventory.beginProvider("codex");
  inventory.upsertHeaders("codex",[{localId:"C:\\private\\secret"},{},row(2,{activityStatus:"SECRET"})],bad);
  inventory.finishProvider("codex",bad,{complete:true});
  assert.equal(inventory.coverage().exactTotal,null); assert.equal(inventory.get("codex:session-2").activityStatus,"unknown");
  const columns=store.database.prepare("PRAGMA table_info(session_catalog_headers)").all().map(item=>item.name);
  assert.ok(!columns.some(column=>/prompt|path|raw|content/.test(column)));
});

test("search/filter, newest-created order, and query-bound cursors read committed data only",async(t)=>{
  const {inventory,store}=await fixture(t);
  load(inventory,"codex",120);load(inventory,"claude",0);
  inventory.updateHeaders("codex",[row(10,{isLive:true,needsInput:true,activityStatus:"needs_input"})]);
  assert.equal(inventory.directory({filter:"live"}).matchedCount,1);
  assert.equal(inventory.directory({filter:"needs"}).matchedCount,1);
  assert.equal(inventory.directory({project:"Pomegr"}).matchedCount,60);
  assert.equal(inventory.directory({query:"Session 00010"}).sessions[0].id,"codex:session-10");
  assert.equal(inventory.directory({}).sessions[0].id,"codex:session-119");
  const first=inventory.directory({pageSize:2});
  assert.equal(inventory.directory({pageSize:2,cursor:first.nextCursor}).sessions[0].id,"codex:session-117");
  assert.equal(inventory.directory({pageSize:2,cursor:first.nextCursor,query:"Other"}).cursorReset,true);
  assert.equal(inventory.directory({pageSize:2,cursor:"not-a-cursor"}).cursorReset,true);
  const before=store.database.prepare("SELECT total_changes() AS n").get().n;
  for(let i=0;i<5;i++){inventory.directory({query:"Pomegr",filter:"live"});inventory.get("codex:session-10");inventory.coverage();}
  assert.equal(store.database.prepare("SELECT total_changes() AS n").get().n,before);
});

test("later pages stay in place while live sessions update and new sessions arrive",async(t)=>{
  const {inventory}=await fixture(t);
  load(inventory,"codex",10);load(inventory,"claude",0);
  const second=inventory.directory({pageSize:3,cursor:inventory.directory({pageSize:3}).nextCursor});
  assert.deepEqual(second.sessions.map((item)=>item.id),["codex:session-6","codex:session-5","codex:session-4"]);
  inventory.updateProviderLifecycle("codex",[row(8,{isLive:true,activityStatus:"working",updatedAt:"2030-01-01T00:00:00Z"})]);
  inventory.updateHeaders("codex",[row(10)]);
  const again=inventory.directory({pageSize:3,cursor:inventory.directory({pageSize:3}).nextCursor});
  assert.equal(again.cursorReset,undefined);
  assert.deepEqual(inventory.directory({pageSize:3}).sessions.map((item)=>item.id),["codex:session-10","codex:session-9","codex:session-8"]);
  const third=inventory.directory({pageSize:3,cursor:second.nextCursor});
  assert.equal(third.cursorReset,undefined);
  assert.deepEqual(third.sessions.map((item)=>item.id),["codex:session-3","codex:session-2","codex:session-1"]);
  assert.deepEqual(inventory.directory({pageSize:3,cursor:third.nextCursor}).sessions.map((item)=>item.id),["codex:session-0"]);
  assert.equal(inventory.directory({pageSize:3,cursor:third.nextCursor}).nextCursor,null);
  const memory=createSessionCatalogInventory({providers:["codex"]});load(memory,"codex",7);
  const ids=[];let cursor;
  do {const page=memory.directory({pageSize:3,cursor});ids.push(...page.sessions.map((item)=>item.id));cursor=page.nextCursor;} while(cursor);
  assert.deepEqual(ids,[6,5,4,3,2,1,0].map((index)=>`codex:session-${index}`));
});

test("reopen preserves completed facts but requires fresh enumeration and keeps page cursors",async(t)=>{
  const {inventory,store}=await fixture(t);load(inventory,"codex",120);load(inventory,"claude",0);
  inventory.updateProviderLifecycle("codex",[row(1,{isLive:true,needsInput:true,activityStatus:"needs_input"})]);
  const before=inventory.coverage(), cursor=inventory.directory({pageSize:2}).nextCursor;
  const restarted=createSessionCatalogInventory({store:()=>store,providers:["codex","claude"]});restarted.initialize();
  assert.equal(restarted.coverage().exactTotal,null);assert.equal(restarted.coverage().knownCount,120);
  assert.equal(restarted.coverage().lastCompletedTotal,120);assert.equal(restarted.coverage().lastCompletedAt,before.lastCompletedAt);
  assert.equal(restarted.get("codex:session-1").isLive,false);
  assert.equal(restarted.directory({pageSize:2,cursor}).cursorReset,undefined);
  assert.equal(restarted.directory({pageSize:2,cursor}).sessions[0].id,"codex:session-117");
});

test("bounded fallback never claims exactness after overflow and stale scans cannot finish",()=>{
  const inventory=createSessionCatalogInventory({providers:["codex"],maxMemoryRows:2});
  load(inventory,"codex",10);assert.equal(inventory.diagnostics().residentRows,2);assert.equal(inventory.coverage().exactTotal,null);
  const old=inventory.beginProvider("codex"), current=inventory.beginProvider("codex");
  assert.equal(inventory.upsertHeaders("codex",[row(9)],old),false);
  assert.equal(inventory.finishProvider("codex",old,{complete:true}),false);
  assert.equal(inventory.finishProvider("codex",current,{complete:false}),true);
  assert.throws(()=>inventory.upsertHeaders("codex",Array(101).fill(row(0)),null),/bound/);
});

test("header rescans preserve current lifecycle and identical shell updates preserve page cursors",async(t)=>{
  const {inventory}=await fixture(t);load(inventory,"codex",4);load(inventory,"claude",0);
  const live=[row(1,{isLive:true,activityStatus:"working"}),row(2,{isLive:true,needsInput:true,activityStatus:"needs_input"})];
  inventory.updateProviderLifecycle("codex",live);
  const page=inventory.directory({pageSize:1});
  inventory.updateProviderLifecycle("codex",live);
  assert.equal(inventory.snapshot().revision,page.revision);
  assert.equal(inventory.directory({pageSize:1,cursor:page.nextCursor}).cursorReset,undefined);
  const token=inventory.beginProvider("codex");inventory.upsertHeaders("codex",[row(1,{updatedAt:"2030-01-01T00:00:00Z"})],token);
  assert.equal(inventory.get("codex:session-1").isLive,true);
  inventory.updateProviderLifecycle("codex",[]);
  assert.equal(inventory.get("codex:session-1").isLive,false);assert.equal(inventory.get("codex:session-2").needsInput,false);
});

test("directory SELECT materializes only its bounded page and changed source scope clears old facts",async(t)=>{
  const {store}=await fixture(t);
  const materializations=[];
  const database=new Proxy(store.database,{get(target,property){
    if(property==="prepare") return (sql)=>{
      const statement=target.prepare(sql);
      return new Proxy(statement,{get(query,method){
        if(method==="all") return (...args)=>{const result=query.all(...args);materializations.push({sql,count:result.length});return result;};
        const value=Reflect.get(query,method);return typeof value==="function"?value.bind(query):value;
      }});
    };
    const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
  }});
  const inventory=createSessionCatalogInventory({store:()=>({database}),providers:["codex"]});
  inventory.configureProviders(["codex"],{scopeKey:"a".repeat(64)});inventory.initialize();load(inventory,"codex",700);
  const next=inventory.directory({}).nextCursor;
  for(const query of [{cursor:next},{query:"Session"},{filter:"live"}]) inventory.directory(query);
  assert.equal(materializations.length,4);
  // One lookahead row decides whether a next page exists.
  for(const result of materializations){assert.match(result.sql,/LIMIT \?$/);assert.ok(result.count<=26);}
  inventory.configureProviders(["codex"],{scopeKey:"b".repeat(64)});
  assert.equal(inventory.coverage().knownCount,0);assert.equal(inventory.coverage().lastCompletedTotal,null);assert.equal(inventory.coverage().exactTotal,null);
});

const status=(inventory,id)=>inventory.directory({pageSize:100}).sessions.find((item)=>item.id===id)?.activityStatus;
const reopen=(store)=>{const next=createSessionCatalogInventory({store:()=>store,providers:["codex","claude"]});next.initialize();return next;};

test("a settled status survives restart and stays unknown until the provider's first presence pass",async(t)=>{
  const {inventory,store}=await fixture(t);
  load(inventory,"claude",3);load(inventory,"codex",0);
  const lifecycle=[row(0,{activityStatus:"idle"}),row(1,{activityStatus:"closed"}),row(2,{isLive:true,activityStatus:"working"})];
  const ids=["claude:session-0","claude:session-1","claude:session-2"];
  inventory.updateProviderLifecycle("claude",lifecycle);
  assert.deepEqual(ids.map((id)=>status(inventory,id)),["idle","closed","working"]);
  const restarted=reopen(store);
  assert.equal(restarted.get("claude:session-0").isLive,false);
  assert.deepEqual(ids.map((id)=>status(restarted,id)),["unknown","unknown","unknown"]);
  assert.equal(store.database.prepare("SELECT settled_status AS s FROM session_catalog_headers WHERE local_id='session-1'").get().s,"closed");
  // A resumed session is live at its first observation and never shows an intermediate idle.
  restarted.updateProviderLifecycle("claude",lifecycle);
  assert.deepEqual(ids.map((id)=>status(restarted,id)),["idle","closed","working"]);
  const other=reopen(store);other.updateProviderLifecycle("codex",[]);
  assert.equal(status(other,"claude:session-0"),"unknown","presence is gated per provider");
});

test("a row that leaves the lifecycle set keeps its settled status while presence clears",async(t)=>{
  const {inventory}=await fixture(t);
  load(inventory,"claude",1);load(inventory,"codex",0);
  inventory.updateProviderLifecycle("claude",[row(0,{isLive:true,activityStatus:"working"})]);
  assert.equal(status(inventory,"claude:session-0"),"working");
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"stopped"})]);
  inventory.updateProviderLifecycle("claude",[]);
  assert.equal(status(inventory,"claude:session-0"),"stopped");
  inventory.updateProviderLifecycle("claude",[row(0,{isLive:true,needsInput:true,activityStatus:"needs_input"})]);
  inventory.updateProviderLifecycle("claude",[]);
  assert.equal(inventory.get("claude:session-0").isLive,false);assert.equal(inventory.get("claude:session-0").needsInput,false);
  assert.equal(status(inventory,"claude:session-0"),"stopped");
});

test("closed and stopped are never downgraded to idle and unknown never overwrites a settled value",async(t)=>{
  const {inventory}=await fixture(t);
  load(inventory,"claude",1,{activityStatus:"idle"});load(inventory,"codex",0);
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"idle"})]);
  assert.equal(status(inventory,"claude:session-0"),"idle");
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"closed"})]);
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"idle"})]);
  const scan=inventory.beginProvider("claude");inventory.upsertHeaders("claude",[row(0,{activityStatus:"idle"})],scan);inventory.finishProvider("claude",scan,{complete:true});
  inventory.updateHeaders("claude",[row(0,{activityStatus:"unknown"})],{preserveLifecycle:true});
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"unknown"})]);
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"open"})]);
  inventory.updateProviderLifecycle("claude",[]);
  assert.equal(status(inventory,"claude:session-0"),"closed");
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"stopped"})]);
  assert.equal(status(inventory,"claude:session-0"),"stopped");
  // An expired Open row is not a settled value: it shows its presence status and stores none.
  const fresh=createSessionCatalogInventory({providers:["claude"]});load(fresh,"claude",1,{activityStatus:"unknown"});
  fresh.updateProviderLifecycle("claude",[row(0,{activityStatus:"open"})]);
  fresh.updateProviderLifecycle("claude",[]);
  assert.equal(status(fresh,"claude:session-0"),"unknown");
});

test("header scans supply the adapter fallback without touching presence, in the durable and memory index",async(t)=>{
  const {inventory,store}=await fixture(t);
  load(inventory,"claude",2,{activityStatus:"idle"});load(inventory,"codex",2,{activityStatus:"unknown"});
  inventory.updateProviderLifecycle("claude",[]);inventory.updateProviderLifecycle("codex",[]);
  assert.equal(status(inventory,"claude:session-0"),"idle");assert.equal(status(inventory,"codex:session-0"),"unknown");
  assert.equal(store.database.prepare("SELECT settled_status AS s FROM session_catalog_headers WHERE provider='codex' AND local_id='session-0'").get().s,null);
  const memory=createSessionCatalogInventory({providers:["claude"]});load(memory,"claude",1,{activityStatus:"idle"});
  assert.equal(status(memory,"claude:session-0"),"unknown");
  memory.updateProviderLifecycle("claude",[row(0,{activityStatus:"closed"})]);memory.updateProviderLifecycle("claude",[]);
  const scan=memory.beginProvider("claude");memory.upsertHeaders("claude",[row(0,{activityStatus:"idle"})],scan);memory.finishProvider("claude",scan,{complete:true});
  assert.equal(status(memory,"claude:session-0"),"closed");
});

test("Live and Needs input filters and counts use presence only",async(t)=>{
  const {inventory}=await fixture(t);
  load(inventory,"claude",4,{activityStatus:"idle"});load(inventory,"codex",0);
  inventory.updateProviderLifecycle("claude",[row(0,{activityStatus:"closed"}),row(1,{isLive:true,activityStatus:"working"}),row(2,{isLive:true,needsInput:true,activityStatus:"needs_input"})]);
  const page=inventory.directory({pageSize:100});
  assert.deepEqual(page.counts,{all:4,live:2,needs:1});
  assert.equal(inventory.directory({filter:"live"}).matchedCount,2);assert.equal(inventory.directory({filter:"needs"}).matchedCount,1);
  assert.equal(page.matchedCount,4);
});

test("an inventory created before the settled column opens, keeps its rows and gains the column",async(t)=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"pomegr-catalog-old-"));
  const store=await openMonitorStore({directory});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  store.database.exec(`CREATE TABLE session_catalog_headers (
      provider TEXT NOT NULL, local_id TEXT NOT NULL, title TEXT NOT NULL, project TEXT NOT NULL,
      created_at TEXT, updated_at TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
      is_live INTEGER NOT NULL, needs_input INTEGER NOT NULL, activity_status TEXT NOT NULL, repository_id TEXT,
      generation TEXT NOT NULL, PRIMARY KEY(provider,local_id)) WITHOUT ROWID;
    INSERT INTO session_catalog_headers VALUES ('claude','old-1','Old','Pomegr','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1767225600000,1767225600000,0,0,'idle',NULL,'g');`);
  const inventory=createSessionCatalogInventory({store:()=>store,providers:["claude"]});
  assert.equal(inventory.initialize(),true);
  assert.ok(store.database.prepare("PRAGMA table_info(session_catalog_headers)").all().some((column)=>column.name==="settled_status"));
  assert.equal(inventory.get("claude:old-1").title,"Old");assert.equal(inventory.get("claude:old-1").activityStatus,"unknown");
  inventory.updateProviderLifecycle("claude",[{localId:"old-1",activityStatus:"idle",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"}]);
  assert.equal(inventory.get("claude:old-1").activityStatus,"idle");
  assert.doesNotThrow(()=>createSessionCatalogInventory({store:()=>store,providers:["claude"]}).initialize());
});
