# GATES.md — v14: Temporal Validity + CodeGraph Entry Points + Causal Links + Provenance

## G1: Temporal validity columns exist (schema v17)
- [x] G1
  - CHECK: `node -e "const{SQLiteBackend}=require('./dist/sdk.js');const s=new SQLiteBackend('/tmp/g1-test.db');const cols=s.getDatabase().prepare('PRAGMA table_info(captures)').all().map(c=>c.name);console.log(cols.filter(c=>['valid_from','valid_until'].includes(c)).sort().join(','));s.close();require('fs').unlinkSync('/tmp/g1-test.db')"`
  - EXPECT: `valid_from,valid_until`

## G2: Supersede closes old version with valid_until
- [x] G2
  - CHECK: `node --input-type=module -e "import{Memory}from'./dist/sdk.js';import{SQLiteBackend}from'./dist/storage/sqlite.js';const tmp='/tmp/g2-test.db';const m=new Memory({dbPath:tmp});const s=new SQLiteBackend(tmp);const id1=await m.capture('DB is PostgreSQL v14','decision',['db']);await new Promise(r=>setTimeout(r,10));const id2=await m.capture('DB is PostgreSQL v16','decision',['db']);await s.supersede(id1,id2);const row=s.getDatabase().prepare('SELECT valid_until IS NOT NULL as has_vu FROM captures WHERE id=?').get(id1);console.log(row.has_vu);m.close();s.close();require('fs').unlinkSync(tmp)"`
  - EXPECT: `1`

## G3: Search filters out facts past valid_until
- [x] G3
  - CHECK: `node --input-type=module -e "import{Memory}from'./dist/sdk.js';import{SQLiteBackend}from'./dist/storage/sqlite.js';const tmp='/tmp/g3-test.db';const m=new Memory({dbPath:tmp});const s=new SQLiteBackend(tmp);const old=await m.capture('API endpoint is /v1/users','decision',['api']);await new Promise(r=>setTimeout(r,10));const newer=await m.capture('API endpoint is /v2/users','decision',['api']);await s.supersede(old,newer);const results=await m.recall('API endpoint users',{limit:5});const foundOld=results.some(r=>r.entry.content.includes('/v1/users'));console.log(foundOld);m.close();s.close();require('fs').unlinkSync(tmp)"`
  - EXPECT: `false`

## G4: CodeGraph findEntryPoints detects main function
- [x] G4
  - CHECK: `node --input-type=module -e "import Database from'better-sqlite3';import*as sqliteVec from'sqlite-vec';import{readFileSync}from'fs';import{indexDirectory,findEntryPoints}from'./dist/codegraph/engine.js';import{mkdirSync,writeFileSync,rmSync}from'fs';import{join}from'path';const tmp='/tmp/g4-repo';mkdirSync(tmp,{recursive:true});writeFileSync(join(tmp,'main.ts'),'export function main(){console.log(\"hello\")}');writeFileSync(join(tmp,'utils.ts'),'export function helper(){return 42}');const db=new Database(':memory:');sqliteVec.load(db);db.exec(readFileSync('src/storage/schema.sql','utf-8'));await indexDirectory(db,tmp,tmp);const eps=findEntryPoints(db,{repoPath:tmp});console.log(eps.map(e=>e.name).join(','));rmSync(tmp,{recursive:true,force:true})"`
  - EXPECT: `main`

## G5: CodeGraph findEntryPoints detects HTTP handlers
- [x] G5
  - CHECK: `node --input-type=module -e "import Database from'better-sqlite3';import*as sqliteVec from'sqlite-vec';import{readFileSync}from'fs';import{indexDirectory,findEntryPoints}from'./dist/codegraph/engine.js';import{mkdirSync,writeFileSync,rmSync}from'fs';import{join}from'path';const tmp='/tmp/g5-repo';mkdirSync(tmp,{recursive:true});writeFileSync(join(tmp,'server.ts'),'export function handleGetUsers(req,res){return res.json()}\\nexport function handlePostUser(req,res){return res.json()}\\nexport function helper(){return 1}');const db=new Database(':memory:');sqliteVec.load(db);db.exec(readFileSync('src/storage/schema.sql','utf-8'));await indexDirectory(db,tmp,tmp);const eps=findEntryPoints(db,{repoPath:tmp});console.log(eps.map(e=>e.name).sort().join(','));rmSync(tmp,{recursive:true,force:true})"`
  - EXPECT: `handleGetUsers,handlePostUser`

## G6: Causal link auto-extraction creates cause-effect links
- [x] G6
  - CHECK: `node --input-type=module -e "import{Memory}from'./dist/sdk.js';import{SQLiteBackend}from'./dist/storage/sqlite.js';const tmp='/tmp/g6-test.db';const m=new Memory({dbPath:tmp});const s=new SQLiteBackend(tmp);const id1=await m.capture('Missing vitest config caused test failure','error',['test','vitest']);const id2=await m.capture('Added vitest.config.ts which fixed the tests','task',['test','vitest']);const links=s.getDatabase().prepare(\"SELECT link_type FROM memory_links WHERE link_type='cause-effect'\").all();console.log(links.length);m.close();s.close();require('fs').unlinkSync(tmp)"`
  - EXPECT: `1`

## G7: Provenance source_ref column exists (schema v17)
- [x] G7
  - CHECK: `node -e "const{SQLiteBackend}=require('./dist/sdk.js');const s=new SQLiteBackend('/tmp/g7-test.db');const cols=s.getDatabase().prepare('PRAGMA table_info(captures)').all().map(c=>c.name);console.log(cols.includes('source_ref'));s.close();require('fs').unlinkSync('/tmp/g7-test.db')"`
  - EXPECT: `true`

## G8: Capture with metadata.source stores source_ref
- [x] G8
  - CHECK: `node --input-type=module -e "import{Memory}from'./dist/sdk.js';import{SQLiteBackend}from'./dist/storage/sqlite.js';const tmp='/tmp/g8-test.db';const m=new Memory({dbPath:tmp});const s=new SQLiteBackend(tmp);const id=await m.capture('Test content','learning',['test'],{metadata:{source:'bash:git status'}});const row=s.getDatabase().prepare('SELECT source_ref FROM captures WHERE id=?').get(id);console.log(row.source_ref);m.close();s.close();require('fs').unlinkSync(tmp)"`
  - EXPECT: `bash:git status`

## G9: All existing tests still pass
- [x] G9
  - CHECK: `npx vitest run --reporter=dot 2>&1 | tail -5`
  - EXPECT: `Test Files` and `passed` in output with 0 failures
