import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { _x, _xem, bindEntityLocalUnit, ENTITY_LOCAL_UNIT_CAPABILITIES } from '../dist/index.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';
import { validateLocalUnit } from '../dist/XEntityManager/EntityLocalUnit.js';

const work = mkdtempSync(path.join(tmpdir(), 'entity-local-unit-'));
const manager = new XEntityManager({ _work_folder: work });
await _x.loadModuleAsync(manager);
after(() => rmSync(work, { recursive: true, force: true }));

async function setup(t, extra = {}) {
  const dir = work;
  const scope = { _env: 'default', _app_id: 'synthetic-local-unit-' + randomUUID() };
  const schema = { _value: { _type: 'String', _required: true, _index: { _unique: true }, _max_length: 30 } };
  const command = async (op, params) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
  for (const name of ['effect', 'receipt']) {
    const response = await command('register', { _entity: { _id: name, _storage: {
      _provider: 'sqlite', _scope: 'app', ...(name === 'receipt' ? { _append_only: true } : {}) }, _schema: schema } });
    assert.equal(response._ok, true);
  }
  let fault;
  const bound = await bindEntityLocalUnit({ ...scope, _entities: [{ _entity: 'effect', _write: true }, { _entity: 'receipt', _write: true }],
    _clock: () => 1000, _fault: p => { if (p === fault) throw new Error('synthetic failure'); }, ...extra });
  t.after(async () => { for (const name of ['effect', 'receipt']) await command('unregister', { _entity: name }); });
  const read = async (entity, id) => (await command('get', { _entity: entity, _id: id }))._result._record;
  const create = (entity, id, value) => ({ _entity: entity, _id: id, _expect: null, _create: { _id: id, _value: value } });
  return { dir, scope, bound, manager, command, read, create, fault: p => { fault = p; } };
}

test('local unit commits two native entities and verifies FULL without changing legacy NORMAL', async t => {
  const f = await setup(t), a = randomUUID(), b = randomUUID();
  const r = await f.bound.commit({ _unit_id: randomUUID(), _records: [f.create('effect', a, 'effect'), f.create('receipt', b, 'receipt')] });
  assert.equal(r._ok, true); assert.deepEqual(r._result._durability, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1 });
  assert.equal((await f.read('effect', a))._value, 'effect');
  const db = new Database(path.join(f.dir, 'xdb/entity-provider.sqlite'));
  assert.equal(db.pragma('synchronous', { simple: true }), 1); db.close(); // The driver/legacy default remains NORMAL on other connections.
  const stats = _x.getModule('entity-manager');
  const providers = [...stats._entities.values()].map(e => e._provider);
  assert.ok(providers.every(p => p._db.pragma('synchronous', { simple: true }) === 1));
});

for (const point of ['after_write_1', 'after_write_2', 'before_commit']) test(`local unit rolls back ${point}`, async t => {
  const f = await setup(t), a = randomUUID(), b = randomUUID(); f.fault(point);
  assert.equal((await f.bound.commit({ _unit_id: randomUUID(), _records: [f.create('effect', a, 'effect'), f.create('receipt', b, 'receipt')] }))._ok, false);
  assert.equal(await f.read('effect', a), null); assert.equal(await f.read('receipt', b), null);
});

test('concurrent units, unique failure and stale expectations cannot leave partial writes', async t => {
  const f = await setup(t), a = randomUUID(), b = randomUUID();
  const unit = { _unit_id: randomUUID(), _records: [f.create('effect', a, 'one'), f.create('receipt', b, 'one')] };
  const results = await Promise.all([f.bound.commit(unit), f.bound.commit(unit)]);
  assert.equal(results.filter(r => r._ok).length, 1);
  const c = randomUUID();
  const failed = await f.bound.commit({ _unit_id: randomUUID(), _records: [f.create('effect', c, 'two'), f.create('receipt', randomUUID(), 'one')] });
  assert.equal(failed._ok, false); assert.equal(await f.read('effect', c), null);
});

test('append-only receipt blocks ordinary update/delete and schema downgrade', async t => {
  const f = await setup(t), id = randomUUID();
  assert.equal((await f.bound.commit({ _unit_id: randomUUID(), _records: [f.create('receipt', id, 'receipt')] }))._ok, true);
  for (const op of ['update', 'delete']) assert.equal((await f.command(op, { _entity: 'receipt', _filter: { _id: id }, _updates: { _value: 'changed' } }))._ok, false);
  assert.equal((await f.command('register', { _entity: { _id: 'receipt', _storage: { _provider: 'sqlite', _scope: 'app' }, _schema: {} } }))._ok, false);
  assert.equal((await f.read('receipt', id))._value, 'receipt');
});

test('unit boundary rejects forged authority, selectors, oversized data, invalid versions and unknown schemas', async t => {
  const f = await setup(t), id = randomUUID();
  const unit = { _unit_id: randomUUID(), _records: [f.create('effect', id, 'one')] };
  assert.equal((await f.command('commit-local-unit', { _unit: unit, _local_unit_key: randomUUID() }))._ok, false);
  for (const bad of [ { ...unit, _app_id: 'foreign' }, { ...unit, _records: [f.create('foreign', id, 'one')] },
    { ...unit, _records: [f.create('effect', id, 'x'.repeat(70000))] }, { ...unit, _records: [f.create('effect', id, 'x'.repeat(31))] },
    { ...unit, _valid_until: 1000 }, { ...unit, _lease: { _entity: 'effect', _id: id, _owner_id: randomUUID(), _owner_epoch: 1, _version: 1 } },
    { ...unit, _records: [f.create('effect', id, 'one'), f.create('effect', id, 'two')] } ]) assert.equal((await f.bound.commit(bad))._ok, false);
  assert.equal(await f.read('effect', id), null);
});

test('binding rejects foreign providers/databases and schema changes', async t => {
  const f = await setup(t);
  assert.equal((await f.command('register', { _entity: { _id: 'foreign', _storage: { _provider: 'sqlite', _scope: 'app', _db_path: path.join(f.dir, 'foreign.sqlite') }, _schema: {} } }))._ok, true);
  await assert.rejects(bindEntityLocalUnit({ ...f.scope, _entities: [{ _entity: 'effect', _write: true }, { _entity: 'foreign', _write: true }] }));
  await f.command('unregister', { _entity: 'foreign' });
  assert.equal((await f.command('register', { _entity: { _id: 'memory', _storage: { _provider: 'memory', _scope: 'app' }, _schema: {} } }))._ok, true);
  await assert.rejects(bindEntityLocalUnit({ ...f.scope, _entities: [{ _entity: 'memory', _write: true }] }));
  await f.command('unregister', { _entity: 'memory' });
  assert.equal((await f.command('register', { _entity: { _id: 'effect', _storage: { _provider: 'sqlite', _scope: 'app' }, _schema: { _changed: { _type: 'String' } } } }))._ok, true);
  assert.equal((await f.bound.commit({ _unit_id: randomUUID(), _records: [{ _entity: 'effect', _id: randomUUID() }] }))._ok, false);
});

test('transport context is rejected even with a genuine local key, and read-only grants cannot write', async t => {
  const f = await setup(t), id = randomUUID(), key = [...f.manager._local_units.keys()].at(-1);
  const result = await _x.execute({ _module: 'entity-manager', _op: 'commit-local-unit', _ctx: { _sid: 'untrusted-transport' },
    _params: { _local_unit_key: key, _unit: { _unit_id: randomUUID(), _records: [f.create('effect', id, 'one')] } } });
  assert.equal(result._ok, false); assert.equal(await f.read('effect', id), null);
  const reader = await bindEntityLocalUnit({ ...f.scope, _entities: [{ _entity: 'effect', _write: false }] });
  assert.equal((await reader.commit({ _unit_id: randomUUID(), _records: [f.create('effect', id, 'one')] }))._ok, false);
});

test('actual scoped notifications happen only after commit and a lost response cannot roll back effects', async t => {
  const f = await setup(t), id = randomUUID(); let events = 0;
  const listener = _xem.on('xdb:create', data => { if (data._app_id === f.scope._app_id) events++; });
  t.after(() => _xem.remove(listener));
  const unit = { _unit_id: randomUUID(), _records: [f.create('effect', id, 'one')] };
  f.fault('before_commit'); assert.equal((await f.bound.commit(unit))._ok, false); assert.equal(events, 0);
  f.fault('after_commit'); assert.equal((await f.bound.commit(unit))._ok, false);
  assert.equal((await f.read('effect', id))._value, 'one'); assert.equal(events, 1);
  assert.equal((await f.bound.commit(unit))._ok, false); assert.equal(events, 1);
});

test('critical writer refuses a degraded synchronous setting', async t => {
  const f = await setup(t), pragma = Database.prototype.pragma;
  Database.prototype.pragma = function(sql, ...args) { return pragma.call(this, sql === 'synchronous = FULL' ? 'synchronous = NORMAL' : sql, ...args); };
  try { assert.equal((await f.bound.commit({ _unit_id: randomUUID(), _records: [f.create('effect', randomUUID(), 'one')] }))._ok, false); }
  finally { Database.prototype.pragma = pragma; }
});

// Five effects (the last an immutable receipt), five complete guards, eight types.
async function capacityFixture(t, profile) {
  const scope = { _env: 'default', _app_id: 'synthetic-capacity-' + randomUUID() };
  const names = [...Array.from({ length: 7 }, (_, i) => 'effect' + i), 'receipt'];
  const command = (op, params) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
  for (const name of names) assert.equal((await command('register', { _entity: { _id: name,
    _storage: { _provider: 'sqlite', _scope: 'app', ...(name === 'receipt' ? { _append_only: true } : {}) },
    _schema: { _value: { _type: 'String', _required: true, _index: { _unique: true } }, _payload: { _type: 'String' },
      _state: { _type: 'String' }, _owner_id: { _type: 'String' }, _owner_epoch: { _type: 'Number' },
      _version: { _type: 'Number' }, _lease_expires_at: { _type: 'Number' } } } }))._ok, true);
  t.after(async () => { for (const name of [...names, 'ninth', 'hashed']) await command('unregister', { _entity: name }); });
  const options = { ...scope, _entities: names.map(_entity => ({ _entity, _write: true })),
    ...(profile === undefined ? {} : { _capacity_profile: profile }), _clock: () => 1000 };
  let fault;
  options._fault = point => { if (point === fault) throw new Error('synthetic capacity failure'); };
  const bound = await bindEntityLocalUnit(options);
  const guards = [];
  for (const [i, name] of ['effect4', 'effect5', 'effect6', 'effect0', 'effect1'].entries()) {
    const record = { _id: randomUUID(), _value: 'guard-' + i };
    const r = await command('add', { _entity: name, _data: record }); assert.equal(r._ok, true);
    guards.push({ _entity: name, _id: record._id, _expect: r._result._record });
  }
  const unit = () => ({ _unit_id: randomUUID(), _records: [
    ...['effect0', 'effect1', 'effect2', 'effect3', 'receipt'].map(_entity => {
      const _id = randomUUID(); return { _entity, _id, _expect: null, _create: { _id, _value: randomUUID() } };
    }), ...structuredClone(guards) ] });
  const read = async op => (await command('get', { _entity: op._entity, _id: op._id }))._result._record;
  const assertAbsent = async u => { for (const op of u._records.filter(r => r._create)) assert.equal(await read(op), null); };
  return { bound, options, scope, names, command, unit, read, assertAbsent, fault: p => { fault = p; } };
}
const expectedCapacity = profile => ({ _version: 2, _profile: profile,
  _limits: { _records: profile === 'expanded-v1' ? 10 : 8, _writes: profile === 'expanded-v1' ? 5 : 4, _entities: 8, _bytes: 65536 } });

test('public fixed profiles and acknowledgements are deeply immutable; old/missing capabilities fail negotiation', async t => {
  assert.deepEqual(ENTITY_LOCAL_UNIT_CAPABILITIES, { _version: 2, _profiles: {
    'standard-v1': expectedCapacity('standard-v1')._limits, 'expanded-v1': expectedCapacity('expanded-v1')._limits } });
  const f = await capacityFixture(t, 'expanded-v1');
  for (const o of [ENTITY_LOCAL_UNIT_CAPABILITIES, ENTITY_LOCAL_UNIT_CAPABILITIES._profiles,
    ...Object.values(ENTITY_LOCAL_UNIT_CAPABILITIES._profiles), f.bound, f.bound._capacity, f.bound._capacity._limits]) assert.equal(Object.isFrozen(o), true);
  assert.throws(() => { ENTITY_LOCAL_UNIT_CAPABILITIES._profiles['standard-v1']._writes = 5; }, TypeError);
  assert.throws(() => { f.bound._capacity._limits._writes = 6; }, TypeError);
  const negotiate = (runtime, binding) => {
    assert.equal(runtime?._version, 2);
    assert.deepEqual(runtime._profiles?.['expanded-v1'], expectedCapacity('expanded-v1')._limits);
    assert.deepEqual(binding?._capacity, expectedCapacity('expanded-v1'));
  };
  negotiate(ENTITY_LOCAL_UNIT_CAPABILITIES, f.bound);
  for (const [runtime, binding] of [[undefined, {}], [{ _version: 1 }, f.bound], [ENTITY_LOCAL_UNIT_CAPABILITIES, {}],
    [ENTITY_LOCAL_UNIT_CAPABILITIES, { _capacity: expectedCapacity('standard-v1') }]]) assert.throws(() => negotiate(runtime, binding));
});

test('omitted standard profile preserves 8/4 boundaries and binding/result shapes', async t => {
  const f = await capacityFixture(t);
  const u = f.unit(); u._records.splice(4, 1); u._records.pop(); // four writes + four guards
  assert.equal(u._records.length, 8); validateLocalUnit(u);
  const r = await f.bound.commit(u); assert.equal(r._ok, true);
  assert.deepEqual(Object.keys(f.bound).sort(), ['_app_id', '_env', 'commit']);
  assert.deepEqual(Object.keys(r._result).sort(), ['_durability', '_records']);
  const five = f.unit(); five._records = five._records.slice(0, 5);
  assert.equal((await f.bound.commit(five))._ok, false); await f.assertAbsent(five);
  const nine = f.unit(); nine._records.splice(0, 1);
  assert.equal((await f.bound.commit(nine))._ok, false); await f.assertAbsent(nine);
  assert.throws(() => validateLocalUnit(f.unit())); // one-argument validator remains standard
  assert.throws(() => validateLocalUnit(u, { _records: 100, _writes: 100, _entities: 100, _bytes: 1000000 }));
});

test('explicit standard acknowledgement and expanded 10/5 commit match the requested fixed profiles', async t => {
  const standard = await capacityFixture(t, 'standard-v1');
  assert.deepEqual(standard.bound._capacity, expectedCapacity('standard-v1'));
  const one = standard.unit(); one._records = one._records.slice(0, 1);
  assert.deepEqual((await standard.bound.commit(one))._result._capacity, standard.bound._capacity);
  assert.equal((await standard.bound.commit(standard.unit()))._ok, false);
  const f = await capacityFixture(t, 'expanded-v1'), u = f.unit();
  assert.equal(u._records.length, 10); assert.equal(new Set(u._records.map(r => r._entity)).size, 8);
  const r = await f.bound.commit(u); assert.equal(r._ok, true, JSON.stringify(r));
  assert.deepEqual(r._result._capacity, expectedCapacity('expanded-v1'));
  assert.deepEqual(r._result._durability, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1 });
  for (const op of u._records) assert.deepEqual(await f.read(op), r._result._records.find(r => r._record?._id === op._id)._record);
  assert.equal((await f.bound.commit(u))._ok, false); // no receipt or effect duplication
});

test('expanded limits reject eleven records, six writes, nine bound types and oversized UTF-8 payloads', async t => {
  const f = await capacityFixture(t, 'expanded-v1');
  const eleven = f.unit(); eleven._records.push({ _entity: 'effect0', _id: randomUUID(), _expect: null });
  const six = f.unit(), guard = six._records.at(-1); guard._update = { _value: randomUUID() };
  const bytes = f.unit(); bytes._records[0]._create._payload = 'א'.repeat(33000);
  for (const u of [eleven, six, bytes]) { assert.equal((await f.bound.commit(u))._ok, false); await f.assertAbsent(u); }
  assert.equal((await f.command('register', { _entity: { _id: 'ninth', _storage: { _provider: 'sqlite', _scope: 'app' }, _schema: {} } }))._ok, true);
  await assert.rejects(bindEntityLocalUnit({ ...f.options, _entities: [...f.options._entities, { _entity: 'ninth', _write: false }] }));
  const foreign = f.unit(); foreign._records.at(-1)._entity = 'ninth';
  assert.equal((await f.bound.commit(foreign))._ok, false); await f.assertAbsent(foreign);
  const exact = f.unit(); exact._records[0]._create._payload = '';
  exact._records[0]._create._payload = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536);
  assert.equal((await f.bound.commit(exact))._ok, true);
  const tooLarge = structuredClone(exact); tooLarge._records[0]._create._payload += 'x';
  const rejected = await f.bound.commit(tooLarge);
  assert.equal(rejected._ok, false); assert.equal(rejected._result._code, 'E_ENTITY_LOCAL_UNIT_INVALID');
});

test('profile resolution precedes issuance; callers and commands cannot escalate a frozen binding', async t => {
  const f = await capacityFixture(t), before = manager._local_units.size;
  for (const profile of [null, '', {}, 'toString', '__proto__', 'expanded-v2']) {
    await assert.rejects(bindEntityLocalUnit({ ...f.options, _capacity_profile: profile }), e => e._code === 'E_ENTITY_LOCAL_UNIT_CAPACITY');
    assert.equal(manager._local_units.size, before);
  }
  f.options._capacity_profile = 'expanded-v1'; f.options._entities[0]._write = false;
  assert.equal((await f.bound.commit(f.unit()))._ok, false);
  const expanded = await capacityFixture(t, 'expanded-v1');
  expanded.options._capacity_profile = 'standard-v1'; expanded.options._entities.length = 0;
  assert.equal((await expanded.bound.commit(expanded.unit()))._ok, true);
  const key = [...manager._local_units.keys()].at(-1);
  for (const extra of [{ _capacity_profile: 'expanded-v1' }, { _capacity: expectedCapacity('expanded-v1') }, { _limits: { _writes: 99 } }]) {
    assert.equal((await f.bound.commit({ ...f.unit(), ...extra }))._ok, false);
    assert.equal((await _x.execute({ _module: 'entity-manager', _op: 'commit-local-unit', _params: { _local_unit_key: key, _unit: expanded.unit(), ...extra } }))._ok, false);
  }
  const transport = await _x.execute({ _module: 'entity-manager', _op: 'commit-local-unit', _ctx: { _sid: 'untrusted' },
    _params: { _local_unit_key: key, _unit: expanded.unit() } });
  assert.equal(transport._ok, false);
  const reader = await bindEntityLocalUnit({ ...expanded.scope, _capacity_profile: 'expanded-v1', _entities: expanded.names.map(_entity => ({ _entity, _write: false })) });
  assert.equal((await reader.commit(expanded.unit()))._ok, false);
});

for (const point of ['after_write_1', 'after_write_2', 'after_write_3', 'after_write_4', 'after_write_5', 'before_commit']) {
  test(`expanded native transaction rolls back all five writes at ${point}`, async t => {
    const f = await capacityFixture(t, 'expanded-v1'), u = f.unit(); f.fault(point);
    assert.equal((await f.bound.commit(u))._ok, false); await f.assertAbsent(u);
    for (const guard of u._records.slice(5)) assert.deepEqual(await f.read(guard), guard._expect);
  });
}

test('expanded concurrency, full guard CAS and fifth-write uniqueness cannot leave partial effects', async t => {
  const f = await capacityFixture(t, 'expanded-v1'), u = f.unit();
  const races = await Promise.all([f.bound.commit(u), f.bound.commit(u)]);
  assert.equal(races.filter(r => r._ok).length, 1);
  const collision = f.unit(); collision._records[4]._create._value = u._records[4]._create._value;
  assert.equal((await f.bound.commit(collision))._ok, false); await f.assertAbsent(collision);
  const stale = f.unit(); stale._records.at(-1)._expect._value = 'stale';
  assert.equal((await f.bound.commit(stale))._ok, false); await f.assertAbsent(stale);
  const receipt = await f.read(u._records[4]);
  const immutable = f.unit(); immutable._records[4] = { _entity: 'receipt', _id: receipt._id, _expect: receipt, _update: { _value: 'tampered' } };
  assert.equal((await f.bound.commit(immutable))._ok, false); await f.assertAbsent(immutable);
  for (const op of ['update', 'delete']) assert.equal((await f.command(op, { _entity: 'receipt', _filter: { _id: receipt._id }, _updates: { _value: 'tampered' } }))._ok, false);
  assert.deepEqual(await f.read(u._records[4]), receipt);
});

test('expanded lease owner/epoch/version/expiry fencing and Hash write restrictions remain enforced', async t => {
  const f = await capacityFixture(t, 'expanded-v1'), u = f.unit(), op = u._records.at(-1), owner = randomUUID();
  assert.equal((await f.command('update', { _entity: op._entity, _filter: { _id: op._id }, _updates: {
    _state: 'claimed', _owner_id: owner, _owner_epoch: 2, _version: 3, _lease_expires_at: 2000 } }))._ok, true);
  op._expect = await f.read(op);
  u._lease = { _entity: op._entity, _id: op._id, _owner_id: owner, _owner_epoch: 2, _version: 3 };
  for (const mismatch of [{ _owner_id: randomUUID() }, { _owner_epoch: 1 }, { _version: 2 }]) {
    assert.equal((await f.bound.commit({ ...u, _lease: { ...u._lease, ...mismatch } }))._ok, false); await f.assertAbsent(u);
  }
  const expired = await bindEntityLocalUnit({ ...f.options, _clock: () => 2000 });
  assert.equal((await expired.commit(u))._ok, false); await f.assertAbsent(u);
  assert.equal((await f.bound.commit(u))._ok, true);
  assert.equal((await f.command('register', { _entity: { _id: 'hashed', _storage: { _provider: 'sqlite', _scope: 'app' },
    _schema: { _secret: { _type: 'Hash' } } } }))._ok, true);
  const hash = await bindEntityLocalUnit({ ...f.scope, _capacity_profile: 'expanded-v1', _entities: [{ _entity: 'hashed', _write: true }] });
  const id = randomUUID(); assert.equal((await hash.commit({ _unit_id: randomUUID(), _records: [{ _entity: 'hashed', _id: id, _expect: null,
    _create: { _id: id, _secret: 'synthetic' } }] }))._ok, false);
});

test('expanded lost acknowledgement keeps all effects and immutable receipt for reconciliation', async t => {
  const f = await capacityFixture(t, 'expanded-v1'), u = f.unit(); f.fault('after_commit');
  assert.equal((await f.bound.commit(u))._ok, false);
  for (const op of u._records.slice(0, 5)) assert.equal((await f.read(op))._id, op._id);
  f.fault(undefined); assert.equal((await f.bound.commit(u))._ok, false);
  const readOnly = { _unit_id: randomUUID(), _records: u._records.map(op => ({ _entity: op._entity, _id: op._id })) };
  const r = await f.bound.commit(readOnly); assert.equal(r._ok, true);
  assert.deepEqual(r._result._capacity, expectedCapacity('expanded-v1'));
  assert.equal(r._result._records.filter(r => r._record !== null).length, 10);
});

for (const pragmaName of ['journal_mode', 'synchronous', 'foreign_keys']) {
  test(`expanded binding and commit fail closed when ${pragmaName} verification degrades`, async t => {
    const f = await capacityFixture(t, 'expanded-v1'), u = f.unit(), original = Database.prototype.pragma;
    Database.prototype.pragma = function(sql, ...args) {
      if (sql === pragmaName) return pragmaName === 'journal_mode' ? 'delete' : 0;
      return original.call(this, sql, ...args);
    };
    try {
      await assert.rejects(bindEntityLocalUnit(f.options), e => e._code === 'E_ENTITY_LOCAL_UNIT_DURABILITY');
      assert.equal((await f.bound.commit(u))._ok, false);
    } finally { Database.prototype.pragma = original; }
    await f.assertAbsent(u);
  });
}
