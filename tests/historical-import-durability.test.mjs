import assert from 'node:assert/strict';
import test from 'node:test';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeSource} from './historical-import-fixture.mjs';
async function actor(t,input){
 const child=fork(fileURLToPath(new URL('./historical-import-worker.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_ENV:'test'}});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const queue=[],waiters=[];child.on('message',m=>{const w=waiters.shift();if(w)w.resolve(m);else queue.push(m);});
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(Error('worker exit '+code+'/'+signal));});
 const exit=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),25000);t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});
 child.send(input);
 return {child,message:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject})),start:()=>child.send({start:true}),stdout:()=>stdout,
 done:async()=>{const r=await exit;clearTimeout(timer);return r;}};
}
async function read(t,input){const a=await actor(t,{...input,mode:'read'});assert.deepEqual(await a.message(),{ready:true});a.start();const r=await a.message();assert.deepEqual(await a.done(),[0,null]);assert.equal(r.verified,true);return r;}
function root(t){const p=mkdtempSync(path.join(tmpdir(),'historical-import-kill-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return path.join(p,'destination');}
for(const point of ['after_write_1','after_write_2','after_write_3','after_write_4','after_write_5','before_commit','after_commit'])test(`historical SIGKILL ${point}: exact source records and one receipt reconcile on restart`,{timeout:35000},async t=>{
 const input=await makeSource(root(t)),a=await actor(t,{...input,mode:'commit',point});assert.deepEqual(await a.message(),{ready:true});a.start();assert.deepEqual(await a.done(),[null,'SIGKILL']);assert.ok(a.stdout().includes('IMPORT_CHECKPOINT '+point+'\n'));
 const first=await read(t,input);assert.equal(first.before._records,point==='after_commit'?4:0);assert.equal(first.before._receipts,point==='after_commit'?1:0);assert.equal(first.after._records,4);assert.equal(first.after._receipts,1);assert.equal(first.after._financial_ready,false);
 const second=await read(t,input);assert.equal(second.before._complete,true);assert.equal(second.replayed,true);assert.deepEqual(second.before,first.after);
});
test('historical lost commit acknowledgement is reconciled across a process restart',{timeout:35000},async t=>{
 const input=await makeSource(root(t)),a=await actor(t,{...input,mode:'lost'});assert.deepEqual(await a.message(),{ready:true});a.start();const r=await a.message();assert.equal(r.result._ok,false);assert.deepEqual(await a.done(),[0,null]);
 const state=await read(t,input);assert.equal(state.before._complete,true);assert.equal(state.before._records,4);assert.equal(state.before._receipts,1);assert.equal(state.replayed,true);
});
test('paused importer retains exclusive ownership and SIGKILL releases it without timed takeover',{timeout:35000},async t=>{
 const input=await makeSource(root(t)),owner=await actor(t,{...input,mode:'commit'});assert.deepEqual(await owner.message(),{ready:true});owner.child.kill('SIGSTOP');
 try{const competitor=await actor(t,{...input,mode:'commit'});assert.deepEqual(await competitor.message(),{error:'unavailable'});assert.deepEqual(await competitor.done(),[0,null]);}
 finally{owner.child.kill('SIGCONT');owner.child.kill('SIGKILL');}
 assert.deepEqual(await owner.done(),[null,'SIGKILL']);const state=await read(t,input);assert.equal(state.before._records,0);assert.equal(state.after._records,4);
});
