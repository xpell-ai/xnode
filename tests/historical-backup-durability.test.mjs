import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import fs from 'node:fs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {_x,bindEntityHistoricalImport,backupEntityHistoricalImport,restoreEntityHistoricalImport,resumeEntityHistoricalImportRestore} from '../dist/index.js';
import {XEntityManager} from '../dist/XEntityManager/XEntityManager.js';
import {backupSource} from './historical-backup-fixture.mjs';
const root=fs.mkdtempSync(path.join(tmpdir(),'historical-backup-kill-'));fs.chmodSync(root,0o700);
await _x.loadModuleAsync(new XEntityManager({_work_folder:path.join(root,'ordinary')}));after(()=>fs.rmSync(root,{recursive:true,force:true}));
async function fixture(t,complete=true){const dir=path.join(root,randomUUID());fs.mkdirSync(dir,{mode:0o700});const f=await backupSource(dir);
 if(complete){const owner=await bindEntityHistoricalImport(f.options);for(const u of f.units)assert.equal((await owner.commit(u))._ok,true);await backupEntityHistoricalImport(f.backupOptions(owner));await owner.close();}
 const { _clock,...importOptions }=f.options;const { _clock:c,...restoreOptions }=f.restoreOptions();
 const backupOptions=f.backupOptions(null);delete backupOptions._owner;delete backupOptions._key;delete restoreOptions._key;
 f.input={key:f.key,importOptions,restoreOptions,backupOptions,units:f.units,ordinary:path.join(dir,'ordinary')};return f;
}
function actor(t,input){const child=fork(fileURLToPath(new URL('./historical-backup-worker.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_ENV:'test'}});
 const pending=[],queue=[];let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',()=>{});
 child.on('message',m=>{const w=pending.shift();if(w)w.resolve(m);else queue.push(m);});child.on('exit',()=>{for(const w of pending.splice(0))w.reject(Error('worker exited'));});
 const exit=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),25000);t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});child.send(input);
 return {child,start:()=>child.send({start:true}),output:()=>output,message:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>pending.push({resolve,reject})),done:async()=>{const r=await exit;clearTimeout(timer);return r;}};
}
for(const point of ['backup_before_native','backup_progress','backup_after_native','backup_before_encrypted_write','backup_before_publish','backup_after_reserve','backup_after_publish'])test(`SIGKILL ${point}: authenticated completion or isolated retry`,{timeout:35000},async t=>{
 const f=await fixture(t,false),a=actor(t,{...f.input,mode:'backup',point});assert.deepEqual(await a.message(),{ready:true});a.start();assert.deepEqual(await a.done(),[null,'SIGKILL']);assert.ok(a.output().includes('BACKUP_CHECKPOINT '+point+'\n'));
 const source=await bindEntityHistoricalImport(f.options);assert.equal((await source.reconcile())._result._complete,true);
 if(point!=='backup_after_publish'){
  await assert.rejects(restoreEntityHistoricalImport(f.restoreOptions()));
  f.backup+='-retry';await backupEntityHistoricalImport(f.backupOptions(source));
 }
 const restored=await restoreEntityHistoricalImport(f.restoreOptions());assert.equal((await restored.reconcile())._ok,true);assert.equal(restored._restore._records,13);assert.equal(restored._restore._receipts,4);await restored.close();await source.close();
});
for(const point of ['restore_after_authentication','restore_before_image_write','restore_after_image_write','restore_before_rebind_commit','restore_after_rebind_commit','restore_before_acknowledgement'])test(`SIGKILL ${point}: new ownership survives only committed rebind`,{timeout:35000},async t=>{
 const f=await fixture(t),a=actor(t,{...f.input,mode:'restore',point});assert.deepEqual(await a.done(),[null,'SIGKILL']);assert.ok(a.output().includes('BACKUP_CHECKPOINT '+point+'\n'));
 const committed=['restore_after_rebind_commit','restore_before_acknowledgement'].includes(point);
 let recovered;
 if(committed)recovered=await resumeEntityHistoricalImportRestore(f.restoreOptions());
 else {await assert.rejects(resumeEntityHistoricalImportRestore(f.restoreOptions()));
  if(fs.existsSync(f.restored))assert.equal((await _x.execute({_module:'entity-manager',_op:'register',_params:{_env:'default',_app_id:'synthetic-historical',_entity:{...f.options._entities[0],_storage:{_provider:'sqlite',_scope:'app',_db_path:path.join(f.restored,'database.sqlite')}}}}))._ok,false);
  recovered=await restoreEntityHistoricalImport({...f.restoreOptions(),_destination:f.restored+'-retry',_restore_id:randomUUID()});
 }
 assert.equal((await recovered.reconcile())._ok,true);assert.equal(recovered._restore._records,13);assert.equal(recovered._restore._receipts,4);assert.equal(recovered._restore._financial_ready,false);await recovered.close();
});
test('paused restored owner rejects a concurrent process; SIGKILL permits authenticated resume without stale takeover',{timeout:35000},async t=>{
 const f=await fixture(t),first=await restoreEntityHistoricalImport(f.restoreOptions());await first.close();
 const a=actor(t,{...f.input,mode:'hold'});assert.deepEqual(await a.message(),{ready:true});a.child.kill('SIGSTOP');
 try{const second=actor(t,{...f.input,mode:'resume'});assert.deepEqual(await second.message(),{unavailable:true});assert.deepEqual(await second.done(),[0,null]);}
 finally{a.child.kill('SIGCONT');a.child.kill('SIGKILL');}assert.deepEqual(await a.done(),[null,'SIGKILL']);
 const final=actor(t,{...f.input,mode:'resume'});assert.deepEqual(await final.message(),{verified:true,records:13,receipts:4,financial_ready:false});assert.deepEqual(await final.done(),[0,null]);
});
