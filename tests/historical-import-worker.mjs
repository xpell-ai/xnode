import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import {_x,bindEntityHistoricalImport} from '../dist/index.js';
import {XEntityManager} from '../dist/XEntityManager/XEntityManager.js';
import {batch,hash} from './historical-import-fixture.mjs';
await _x.loadModuleAsync(new XEntityManager());
process.once('message',async input=>{
 let bound;
 const finish=async result=>{if(bound)await bound.close();process.send(result,()=>process.disconnect());};
 try{
  bound=await bindEntityHistoricalImport({...input.options,_clock:()=>Date.parse('2023-01-01T00:00:00.000Z'),_fault:point=>{
   if(point===input.point){writeSync(1,'IMPORT_CHECKPOINT '+point+'\n');process.kill(process.pid,'SIGKILL');}
   if(input.mode==='lost'&&point==='after_commit')throw Error('synthetic lost acknowledgement');
  }});
  process.send({ready:true});
  process.once('message',async()=>{
   try{
    if(input.mode==='read'){
     const before=await bound.reconcile();assert.equal(before._ok,true);
     const retry=await bound.commit(batch(input.records));assert.equal(retry._ok,true);
     const after=await bound.reconcile();assert.equal(after._ok,true);assert.equal(after._result._complete,true);
     const db=new Database(path.join(input.options._destination,'database.sqlite'),{readonly:true,fileMustExist:true});
     try{for(const r of input.records){
      const table=db.prepare('SELECT table_name FROM entity_provider_meta WHERE logical_entity_id=?').get(r._entity).table_name;
      const row=JSON.parse(db.prepare('SELECT _json FROM "'+table+'" WHERE _id=?').get(r._record._id)._json);
      assert.equal(hash(row),hash(r._record),'preserved record fingerprint');
      if(row.password)assert.equal(await bcrypt.compare(input.password,row.password),true);
     }}finally{db.close();}
     return finish({before:before._result,after:after._result,replayed:retry._result._replayed,verified:true});
    }
    return finish({result:await bound.commit(batch(input.records))});
   }catch{await finish({error:'worker_validation_failed'});process.exitCode=1;}
  });
 }catch{await finish({error:'unavailable'});}
});
