import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import { _x, _xem } from '../dist/index.js';
import { localUnitCanonical } from '../dist/XEntityManager/EntityLocalUnit.js';
import { unitFixture, unitDefinition, unit, errorCode } from './postgresql-local-unit-fixture.mjs';

test('native PG binding and two-entity unit use one SERIALIZABLE client with an exact qualified receipt', async t => {
  const f = await unitFixture(t), a = f.create('effects'), b = f.create('receipts');
  const descriptor = f.bound._durability_contract;
  assert.equal(descriptor._store_identity._id, f.connection._expected_store_id);
  assert.equal(descriptor._scope._app_id, 'pg73'); assert.equal(descriptor._backend, 'postgresql');
  assert.equal(descriptor._ownership._mode, 'unfenced'); assert.equal(descriptor._capacity._profile, 'standard-v1');
  assert.ok(Object.isFrozen(descriptor) && Object.isFrozen(descriptor._scope));
  const original = Client.prototype.query, seen = [];
  Client.prototype.query = function(q, ...args) { if (this.user === f.role) seen.push({ pid: this.processID, sql: typeof q === 'string' ? q : q.text }); return original.call(this, q, ...args); };
  let result; const u = unit(a, b);
  try { result = await f.bound.commit(u); } finally { Client.prototype.query = original; }
  assert.equal(result._ok, true, JSON.stringify(result));
  assert.deepEqual(result._result._durability_attestation, { ...descriptor, _unit_id: u._unit_id, _commit: 'confirmed' });
  assert.deepEqual(result._result._durability, { _backend: 'postgresql', _profile: 'postgresql-local-durable-v1' });
  assert.equal(seen.filter(q => q.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 1);
  assert.equal(seen.filter(q => q.sql === 'COMMIT').length, 1); assert.equal(new Set(seen.map(q => q.pid)).size, 1);
  assert.equal((await f.read('effects', a._id))._created_at, '1970-01-01T00:00:01.000Z');
  assert.equal((await f.read('receipts', b._id)).amount, 1);
  assert.equal(f.bound._capacity, undefined); assert.equal(result._result._capacity, undefined);
});

for (const point of ['after_prepare', 'after_guards', 'after_write_1', 'after_write_2', 'before_commit']) {
  test(`real PG bounded unit has no partial effects on ${point}`, async t => {
    const f = await unitFixture(t), a = f.create('effects'), b = f.create('receipts'); f.control.fault = point;
    let hit = false; f.control.hook = p => { if (p === point) hit = true; };
    assert.equal((await f.bound.commit(unit(a, b)))._ok, false);
    assert.equal(hit, true, 'must reach the actual intended fault point');
    assert.equal(await f.read('effects', a._id), null); assert.equal(await f.read('receipts', b._id), null);
  });
}

test('full-record guards preserve null/absence and reject stale snapshots without digest shortcuts', async t => {
  const f = await unitFixture(t), a = f.create('effects', undefined, { note: null, payload: { nested: [1, null, 'x'] } });
  assert.equal((await f.bound.commit(unit(a)))._ok, true); const row = await f.read('effects', a._id);
  const missing = { ...row }; delete missing.note;
  for (const expect of [null, missing, { ...row, amount: 2 }, { ...row, _updated_at: 'wrong' }]) {
    const receipt = f.create('receipts');
    const r = await f.bound.commit(unit({ _entity: 'effects', _id: a._id, _expect: expect, ...(expect === null ? {} : { _update: { amount: 3 } }) }, receipt));
    assert.equal(errorCode(r), 'E_ENTITY_LOCAL_UNIT_CONFLICT'); assert.equal(await f.read('receipts', receipt._id), null);
  }
  assert.equal((await f.bound.commit(unit({ _entity: 'effects', _id: a._id, _expect: row, _update: { amount: 2 } })))._ok, true);
  assert.equal((await f.read('effects', a._id)).amount, 2);
});

test('native authority, allowlist and negotiated protocol reject forged/remote/unknown inputs', async t => {
  const f = await unitFixture(t), a = f.create('effects');
  for (const extra of [{ _durability_contract: undefined }, { _durability_contract: 'unknown' }, { _owner_context: {} }])
    await assert.rejects(f.manager.bindLocalUnit({ ...f.options, ...extra }));
  const reader = await f.manager.bindLocalUnit({ ...f.options, _entities: [{ _entity: 'effects', _write: false }] });
  assert.equal((await reader.commit(unit(a)))._ok, false);
  const key = [...f.manager._local_units.keys()][0];
  const invoke = (_params, extra = {}) => _x.execute({ _module: 'entity-manager', _op: 'commit-local-unit', ...extra, _params });
  for (const [params, extra] of [[{ _local_unit_key: randomUUID(), _unit: unit(a) }, {}],
    [{ _local_unit_key: key, _unit: unit(a) }, { _ctx: { _sid: 'synthetic' } }],
    [{ _local_unit_key: key, _unit: unit(a), sql: 'forbidden' }, {}]]) assert.equal((await invoke(params, extra))._ok, false);
  assert.equal((await f.bound.commit(unit({ ...a, _entity: 'unbound' })))._ok, false);
  assert.equal(await f.read('effects', a._id), null);
});

test('strict intent, immutable/append-only and required fields fail without partial writes', async t => {
  const f = await unitFixture(t), a = f.create('effects');
  for (const data of [{ amount: '1' }, { extra: 1 }, { amount: Infinity }, { _created_at: '1970-01-01T00:00:00.000Z' }, { key: null }]) {
    const r = await f.bound.commit(unit({ ...a, _create: { ...a._create, ...data } }, f.create('receipts'))); assert.equal(r._ok, false);
  }
  const receipt = f.create('receipts'); assert.equal((await f.bound.commit(unit(receipt)))._ok, true);
  const stored = await f.read('receipts', receipt._id);
  assert.equal((await f.bound.commit(unit({ _entity: 'receipts', _id: receipt._id, _expect: stored, _update: { amount: 4 } }, a)))._ok, false);
  assert.equal(await f.read('effects', a._id), null);
});

test('standard/expanded boundaries preserve five-write atomicity and exact capacity acknowledgement', async t => {
  const f = await unitFixture(t), writes = Array.from({ length: 5 }, () => f.create('effects'));
  assert.equal((await f.bound.commit(unit(...writes)))._ok, false);
  const expanded = await f.manager.bindLocalUnit({ ...f.options, _capacity_profile: 'expanded-v1' });
  const u = unit(...writes, ...Array.from({ length: 5 }, () => ({ _entity: 'receipts', _id: randomUUID(), _expect: null })));
  const r = await expanded.commit(u); assert.equal(r._ok, true, JSON.stringify(r));
  assert.deepEqual(r._result._capacity, expanded._capacity); assert.equal(r._result._records.length, 10);
  assert.equal((await expanded.commit(unit(...Array.from({ length: 6 }, () => f.create('effects')))))._ok, false);
});

for (let write = 1; write <= 5; write++) test(`expanded real PG rollback after write ${write} removes all five records`, async t => {
  const f = await unitFixture(t, { binding: { _capacity_profile: 'expanded-v1' } });
  const writes = Array.from({ length: 5 }, () => f.create('effects')); f.control.fault = 'after_write_' + write;
  const reached = []; f.control.hook = p => { if (p.startsWith('after_write_')) reached.push(p); };
  assert.equal((await f.bound.commit(unit(...writes)))._ok, false);
  assert.equal(reached.length, write); assert.equal(reached.at(-1), 'after_write_' + write);
  for (const op of writes) assert.equal(await f.read(op._entity, op._id), null);
});

test('final expiry and changed registration are checked after writes and before actual COMMIT', async t => {
  const f = await unitFixture(t), a = f.create('effects'), b = f.create('receipts');
  f.control.hook = p => { if (p === 'before_commit') f.control.now = 2000; };
  assert.equal(errorCode(await f.bound.commit({ ...unit(a, b), _valid_until: 2000 })), 'E_ENTITY_LOCAL_UNIT_EXPIRED');
  assert.equal(await f.read('effects', a._id), null);
  f.control.now = 1000; f.control.hook = p => { if (p === 'before_commit') {
    const entry = [...f.manager._entities.values()].find(e => e._definition._id === 'effects'); entry._definition._schema.note._max_length = 1;
  } };
  assert.equal(errorCode(await f.bound.commit(unit(a, b))), 'E_ENTITY_LOCAL_UNIT_SCHEMA');
  assert.equal(await f.read('effects', a._id), null); assert.equal(await f.read('receipts', b._id), null);
});

test('oversized final guard results abort pending writes before COMMIT', async t => {
  const f = await unitFixture(t), id = randomUUID(), receipt = f.create('receipts');
  const added = await f.command('add', { _entity: 'effects', _data: { _id: id, key: id, payload: { text: 'x'.repeat(70000) } } });
  assert.equal(added._ok, true);
  const r = await f.bound.commit(unit(receipt, { _entity: 'effects', _id: id }));
  assert.equal(r._ok, false); assert.equal(await f.read('receipts', receipt._id), null);
});

test('Hash is prepared before BEGIN, preserved on update, redacted on notification and never fast-digested', async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { password: { _type: 'Hash', _required: true } }), unitDefinition('receipts', true)],
    binding: { _hash_policy: 'create-and-preserve-v1' } });
  const a = f.create('effects', undefined, { password: 'synthetic-passphrase' }), seen = [];
  const listener = _xem.on('xdb:create', data => { if (data._app_id === 'pg73') seen.push(data); }); t.after(() => _xem.remove(listener));
  const r = await f.bound.commit(unit(a, f.create('receipts'))); assert.equal(r._ok, true, JSON.stringify(r));
  const row = await f.read('effects', a._id); assert.match(row.password, /^\$2[aby]\$10\$/); assert.equal(await bcrypt.compare(a._create.password, row.password), true);
  assert.equal((await f.bound.commit(unit({ _entity: 'effects', _id: a._id, _expect: row, _update: { amount: 2 } })))._ok, true);
  assert.equal((await f.read('effects', a._id)).password, row.password);
  assert.equal(JSON.stringify(seen).includes(row.password), false); assert.equal(JSON.stringify(r._result._durability_attestation).includes(a._create.password), false);
  for (const password of [null, '', 'x'.repeat(73), '$2b$10$' + 'x'.repeat(53), 'a'.repeat(64)]) {
    assert.equal((await f.bound.commit(unit(f.create('effects', undefined, { password }))))._ok, false);
  }
  assert.equal((await f.bound.commit(unit({ _entity: 'effects', _id: a._id, _expect: { ...row, amount: 2 }, _update: { password: 'another' } })))._ok, false);
});

test('post-Hash size expansion is rejected before any transaction effects', async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { password: { _type: 'Hash', _required: true } })], binding: { _hash_policy: 'create-and-preserve-v1' } });
  const op = f.create('effects', undefined, { password: 'short', note: '' }); const u = unit(op);
  op._create.note = 'x'.repeat(65530 - Buffer.byteLength(localUnitCanonical(u)));
  assert.ok(Buffer.byteLength(localUnitCanonical(u)) < 65536);
  assert.equal((await f.bound.commit(u))._ok, false); assert.equal(await f.read('effects', op._id), null);
});

test('lost response after COMMIT is uncertain, emits only committed events, and never retries', async t => {
  const f = await unitFixture(t), a = f.create('effects'); let events = 0;
  const listener = _xem.on('xdb:create', data => { if (data._app_id === 'pg73') events++; }); t.after(() => _xem.remove(listener));
  f.control.fault = 'before_commit'; assert.equal((await f.bound.commit(unit(a)))._ok, false); assert.equal(events, 0);
  f.control.fault = 'after_commit'; assert.equal(errorCode(await f.bound.commit(unit(a))), 'E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN');
  assert.equal(events, 1); assert.equal((await f.read('effects', a._id)).amount, 1);
  assert.equal((await f.bound.commit(unit(a)))._ok, false); assert.equal(events, 1);
});

test('GUID case remains exact and a corrupt postcommit receipt cannot imply rollback', async t => {
  const f = await unitFixture(t), lower = 'abcdefab-cdef-4abc-8def-abcdefabcdef', upper = lower.toUpperCase();
  assert.equal((await f.bound.commit(unit(f.create('effects', lower), f.create('effects', upper))))._ok, true);
  assert.equal((await f.read('effects', upper))._id, upper);
  const owned = [...f.manager._local_units.values()].at(-1), original = owned._backend, a = f.create('effects');
  owned._backend = { ...original, commit: async (...args) => ({ ...await original.commit(...args), _durability: {} }) };
  assert.equal(errorCode(await f.bound.commit(unit(a))), 'E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN');
  assert.equal((await f.read('effects', a._id)).amount, 1);
});

test('lease owner/epoch/version/state and final expiry are checked inside the real transaction', async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects'), unitDefinition('receipts', true), unitDefinition('leases', false, {
    _state: { _type: 'String' }, _owner_id: { _type: 'String' }, _owner_epoch: { _type: 'Number' },
    _version: { _type: 'Number' }, _lease_expires_at: { _type: 'Number' } })] });
  const owner = randomUUID(), id = randomUUID();
  assert.equal((await f.command('add', { _entity: 'leases', _data: { _id: id, key: id, _state: 'claimed', _owner_id: owner,
    _owner_epoch: 1, _version: 1, _lease_expires_at: 2000 } }))._ok, true);
  const row = await f.read('leases', id), guard = { _entity: 'leases', _id: id, _expect: row };
  const lease = { _entity: 'leases', _id: id, _owner_id: owner, _owner_epoch: 1, _version: 1 };
  for (const changed of [{ _owner_id: randomUUID() }, { _owner_epoch: 2 }, { _version: 2 }]) {
    const op = f.create('effects'); const r = await f.bound.commit({ ...unit(guard, op), _lease: { ...lease, ...changed } });
    assert.equal(r._result._code, 'E_ENTITY_LOCAL_UNIT_FENCED'); assert.equal(await f.read('effects', op._id), null);
  }
  const op = f.create('effects'); f.control.hook = p => { if (p === 'before_commit') f.control.now = 2000; };
  assert.equal((await f.bound.commit({ ...unit(guard, op), _lease: lease }))._result._code, 'E_ENTITY_LOCAL_UNIT_FENCED');
  assert.equal(await f.read('effects', op._id), null); f.control.now = 1000; f.control.hook = undefined;
  assert.equal((await f.bound.commit({ ...unit(guard, op), _lease: lease }))._ok, true);
});

test('Hash preparation has no open transaction and snapshots mutable input before its asynchronous work', async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { password: { _type: 'Hash', _required: true } })],
    binding: { _hash_policy: 'create-and-preserve-v1' } });
  let arrived, release; const entered = new Promise(r => { arrived = r; }), gate = new Promise(r => { release = r; });
  const original = bcrypt.hash; bcrypt.hash = async (...args) => { arrived(); await gate; return original(...args); };
  const op = f.create('effects', undefined, { password: 'synthetic-original' }), u = unit(op); let response;
  try {
    const committing = f.bound.commit(u); await entered;
    assert.equal((await f.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND state='idle in transaction'", [f.db, f.role])).rows[0].count, '0');
    op._create.password = 'synthetic-mutated'; op._create.amount = 999; release(); response = await committing;
  } finally { release(); bcrypt.hash = original; }
  assert.equal(response._ok, true); const row = await f.read('effects', op._id);
  assert.equal(row.amount, 1); assert.equal(await bcrypt.compare('synthetic-original', row.password), true);
  assert.equal(await bcrypt.compare('synthetic-mutated', row.password), false);
});

test('non-JSON class/Date/Map values reject explicitly instead of being silently canonicalized', () => {
  for (const value of [new Date(), new Map(), new (class Input { constructor() { this.value = 1; } })()])
    assert.throws(() => localUnitCanonical({ payload: value }), e => e._code === 'E_ENTITY_LOCAL_UNIT_INVALID');
});

test('native shutdown after preparation rejects admission with no persisted effects or pool leaks', async t => {
  const f = await unitFixture(t), op = f.create('effects'); let closing;
  f.control.hook = p => { if (p === 'after_prepare') closing = f.handle.close(); };
  assert.equal((await f.bound.commit(unit(op)))._ok, false); await closing;
  const c = await f.client(); const count = (await c.query(`SELECT count(*) FROM xpell73."${f.inventory._layouts[0]._table}"`)).rows[0].count;
  assert.equal(count, '0'); const stats = f.handle.diagnostics(); assert.equal(stats._closed, true);
  assert.equal(stats._stores[0]._admitted, 0); assert.equal(stats._stores[0]._total, 0);
});
