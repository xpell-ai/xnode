import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { SQLiteEntityProvider } from '../dist/XEntityManager/SQLiteEntityProvider.js';
import { resolve_entity_scope_identity } from '../dist/XEntityManager/EntityScope.js';
const schema = { _id: 'durable', _storage: { _provider: 'sqlite', _scope: 'app' },
  _schema: { value: { _type: 'String', _required: true, _index: { _unique: true } } } };
async function setup(t, full = true, definition = schema) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sqlite-'));
  const provider = new SQLiteEntityProvider({ _definition: definition,
    _physical_identity: resolve_entity_scope_identity({ _app_id: 'synthetic', _env: 'default', _entity_id: 'durable', _provider: 'sqlite' }),
    _runtime_context: { _work_folder: work, _sqlite_require_full_durability: full } });
  t.after(async () => { await provider.dispose(); fs.rmSync(work, { recursive: true, force: true }); });
  await provider.init(); return { work, provider, file: path.join(work, 'xdb/entity-provider.sqlite') };
}
test('host FULL is verified and schema/command-style settings cannot downgrade it; unrelated default stays NORMAL', async t => {
  const { provider } = await setup(t, true, { ...schema, _storage: { ...schema._storage, _sqlite: { synchronous: 'NORMAL' } } });
  assert.deepEqual(provider.getDebugStats()._sqlite_pragmas, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1, _busy_timeout: 5000 });
  const normal = await setup(t, false);
  assert.equal(normal.provider.getDebugStats()._sqlite_pragmas._synchronous, 1);
});
test('required FULL fails closed when a driver cannot apply it', async t => {
  const original = Database.prototype.pragma;
  Database.prototype.pragma = function(sql, ...args) { return original.call(this, sql === 'synchronous = FULL' ? 'synchronous = NORMAL' : sql, ...args); };
  try { await assert.rejects(setup(t), e => e._code === 'E_ENTITY_SQLITE_DURABILITY'); }
  finally { Database.prototype.pragma = original; }
});
test('ordinary multi-record update rolls back every row on a unique constraint failure', async t => {
  const { provider } = await setup(t);
  const a = await provider.add({ value: 'a' }), b = await provider.add({ value: 'b' });
  await assert.rejects(provider.update({ value: { _in: ['a', 'b'] } }, { value: 'collision' }));
  assert.equal((await provider.get(a._id)).value, 'a');
  assert.equal((await provider.get(b._id)).value, 'b');
});
test('competing process writer times out without a partial write and subsequent write succeeds', async t => {
  const { provider, file } = await setup(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import Database from 'better-sqlite3'; const db=new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(()=>{db.exec('ROLLBACK');db.close()},15000);`, file], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  await assert.rejects(provider.add({ value: 'blocked' }), e => String(e.code).startsWith('SQLITE_BUSY'));
  child.kill('SIGKILL'); await once(child, 'exit');
  assert.equal((await provider.find({ value: 'blocked' }))._data.length, 0);
  assert.equal((await provider.add({ value: 'after' })).value, 'after');
});
test('acknowledged FULL write survives SIGKILL and reopen with identical ID', async t => {
  const { provider, file } = await setup(t);
  await provider.dispose();
  const moduleUrl = new URL('../dist/XEntityManager/SQLiteEntityProvider.js', import.meta.url).href;
  const scopeUrl = new URL('../dist/XEntityManager/EntityScope.js', import.meta.url).href;
  const work = path.dirname(path.dirname(file));
  const code = `import {SQLiteEntityProvider as P} from ${JSON.stringify(moduleUrl)}; import {resolve_entity_scope_identity as S} from ${JSON.stringify(scopeUrl)};
    const p=new P({_definition:${JSON.stringify(schema)},_physical_identity:S({_app_id:'synthetic',_env:'default',_entity_id:'durable',_provider:'sqlite'}),_runtime_context:{_work_folder:${JSON.stringify(work)},_sqlite_require_full_durability:true}});
    await p.init(); const r=await p.add({value:'survived'});process.stdout.write(JSON.stringify(r)+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let record;
  for await (const line of readline.createInterface({ input: child.stdout })) {
    if (line.startsWith('{')) { record = JSON.parse(line); break; }
  }
  assert.ok(record);
  child.kill('SIGKILL'); await once(child, 'exit');
  await provider.init(); assert.equal((await provider.get(record._id)).value, 'survived');
});

// Real processes and native transactions; no live configuration or provider calls.
const capacityActor = `
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeSync } from 'node:fs';
import { _x, bindEntityLocalUnit } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
import { XEntityManager } from ${JSON.stringify(new URL('../dist/XEntityManager/XEntityManager.js', import.meta.url).href)};
const input = JSON.parse(process.argv[1]);
const manager = new XEntityManager({ _provider_runtime_context: { _work_folder: input.work, _sqlite_require_full_durability: true } });
await _x.loadModuleAsync(manager);
const scope = { _env: 'default', _app_id: 'synthetic-expanded-crash' };
const command = (op, params) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
const names = [...Array.from({length:7},(_,i)=>'effect'+i), 'receipt'];
for (const name of names) assert.equal((await command('register', { _entity: { _id: name,
  _storage: { _provider: 'sqlite', _scope: 'app', ...(name === 'receipt' ? { _append_only: true } : {}) },
  _schema: { _value: { _type: 'String', _required: true, _index: { _unique: true } }, ...(input.hash && name==='effect1' ? {password:{_type:'Hash',_required:true}} : {}) } } }))._ok, true);
for (const e of manager._entities.values()) assert.deepEqual(e._provider.getDebugStats()._sqlite_pragmas,
  { _journal_mode:'wal', _synchronous:2, _foreign_keys:1, _busy_timeout:5000 });
const bound = await bindEntityLocalUnit({ ...scope, _capacity_profile:'expanded-v1', ...(input.hash?{_hash_policy:'create-and-preserve-v1'}:{}),
  _entities:names.map(_entity=>({_entity,_write:true})), _clock:()=>1000,
  _fault:point=>{ if(point===input.point) { writeSync(1,'CAPACITY_CHECKPOINT '+point+String.fromCharCode(10)); process.kill(process.pid,'SIGKILL'); }
    if(input.mode==='unknown' && point==='after_commit') throw Error('lost acknowledgement'); } });
if(input.hash) assert.deepEqual(bound._hash,{_version:1,_policy:'create-and-preserve-v1',_create:'provider-bcrypt-10',_update:'preserve-existing-hash',_prehashed_create:'reject'});
assert.deepEqual(bound._capacity,{_version:2,_profile:'expanded-v1',_limits:{_records:10,_writes:5,_entities:8,_bytes:65536}});
const finish = async result => {
  for (const name of names) await command('unregister',{_entity:name});
  process.send(result,()=>process.disconnect());
};
const execute = async () => {
  if(input.mode==='prepare') return finish({prepared:true});
  if(input.mode==='read') {
    const rows=[];
    for(const op of input.unit._records) rows.push((await command('get',{_entity:op._entity,_id:op._id}))._result._record);
    const counts=[];
    for(const e of manager._entities.values()) counts.push(e._provider._db.prepare('SELECT count(*) AS n FROM "'+e._provider._table_name+'"').get().n);
    const db=[...manager._entities.values()][0]._provider._db;
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    const replay=await bound.commit(input.unit);
    let immutable;
    if(rows[4]) immutable=await bound.commit({_unit_id:input.unit._unit_id,_records:[{_entity:'receipt',_id:rows[4]._id,_expect:rows[4],_update:{_value:'tampered'}}]});
    return finish({rows,counts,replay,immutable});
  }
  const result=await bound.commit(input.unit);
  if(input.hash && result._ok)assert.deepEqual(result._result._hash,bound._hash);
  return finish({result});
};
process.send({ready:true});
process.once('message',()=>{execute().catch(e=>{console.error(e);process.exitCode=1;process.disconnect()});});
`;

function crashUnit(hash = false) {
  return { _unit_id: randomUUID(), _records: [
    ...['effect0', 'effect1', 'effect2', 'effect3', 'receipt'].map(_entity => {
      const _id = randomUUID(); return { _entity, _id, _expect: null, _create: { _id, _value: 'synthetic-' + _id, ...(hash && _entity==='effect1'?{password:'synthetic:'+randomUUID()}: {}) } };
    }), ...['effect4', 'effect5', 'effect6', 'effect0', 'effect1'].map(_entity => ({ _entity, _id: randomUUID(), _expect: null })) ] };
}
async function actor(t, input) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', capacityActor, JSON.stringify(input)],
    { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; });
  // Attach listeners before dispatch: a synchronous native fault may kill immediately.
  const messages = [], waiters = [];
  child.on('message', message => { const next = waiters.shift(); if (next) next.resolve(message); else messages.push(message); });
  child.on('exit', (code, signal) => { for (const next of waiters.splice(0)) next.reject(Error('actor exited ' + code + '/' + signal + ': ' + stderr)); });
  const exit = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
  const message = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => waiters.push({resolve,reject}));
  assert.deepEqual(await message(), { ready: true }, stderr);
  return { start: () => child.send({ start: true }), message,
    done: async () => { const result = await exit; clearTimeout(timer); return result; }, stderr: () => stderr, stdout: () => stdout };
}
async function runActor(t, input) {
  const a = await actor(t, input); a.start(); const result = await a.message();
  assert.deepEqual(await a.done(), [0, null], a.stderr()); return result;
}
function assertReconciled(result, unit, committed) {
  assert.equal(result.rows.filter(Boolean).length, committed ? 5 : 0);
  assert.equal(result.counts.reduce((a, b) => a + b, 0), committed ? 5 : 0);
  for (const [i, op] of unit._records.entries()) {
    if (!committed || i >= 5) assert.equal(result.rows[i], null);
    else {
      const expected={...op._create};
      if(expected.password){assert.equal(bcrypt.compareSync(expected.password,result.rows[i].password),true);assert.equal(bcrypt.getRounds(result.rows[i].password),10);expected.password=result.rows[i].password;}
      assert.deepEqual(result.rows[i], { ...expected, _created_at: new Date(1000).toISOString(), _updated_at: new Date(1000).toISOString() });
    }
  }
  // A committed receipt forbids replay and modification. An aborted unit can retry atomically.
  assert.equal(result.replay._ok, !committed);
  if (committed) assert.equal(result.immutable._ok, false);
}
for (const hash of [false,true]) for (const point of ['after_write_1', 'after_write_2', 'after_write_3', 'after_write_4', 'after_write_5', 'before_commit', 'after_commit']) {
  test(`expanded ${hash ? "Hash" : "plain"} SIGKILL ${point} reconciles all five effects and immutable receipt after restart`, { timeout: 25000 }, async t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'expanded-kill-')), unit = crashUnit(hash);
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const a = await actor(t, { work, unit, mode: 'commit', point, hash }); a.start();
    assert.deepEqual(await a.done(), [null, 'SIGKILL'], a.stderr());
    assert.ok(a.stdout().includes('CAPACITY_CHECKPOINT ' + point + '\n'), a.stdout());
    const result = await runActor(t, { work, unit, mode: 'read', hash });
    assertReconciled(result, unit, point === 'after_commit');
    const again = await runActor(t, { work, unit, mode: 'read', hash });
    assertReconciled(again, unit, true); // retry or original commit survives another reopen exactly once
  });
}
for (const hash of [false,true]) test('expanded '+(hash?'Hash ':'')+'unknown commit acknowledgement reconciles after process exit without duplicate effects', { timeout: 25000 }, async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'expanded-unknown-')), unit = crashUnit(hash);
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const response = await runActor(t, { work, unit, mode: 'unknown', hash });
  assert.equal(response.result._ok, false); // this is an unknown outcome, never a successful recovery
  assertReconciled(await runActor(t, { work, unit, mode: 'read', hash }), unit, true);
});
test('expanded competing processes serialize CAS: one five-write commit, no duplicate receipt', { timeout: 25000 }, async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'expanded-race-')), unit = crashUnit();
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  await runActor(t, { work, mode: 'prepare' });
  const first = await actor(t, { work, unit, mode: 'commit' }), second = await actor(t, { work, unit, mode: 'commit' });
  first.start(); second.start();
  const results = await Promise.all([first.message(), second.message()]);
  assert.deepEqual(await first.done(), [0, null], first.stderr()); assert.deepEqual(await second.done(), [0, null], second.stderr());
  assert.equal(results.filter(r => r.result._ok).length, 1);
  const committed = results.find(r => r.result._ok).result._result;
  assert.deepEqual(committed._capacity, { _version: 2, _profile: 'expanded-v1', _limits: { _records: 10, _writes: 5, _entities: 8, _bytes: 65536 } });
  assert.deepEqual(committed._durability, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1 });
  assertReconciled(await runActor(t, { work, unit, mode: 'read' }), unit, true);
});
