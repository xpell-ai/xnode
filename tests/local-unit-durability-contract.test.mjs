import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _x, bindEntityLocalUnit, ENTITY_LOCAL_UNIT_DURABILITY_CAPABILITIES } from '../dist/index.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';

const work = mkdtempSync(path.join(os.tmpdir(), 'issue-74-sqlite-contract-'));
const manager = new XEntityManager({ _work_folder: work }); await _x.loadModuleAsync(manager);
after(() => rmSync(work, { recursive: true, force: true }));
async function setup(t) {
  const scope = { _app_id: 'contract-' + randomUUID(), _env: 'test' };
  const command = (op, params) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
  for (const name of ['effects', 'receipts']) assert.equal((await command('register', { _entity: { _id: name,
    _storage: { _provider: 'sqlite', _scope: 'app', ...(name === 'receipts' ? { _append_only: true } : {}) },
    _schema: { key: { _type: 'String', _required: true, _index: { _unique: true } }, note: { _type: 'String' } } } }))._ok, true);
  t.after(async () => { for (const name of ['effects', 'receipts']) await command('unregister', { _entity: name }); });
  const control = { now: 1000, hook: undefined, fault: undefined };
  const options = { ...scope, _entities: ['effects', 'receipts'].map(_entity => ({ _entity, _write: true })),
    _clock: () => control.now, _fault: p => { control.hook?.(p); if (p === control.fault) throw new Error('synthetic'); } };
  const legacy = await bindEntityLocalUnit(options), neutral = await bindEntityLocalUnit({ ...options, _durability_contract: 'provider-neutral-v1' });
  const create = (entity = 'effects') => { const id = randomUUID(); return { _entity: entity, _id: id, _expect: null, _create: { _id: id, key: id } }; };
  const read = async (entity, id) => (await command('get', { _entity: entity, _id: id }))._result._record;
  return { command, options, legacy, neutral, control, create, read };
}
const unit = (...records) => ({ _unit_id: randomUUID(), _records: records });

test('SQLite legacy result keys stay exact while explicit neutral binding adds the closed receipt', async t => {
  const f = await setup(t); const old = await f.legacy.commit(unit(f.create()));
  assert.equal(old._ok, true); assert.deepEqual(Object.keys(old._result).sort(), ['_durability', '_records']);
  assert.deepEqual(old._result._durability, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1 });
  assert.equal(f.legacy._durability_contract, undefined);
  const u = unit(f.create(), f.create('receipts')), r = await f.neutral.commit(u); assert.equal(r._ok, true);
  assert.deepEqual(r._result._durability, old._result._durability);
  assert.deepEqual(r._result._durability_attestation, { ...f.neutral._durability_contract, _unit_id: u._unit_id, _commit: 'confirmed' });
  assert.equal(r._result._durability_attestation._store_identity._kind, 'sqlite-binding-v1');
  assert.equal(r._result._durability_attestation._store_identity._lifetime, 'bound-handle');
  assert.equal(JSON.stringify(r._result._durability_attestation).includes(work), false);
  assert.deepEqual(ENTITY_LOCAL_UNIT_DURABILITY_CAPABILITIES._contracts, ['provider-neutral-v1']);
});

test('SQLite refuses unknown contracts, copied ownership and contract fields inside unit JSON', async t => {
  const f = await setup(t);
  for (const extra of [{ _durability_contract: 'wrong' }, { _owner_context: {} }]) await assert.rejects(bindEntityLocalUnit({ ...f.options, ...extra }));
  for (const extra of [{ _durability_contract: 'provider-neutral-v1' }, { _owner_context: {} }]) assert.equal((await f.neutral.commit({ ...unit(f.create()), ...extra }))._ok, false);
});

test('strict final result bounds apply only to explicitly opted-in SQLite units', async t => {
  const f = await setup(t), id = randomUUID();
  assert.equal((await f.command('add', { _entity: 'effects', _data: { _id: id, key: id, note: 'x'.repeat(70000) } }))._ok, true);
  const guard = { _entity: 'effects', _id: id }, legacyReceipt = f.create('receipts'), strictReceipt = f.create('receipts');
  assert.equal((await f.legacy.commit(unit(guard, legacyReceipt)))._ok, true);
  assert.equal((await f.neutral.commit(unit(guard, strictReceipt)))._ok, false);
  assert.equal(await f.read('receipts', strictReceipt._id), null); assert.ok(await f.read('receipts', legacyReceipt._id));
});

test('opt-in SQLite rechecks expiry immediately before COMMIT and preserves legacy timing', async t => {
  const f = await setup(t); f.control.hook = p => { if (p === 'before_commit') f.control.now = 2000; };
  const strict = f.create(); const r = await f.neutral.commit({ ...unit(strict), _valid_until: 2000 });
  assert.equal(r._result._code, 'E_ENTITY_LOCAL_UNIT_EXPIRED'); assert.equal(await f.read('effects', strict._id), null);
  f.control.now = 1000; const old = f.create(); assert.equal((await f.legacy.commit({ ...unit(old), _valid_until: 2000 }))._ok, true);
});

test('new SQLite postcommit acknowledgement loss is uncertain while records remain committed', async t => {
  const f = await setup(t), op = f.create(); f.control.fault = 'after_commit';
  const r = await f.neutral.commit(unit(op)); assert.equal(r._result._code, 'E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN');
  assert.equal((await f.read('effects', op._id)).key, op._id);
});
