import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import {_x,bindEntityHistoricalImport,backupEntityHistoricalImport,restoreEntityHistoricalImport,resumeEntityHistoricalImportRestore,
 ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES as capability,ENTITY_HISTORICAL_IMPORT_RUNTIME,ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME} from '../dist/index.js';
import {XEntityManager} from '../dist/XEntityManager/XEntityManager.js';
import {backupSource} from './historical-backup-fixture.mjs';
const root=fs.mkdtempSync(path.join(tmpdir(),'historical-backup-tests-'));fs.chmodSync(root,0o700);
await _x.loadModuleAsync(new XEntityManager({_work_folder:path.join(root,'ordinary')}));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
async function setup(t,complete=true){const dir=path.join(root,randomUUID());fs.mkdirSync(dir,{mode:0o700});const f=await backupSource(dir);
 f.bound=await bindEntityHistoricalImport(f.options);t.after(()=>f.bound.close());
 if(complete)for(const unit of f.units)assert.equal((await f.bound.commit(unit))._ok,true);
 return f;
}
const dbAt=f=>new Database(path.join(f,'database.sqlite'));
function contents(dir){const db=dbAt(dir);try {return {
  metadata:db.prepare('SELECT * FROM entity_historical_import_meta').all(),receipts:db.prepare('SELECT * FROM entity_historical_import_receipts ORDER BY _id').all(),
  tables:db.prepare('SELECT table_name FROM entity_provider_meta ORDER BY logical_entity_id').all().map(r=>({name:r.table_name,rows:db.prepare('SELECT * FROM "'+r.table_name+'" ORDER BY _id').all()}))
 };}finally{db.close();}}
async function backup(f,extra={}){return backupEntityHistoricalImport({...f.backupOptions(f.bound),...extra});}

test('separate immutable capability leaves v1 import runtime unchanged',()=>{
 assert.equal(Object.isFrozen(capability),true);assert.equal(capability._financial_ready,false);
 assert.equal(ENTITY_HISTORICAL_IMPORT_RUNTIME,'ea9112862c89b3e1b193c7ea54a9cdb68c305ff2c69d1712a71c43953ccf98de');
 assert.notEqual(ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME,ENTITY_HISTORICAL_IMPORT_RUNTIME);
});
test('native encrypted backup and restore preserve eighteen tables, thirteen original rows and four immutable receipts',async t=>{
 const f=await setup(t),original=contents(f.options._destination),ack=await backup(f);
 assert.deepEqual(fs.readdirSync(f.backup).sort(),['envelope.json','snapshot.gcm']);
 assert.equal(ack._records,13);assert.equal(ack._receipts,4);assert.equal(ack._financial_ready,false);
 assert.equal(fs.readFileSync(path.join(f.backup,'snapshot.gcm')).includes(Buffer.from('SQLite format 3')),false);
 const restored=await restoreEntityHistoricalImport(f.restoreOptions());t.after(()=>restored.close());
 assert.deepEqual(contents(f.restored),original);assert.equal(original.tables.length,18);
 const user=original.tables.flatMap(t=>t.rows.map(row=>JSON.parse(row._json))).find(r=>r.password);
 assert.equal(await bcrypt.compare(f.password,user.password),true);assert.equal(user.password,f.records[1]._record.password);
 assert.equal(user._created_at,f.records[1]._record._created_at);assert.equal(user._updated_at,f.records[1]._record._updated_at);
 assert.equal(restored._restore._record_root,ack._record_root);assert.equal(restored._restore._receipt_root,ack._receipt_root);
 assert.equal(restored._restore._quarantined,true);assert.equal(restored._restore._financial_ready,false);
 assert.deepEqual(restored._restore._durability,{_journal_mode:'wal',_synchronous:2,_foreign_keys:1});
 assert.equal((await restored.reconcile())._ok,true);assert.equal((await f.bound.reconcile())._result._financial_ready,false);
 const db=dbAt(f.restored);try{
  const fact=JSON.parse(db.prepare('SELECT _json FROM entity_historical_import_restores').get()._json);
  assert.equal(fact._restore_id,f.restoreID);assert.notEqual(fact._binding._database._ino,JSON.parse(original.metadata[0]._json)._base._database._ino);
  assert.throws(()=>db.exec("UPDATE entity_historical_import_restores SET _json='{}'"));
  assert.throws(()=>db.exec('DELETE FROM entity_historical_import_receipts'));
  for(const table of original.tables) {
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(table.name+'_historical_delete'));
   if(table.rows.length)assert.throws(()=>db.exec('DELETE FROM "'+table.name+'"'));
  }
 }finally{db.close();}
});
test('committed WAL pages and authorized concurrent idempotent import are included in native backup',async t=>{
 const f=await setup(t,false),reader=dbAt(f.options._destination);reader.exec('BEGIN');reader.prepare('SELECT COUNT(*) FROM entity_historical_import_receipts').get();
 t.after(()=>reader.close());for(const unit of f.units)assert.equal((await f.bound.commit(unit))._ok,true);
 assert.ok(fs.statSync(path.join(f.options._destination,'database.sqlite-wal')).size>0);
 let execution;const ack=await backup(f,{_fault:point=>{if(point==='backup_progress'&&!execution)execution=f.bound.commit(f.units[0]);}});
 assert.equal((await execution)._result._replayed,true);assert.equal(ack._records,13);
 const restored=await restoreEntityHistoricalImport(f.restoreOptions());t.after(()=>restored.close());assert.equal(restored._restore._receipts,4);
});
test('incomplete sources, missing approved units, forged and closed owners are rejected',async t=>{
 const f=await setup(t,false);await assert.rejects(backup(f));assert.equal(fs.existsSync(f.backup),false);
 for(const unit of f.units)assert.equal((await f.bound.commit(unit))._ok,true);
 await assert.rejects(backup(f,{_units:[]}));await assert.rejects(backup(f,{_owner:{...f.bound}}));
 await assert.rejects(backup(f,{_expected_capability:{...capability,_version:0}}));
 await f.bound.close();await assert.rejects(backup(f));
});
test('corrupt receipts, altered schema, missing rows and provider metadata prevent publication',async t=>{
 for(const kind of ['receipt','schema','row','metadata']){
  const f=await setup(t),db=dbAt(f.options._destination);
  if(kind==='receipt'){db.exec('DROP TRIGGER import_receipt_update');db.exec("UPDATE entity_historical_import_receipts SET _json='{}'");}
  if(kind==='schema')db.exec('CREATE TABLE unexpected (id TEXT)');
  if(kind==='row'){const table=contents(f.options._destination).tables.find(t=>t.rows.length).name;db.exec('DROP TRIGGER "'+table+'_historical_delete"');db.exec('DELETE FROM "'+table+'"');}
  if(kind==='metadata')db.exec("UPDATE entity_provider_meta SET schema_json='{}'");
  db.close();await assert.rejects(backup(f));assert.equal(fs.existsSync(f.backup),false);
 }
});
for(const kind of ['wrong-key','missing-key','wrong-key-id','corrupt','truncated','header','unrelated-file','unapproved-manifest','unapproved-schema','wrong-units'])test(`restore rejects ${kind} before destination creation`,async t=>{
 const f=await setup(t);await backup(f);const options=f.restoreOptions();
 if(kind==='wrong-key')options._key=randomBytes(32);
 if(kind==='missing-key')delete options._key;
 if(kind==='wrong-key-id')options._key_id='unknown';
 if(kind==='corrupt'){const p=path.join(f.backup,'snapshot.gcm'),b=fs.readFileSync(p);b[16]^=1;fs.writeFileSync(p,b);}
 if(kind==='truncated'){const p=path.join(f.backup,'snapshot.gcm'),b=fs.readFileSync(p);fs.writeFileSync(p,b.subarray(0,30));}
 if(kind==='header'){const p=path.join(f.backup,'envelope.json'),v=JSON.parse(fs.readFileSync(p));v._nonce='0'.repeat(24);fs.writeFileSync(p,JSON.stringify(v));}
 if(kind==='unrelated-file')fs.writeFileSync(path.join(f.backup,'extra'),'unrelated');
 if(kind==='unapproved-manifest')options._manifest_sha256='0'.repeat(64);
 if(kind==='unapproved-schema')options._entities=options._entities.slice(0,-1);
 if(kind==='wrong-units')options._units=options._units.slice(1);
 await assert.rejects(restoreEntityHistoricalImport(options));assert.equal(fs.existsSync(f.restored),false);
});
test('new restore cannot overwrite targets and explicit resume rejects copied ownership',async t=>{
 const f=await setup(t);await backup(f);const r=await restoreEntityHistoricalImport(f.restoreOptions());
 await assert.rejects(restoreEntityHistoricalImport(f.restoreOptions()));await assert.rejects(resumeEntityHistoricalImportRestore(f.restoreOptions()));
 await assert.rejects(bindEntityHistoricalImport({...f.options,_destination:f.restored}));await r.close();
 const copy=f.restored+'-copy';fs.cpSync(f.restored,copy,{recursive:true});
 await assert.rejects(resumeEntityHistoricalImportRestore({...f.restoreOptions(),_destination:copy}));
 const reopened=await resumeEntityHistoricalImportRestore(f.restoreOptions());t.after(()=>reopened.close());assert.equal((await reopened.reconcile())._ok,true);
});
test('ordinary commands cannot issue backup or restore authority and restored tables cannot be registered',async t=>{
 const f=await setup(t);await backup(f);const r=await restoreEntityHistoricalImport(f.restoreOptions());t.after(()=>r.close());
 for(const dir of [f.options._destination,f.restored]){
  const command={_module:'entity-manager',_op:'register',_params:{_env:'default',_app_id:'synthetic-historical',_entity:{...f.options._entities[1],_storage:{_provider:'sqlite',_scope:'app',_db_path:path.join(dir,'database.sqlite')}}}};
  assert.equal((await _x.execute(command))._ok,false);
 }
 for(const op of ['backup-historical-import','restore-historical-import'])await assert.rejects(async()=>_x.execute({_module:'entity-manager',_op:op,_ctx:{_sid:'external'},_params:{}}));
});
test('restored owner can make another authenticated backup with immutable restoration provenance',async t=>{
 const f=await setup(t);await backup(f);const r=await restoreEntityHistoricalImport(f.restoreOptions());t.after(()=>r.close());
 const second=path.join(path.dirname(f.backup),'backup-2');await backupEntityHistoricalImport({...f.backupOptions(r),_destination:second});
 const destination=f.restored+'-2',r2=await restoreEntityHistoricalImport({...f.restoreOptions(),_backup:second,_destination:destination,_restore_id:randomUUID()});t.after(()=>r2.close());
 assert.deepEqual(contents(destination),contents(f.options._destination));const db=dbAt(destination);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_historical_import_restores').get().n,2);}finally{db.close();}
});
for(const operation of ['backup','restore'])test(`${operation} injected ENOSPC/write error never acknowledges completion`,async t=>{
 for(const code of ['ENOSPC','EIO']){
  const f=await setup(t);const originalWrite=fs.writeFileSync; const fault=p=>{if(p===(operation==='backup'?'backup_before_encrypted_write':'restore_before_image_write'))fs.writeFileSync=(fd,data)=>{fs.writeFileSync=originalWrite;originalWrite(fd,data.subarray(0,32));throw Object.assign(Error('synthetic partial write failure'),{code});};};
  if(operation==='backup'){await assert.rejects(backup(f,{_fault:fault}));assert.equal(fs.existsSync(f.backup),false);assert.equal((await f.bound.reconcile())._result._complete,true);}
  else{await backup(f);await assert.rejects(restoreEntityHistoricalImport({...f.restoreOptions(),_fault:fault}));await assert.rejects(resumeEntityHistoricalImportRestore(f.restoreOptions()));
   assert.equal(fs.existsSync(path.join(f.restored,'historical-restore.pending')),true);
   const fresh=await restoreEntityHistoricalImport({...f.restoreOptions(),_destination:f.restored+'-retry',_restore_id:randomUUID()});await fresh.close();}
 }
});
test('lost backup and restore acknowledgement recover via authenticated artifact and explicit resume',async t=>{
 const f=await setup(t);await assert.rejects(backup(f,{_fault:p=>{if(p==='backup_after_publish')throw Error('lost acknowledgement');}}));
 await assert.rejects(restoreEntityHistoricalImport({...f.restoreOptions(),_fault:p=>{if(p==='restore_before_acknowledgement')throw Error('lost acknowledgement');}}));
 const recovered=await resumeEntityHistoricalImportRestore(f.restoreOptions());t.after(()=>recovered.close());assert.equal((await recovered.reconcile())._ok,true);
 assert.equal(recovered._restore._records,13);assert.equal(recovered._restore._receipts,4);
});
test('concurrent backups cannot replace the same publication; the winner restores successfully',async t=>{
 const f=await setup(t),results=await Promise.allSettled([backup(f),backup(f)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const r=await restoreEntityHistoricalImport(f.restoreOptions());assert.equal(r._restore._records,13);await r.close();
});
test('a changed original proposal hash is rejected even when every approved source record remains intact',async t=>{
 const f=await setup(t),units=structuredClone(f.units);units[0]._valid_until=Date.parse('2030-01-01T00:00:00.000Z');
 await assert.rejects(backup(f,{_units:units}));assert.equal(fs.existsSync(f.backup),false);
});
test('replaced source inode fences a genuine backup owner before publication',async t=>{
 const f=await setup(t),file=path.join(f.options._destination,'database.sqlite');
 await assert.rejects(backup(f,{_fault:p=>{if(p==='backup_before_native'){fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file);}}}));
 assert.equal(fs.existsSync(f.backup),false);assert.equal((await f.bound.reconcile())._ok,false);
});
test('changed current restore binding cannot be adopted, including after graceful close',async t=>{
 const f=await setup(t);await backup(f);const r=await restoreEntityHistoricalImport(f.restoreOptions());await r.close();
 const db=dbAt(f.restored);db.exec('DROP TRIGGER historical_restore_update');
 const row=db.prepare('SELECT _json FROM entity_historical_import_restores').get(),fact=JSON.parse(row._json);
 fact._binding._destination='0'.repeat(64);db.prepare('UPDATE entity_historical_import_restores SET _json=?').run(JSON.stringify(fact));
 db.exec("CREATE TRIGGER historical_restore_update BEFORE UPDATE ON entity_historical_import_restores BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END");db.close();
 await assert.rejects(resumeEntityHistoricalImportRestore(f.restoreOptions()));
});
