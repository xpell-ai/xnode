import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync,readFileSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import {_x,bindEntityHistoricalImport,bindEntityLocalUnit,ENTITY_HISTORICAL_IMPORT_CAPABILITIES as capabilities,ENTITY_HISTORICAL_IMPORT_RUNTIME,ENTITY_LOCAL_UNIT_CAPABILITIES,ENTITY_LOCAL_UNIT_HASH_CAPABILITIES} from '../dist/index.js';
import {XEntityManager} from '../dist/XEntityManager/XEntityManager.js';
import {makeSource,batch,hash,canonical} from './historical-import-fixture.mjs';
const work=mkdtempSync(path.join(tmpdir(),'historical-import-tests-')),manager=new XEntityManager({_work_folder:path.join(work,'ordinary')});await _x.loadModuleAsync(manager);
after(()=>rmSync(work,{recursive:true,force:true}));
async function setup(t,profile='expanded-v1',count=4,extra={}){
 const f=await makeSource(path.join(work,randomUUID()),profile,count);f.options={...f.options,...extra};f.bound=await bindEntityHistoricalImport(f.options);t.after(()=>f.bound.close());
 f.open=()=>new Database(path.join(f.options._destination,'database.sqlite'));
 f.rows=()=>{const db=f.open();try{return db.prepare("SELECT table_name FROM entity_provider_meta ORDER BY logical_entity_id").all().flatMap(row=>db.prepare('SELECT _json FROM "'+row.table_name+'"').all().map(r=>JSON.parse(r._json)));}finally{db.close();}};
 return f;
}
const failure=r=>assert.equal(r._ok,false);

test('historical capability is immutable, separate, and retains original descriptors',async t=>{
 const f=await setup(t);for(const o of [capabilities,f.bound,f.bound._import,f.bound._capacity,f.bound._capacity._limits])assert.equal(Object.isFrozen(o),true);
 assert.equal(f.bound._import._policy,'preserve-historical-v1');assert.equal(f.bound._import._runtime,ENTITY_HISTORICAL_IMPORT_RUNTIME);
 assert.deepEqual(ENTITY_LOCAL_UNIT_CAPABILITIES._profiles,{'standard-v1':{_records:8,_writes:4,_entities:8,_bytes:65536},'expanded-v1':{_records:10,_writes:5,_entities:8,_bytes:65536}});
 assert.deepEqual(ENTITY_LOCAL_UNIT_HASH_CAPABILITIES,{_version:1,_policies:{'create-and-preserve-v1':{_create:'provider-bcrypt-10',_update:'preserve-existing-hash',_prehashed_create:'reject'}}});
});
test('original GUIDs, bcrypt bytes, timestamps, all fields and account links survive approved native import',async t=>{
 const f=await setup(t),r=await f.bound.commit(batch(f.records));assert.equal(r._ok,true);assert.deepEqual(r._result._import,f.bound._import);assert.deepEqual(r._result._capacity,f.bound._capacity);
 for(const record of f.records)assert.deepEqual(f.rows().find(row=>row._id===record._record._id),record._record);
 const user=f.rows().find(row=>row.password);assert.equal(await bcrypt.compare(f.password,user.password),true);assert.equal(user.password,f.records[1]._record.password);
 assert.deepEqual(r._result._durability,{_journal_mode:'wal',_synchronous:2,_foreign_keys:1});assert.equal(r._result._financial_ready,false);
 const reconciliation=await f.bound.reconcile();assert.equal(reconciliation._ok,true);assert.equal(reconciliation._result._complete,true);assert.equal(reconciliation._result._records,4);assert.equal(reconciliation._result._financial_ready,false);
});
for(const count of [1,13])test(`multi-batch ${count}-record inventory stays quarantined until complete independent reconciliation`,async t=>{
 const f=await setup(t,'expanded-v1',count);
 for(let i=0;i<count;i+=3){assert.equal((await f.bound.commit(batch(f.records.slice(i,i+3))))._ok,true);const r=await f.bound.reconcile();assert.equal(r._ok,true);assert.equal(r._result._complete,i+3>=count);assert.equal(r._result._financial_ready,false);assert.equal(r._result._quarantined,true);}
});
test('same batch reconciles idempotently after close/reopen and does not duplicate receipts or rows',async t=>{
 const f=await setup(t),u=batch(f.records),first=await f.bound.commit(u);assert.equal(first._ok,true);await f.bound.close();
 f.bound=await bindEntityHistoricalImport(f.options);const again=await f.bound.commit(u);assert.equal(again._ok,true);assert.equal(again._result._replayed,true);assert.deepEqual(again._result._receipt,first._result._receipt);
 const r=await f.bound.reconcile();assert.equal(r._result._receipts,1);assert.equal(r._result._records,4);
});
test('immutable policy snapshots cannot be changed by mutating bootstrap options',async t=>{
 const f=await setup(t);f.options._manifest_sha256='0'.repeat(64);f.options._entities.length=0;f.options._manifest._source_root='0'.repeat(64);f.options._capacity_profile='standard-v1';
 assert.equal((await f.bound.commit(batch(f.records)))._ok,true);
});
test('wrong source, schemas, runtime, policy and duplicate source GUIDs fail before destination issuance',async t=>{
 for(const mutate of [f=>f.options._manifest_sha256='0'.repeat(64),f=>f.options._manifest._source_root='0'.repeat(64),f=>f.options._manifest._runtime='0'.repeat(64),f=>f.options._expected_capability={...capabilities,_version:0},f=>f.options._entities[0]._schema.value._max_length=1,f=>f.options._policy='unrestricted',f=>f.options._manifest._entities[0]._records.push(f.options._manifest._entities[0]._records[0])]){
  const f=await makeSource(path.join(work,randomUUID()));mutate(f);await assert.rejects(bindEntityHistoricalImport(f.options));
 }
});
test('new destination rejects ordinary CRUD fallback, old unrelated databases and changed scope/run',async t=>{
 const f=await setup(t),dbPath=path.join(f.options._destination,'database.sqlite');
 const command=(op,params)=>_x.execute({_module:'entity-manager',_op:op,_params:{_env:'default',_app_id:'synthetic-historical',...params}});
 failure(await command('register',{_entity:{...f.options._entities[1],_storage:{_provider:'sqlite',_scope:'app',_db_path:dbPath}}}));
 await f.bound.close();const bad=structuredClone({...f.options,_clock:undefined});delete bad._clock;bad._manifest._run_id=randomUUID();bad._manifest_sha256=hash(bad._manifest);await assert.rejects(bindEntityHistoricalImport(bad));
 const directory=path.join(work,randomUUID());const other=new Database(directory+'.sqlite');other.close();await assert.rejects(bindEntityHistoricalImport({...f.options,_destination:directory+'.sqlite'}));
});
test('transport, arbitrary commands, updates and caller policy/timestamp alterations cannot escalate authority',async t=>{
 const f=await setup(t),key=[...manager._historical_imports.keys()].at(-1),u=batch(f.records);
 for(const extra of [{_policy:'preserve-historical-v1'},{_hash_policy:'create-and-preserve-v1'},{_unit_id:randomUUID()}])failure(await f.bound.commit({...u,...extra}));
 failure(await _x.execute({_module:'entity-manager',_op:'commit-historical-import',_ctx:{_sid:'untrusted'},_params:{_historical_import_key:key,_unit:u}}));
 failure(await _x.execute({_module:'entity-manager',_op:'commit-historical-import',_params:{_historical_import_key:randomUUID(),_unit:u}}));
 const changed=batch(f.records);changed._records[0]._create._updated_at='2021-02-03T04:05:06.008Z';failure(await f.bound.commit(changed));
 const update=batch(f.records);update._records[0]._update={value:'overwrite'};failure(await f.bound.commit(update));assert.equal(f.rows().length,0);
});
for(const modify of [r=>r.password='plaintext',r=>r.password='$2x$10$invalid',r=>delete r.password,r=>r._created_at='2025-01-01T00:00:00.000Z',r=>r._updated_at='2021-02-03T04:05:06Z',r=>r.extra='unmapped',r=>r.amount='1'])test('invalid historical credential/timestamp/field is rejected without partial writes '+modify.toString().slice(3,28),async t=>{
 const f=await setup(t);const u=batch(f.records);modify(u._records[1]._create);failure(await f.bound.commit(u));assert.equal(f.rows().length,0);
});
for(const point of ['after_write_1','after_write_2','after_write_3','after_write_4','after_write_5','before_commit'])test(`historical import rolls back records and genuine receipt at ${point}`,async t=>{
 const f=await setup(t,'expanded-v1',4,{_fault:p=>{if(p===point)throw Error('synthetic native failure');}});failure(await f.bound.commit(batch(f.records)));assert.equal(f.rows().length,0);assert.equal((await f.bound.reconcile())._result._receipts,0);
});
test('lost acknowledgement is unknown, then restart reconciles the one complete receipt',async t=>{
 const f=await setup(t,'expanded-v1',4,{_fault:p=>{if(p==='after_commit')throw Error('synthetic lost acknowledgement');}}),u=batch(f.records);
 failure(await f.bound.commit(u));assert.equal(f.rows().length,4);await f.bound.close();delete f.options._fault;f.bound=await bindEntityHistoricalImport(f.options);
 const r=await f.bound.commit(u);assert.equal(r._ok,true);assert.equal(r._result._replayed,true);assert.equal((await f.bound.reconcile())._result._complete,true);
});
test('source mutations and uniqueness conflicts roll back all records and checkpoint',async t=>{
 const f=await setup(t);const duplicate=await makeSource(path.join(work,randomUUID()));
 duplicate.records[2]._record.value=duplicate.records[0]._record.value; // Different types are independently unique; same type collision below.
 const a=f.records[0],b=structuredClone(a);b._record._id=randomUUID();
 const m=f.options._manifest; m._entities[0]._records.push({_id:b._record._id,_sha256:hash(b._record)});
 const refs=[...f.records.map(r=>({_entity:r._entity,_id:r._record._id,_sha256:hash(r._record)})),{_entity:b._entity,_id:b._record._id,_sha256:hash(b._record)}].sort((a,b)=>canonical([a._entity,a._id])<canonical([b._entity,b._id])?-1:1);m._record_root=hash(refs);f.options._manifest_sha256=hash(m);
 await f.bound.close();f.options._destination=path.join(work,randomUUID());f.bound=await bindEntityHistoricalImport(f.options);
 failure(await f.bound.commit(batch([a,b])));assert.equal(f.rows().length,0);
});
test('full expected records and owner/lease fencing remain mandatory',async t=>{
 const f=await setup(t);assert.equal((await f.bound.commit(batch(f.records.slice(0,1))))._ok,true);
 const rest=batch(f.records.slice(1)),guard={_entity:f.records[0]._entity,_id:f.records[0]._record._id,_expect:structuredClone(f.records[0]._record)};
 rest._records.push(guard);rest._records.at(-1)._expect.value='stale';failure(await f.bound.commit(rest));assert.equal(f.rows().length,1);
 rest._records.at(-1)._expect=f.records[0]._record;rest._lease={_entity:guard._entity,_id:guard._id,_owner_id:randomUUID(),_owner_epoch:1,_version:1};failure(await f.bound.commit(rest));assert.equal(f.rows().length,1);
 await assert.rejects(bindEntityHistoricalImport(f.options));await f.bound.close();failure(await f.bound.commit(batch(f.records)));
});
test('import and checkpoint cannot exceed fixed standard/expanded count or byte limits',async t=>{
 const standard=await setup(t,'standard-v1');failure(await standard.bound.commit(batch(standard.records)));assert.equal((await standard.bound.commit(batch(standard.records.slice(0,3))))._ok,true);
 const expanded=await setup(t,'expanded-v1',9);failure(await expanded.bound.commit(batch(expanded.records.slice(0,5))));failure(await expanded.bound.commit(batch(expanded.records)));
 const bytes=batch(expanded.records.slice(0,1));bytes._records[0]._create.value='x'.repeat(65537);failure(await expanded.bound.commit(bytes));assert.equal(expanded.rows().length,0);
});
test('receipt and imported rows reject mutation, and incomplete/corrupt reconciliation never grants readiness',async t=>{
 const f=await setup(t);assert.equal((await f.bound.commit(batch(f.records)))._ok,true);const db=f.open();
 try{assert.throws(()=>db.exec("UPDATE entity_historical_import_receipts SET _json='{}'"));assert.throws(()=>db.exec('DELETE FROM entity_historical_import_receipts'));
  const table=db.prepare("SELECT table_name FROM entity_provider_meta WHERE logical_entity_id='user'").get().table_name;
  assert.throws(()=>db.exec('UPDATE "'+table+'" SET _json=\'{}\''));assert.throws(()=>db.exec('DELETE FROM "'+table+'"'));
  db.exec('DROP TRIGGER import_receipt_delete');failure(await f.bound.reconcile());
 }finally{db.close();}
});
test('no imported credential, plaintext or raw record appears in import acknowledgements/errors/logs',async t=>{
 const f=await setup(t),output=[];for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>output.push(JSON.stringify(args)));
 output.push(JSON.stringify(await f.bound.commit(batch(f.records))));output.push(JSON.stringify(await f.bound.reconcile()));
 const bad=batch(f.records);bad._records[1]._create.password=f.password;output.push(JSON.stringify(await f.bound.commit(bad)));
 for(const forbidden of [f.password,f.records[1]._record.password])assert.equal(output.join('\n').includes(forbidden),false);
 for(const name of readdirSync(f.options._destination)){if(!name.includes('sqlite'))continue;const bytes=readFileSync(path.join(f.options._destination,name));assert.equal(bytes.includes(Buffer.from(f.password)),false);}
});

test('overlapping regrouped creates hit native expected-null CAS and cannot import the remaining record',async t=>{
 const f=await setup(t);assert.equal((await f.bound.commit(batch(f.records.slice(0,1))))._ok,true);
 failure(await f.bound.commit(batch(f.records.slice(0,2))));assert.equal(f.rows().length,1);assert.equal((await f.bound.reconcile())._result._receipts,1);
});
test('replaced ownership inode fences the existing capability and prevents restart adoption',async t=>{
 const f=await setup(t),file=path.join(f.options._destination,'owner.sqlite');renameSync(file,file+'.old');
 const replacement=new Database(file);replacement.close();
 failure(await f.bound.commit(batch(f.records)));assert.equal(f.rows().length,0);await f.bound.close();await assert.rejects(bindEntityHistoricalImport(f.options));
});
test('complete maintenance receipt bytes count against the original byte limit',async t=>{
 const f=await setup(t,'expanded-v1',1);await f.bound.close();
 const record=f.records[0]._record;record.value='';record.value='x'.repeat(65080-Buffer.byteLength(JSON.stringify(batch(f.records))));
 const refs=[{_entity:f.records[0]._entity,_id:record._id,_sha256:hash(record)}];f.options._manifest._record_root=hash(refs);f.options._manifest._entities[0]._records=[{_id:record._id,_sha256:hash(record)}];f.options._manifest_sha256=hash(f.options._manifest);f.options._destination=path.join(work,randomUUID());
 f.bound=await bindEntityHistoricalImport(f.options);assert.ok(Buffer.byteLength(JSON.stringify(batch(f.records)))<65536);failure(await f.bound.commit(batch(f.records)));assert.equal(f.rows().length,0);
});
test('historical native writer refuses degraded FULL and leaves no records or receipt',async t=>{
 const f=await setup(t),original=Database.prototype.pragma;
 Database.prototype.pragma=function(sql,...args){return original.call(this,sql==='synchronous = FULL'?'synchronous = NORMAL':sql,...args);};
 try{failure(await f.bound.commit(batch(f.records)));}finally{Database.prototype.pragma=original;}
 assert.equal(f.rows().length,0);assert.equal((await f.bound.reconcile())._result._receipts,0);
});

test('durable initialization stores bounded source identities and roots, never the full manifest inventory',async t=>{
 const f=await setup(t),db=f.open();try{const row=db.prepare('SELECT _json FROM entity_historical_import_meta WHERE _id=1').get();const meta=JSON.parse(row._json);assert.equal(meta._base._manifest_sha256,f.options._manifest_sha256);assert.equal(meta._base._source._record_root,f.options._manifest._record_root);assert.equal(row._json.includes('"_records"'),false);assert.ok(Buffer.byteLength(row._json)<65536);}finally{db.close();}
});

for(const option of ['_default','_enum'])test('Hash schema '+option+' cannot persist credential values in import metadata',async t=>{
 const f=await makeSource(path.join(work,randomUUID()));f.options._entities[1]._schema.password[option]=option==='_enum'?[f.password]:f.password;
 f.options._manifest._entities[1]._schema_sha256=hash(f.options._entities[1]);f.options._manifest_sha256=hash(f.options._manifest);
 await assert.rejects(bindEntityHistoricalImport(f.options));assert.equal(existsSync(f.options._destination),false);
});
