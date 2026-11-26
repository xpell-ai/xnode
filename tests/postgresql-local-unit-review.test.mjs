import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import { _xem } from '../dist/index.js';
import { PostgreSQLEntityProvider } from '../dist/XEntityManager/PostgreSQLEntityProvider.js';
import { unitFixture, unitDefinition, unit, errorCode } from './postgresql-local-unit-fixture.mjs';

for (const alias of [' effects ', 'ｅｆｆｅｃｔｓ', ' ｅｆｆｅｃｔｓ ']) {
  test(`PG rejects duplicate physical binding ${JSON.stringify(alias)} before BEGIN and preserves the snapshot`, async t => {
    const f = await unitFixture(t), seed = f.create('effects');
    assert.equal((await f.bound.commit(unit(seed)))._ok, true);
    const row = await f.read('effects', seed._id), original = Client.prototype.query; let begins = 0;
    Client.prototype.query = function(q, ...args) { if ((typeof q === 'string' ? q : q.text).startsWith('BEGIN')) begins++; return original.call(this, q, ...args); };
    try {
      for (const write of [true, false]) await assert.rejects(f.manager.bindLocalUnit({ ...f.options,
        _entities: [{ _entity: 'effects', _write: true }, { _entity: alias, _write: write }] }), e => e._code === 'E_ENTITY_LOCAL_UNIT_INVALID');
      assert.equal(begins, 0);
    } finally { Client.prototype.query = original; }
    assert.deepEqual(await f.read('effects', seed._id), row);
    // The backend also defends its fixed native boundary, independently of the manager binding.
    const provider = [...f.manager._entities.values()].find(e => e._definition._id === 'effects')._provider;
    const records = [{ _entity: 'effects', _id: seed._id, _expect: row, _update: { amount: 2 } },
      { _entity: alias, _id: seed._id, _expect: row, _update: { note: 'second' } }];
    const options = { _clock: () => 1000, _limits: f.bound._durability_contract._capacity._limits,
      _revalidate: () => {}, _strict_final_checks: true };
    await assert.rejects(PostgreSQLEntityProvider.commitLocalUnit(new Map([['effects', provider], [alias, provider]]), unit(...records), options));
    assert.deepEqual(await f.read('effects', seed._id), row);
  });
  test(`PG retains a single declared alias ${JSON.stringify(alias)} and exact duplicate-record rejection`, async t => {
    const f = await unitFixture(t), bound = await f.manager.bindLocalUnit({ ...f.options, _entities: [{ _entity: alias, _write: true }] });
    const op = f.create(alias); assert.equal((await bound.commit(unit(op)))._ok, true);
    const row = await f.read('effects', op._id);
    const duplicate = { _entity: alias, _id: op._id, _expect: row, _update: { amount: 2 } };
    assert.equal(errorCode(await bound.commit(unit(duplicate, { ...duplicate, _update: { note: 'second' } }))), 'E_ENTITY_LOCAL_UNIT_INVALID');
    assert.deepEqual(await f.read('effects', op._id), row);
  });
}

const corruptions = [
  ['null create', r => { r._records[0]._record = null; }],
  ['null update', r => { r._records[1]._record = null; }],
  ['null expected-record guard', r => { r._records[2]._record = null; }],
  ['changed expected guard body', r => { r._records[2]._record.amount = 999; }],
  ['non-null absence guard with the correct ID', (r, u) => { r._records[3]._record = { ...r._records[0]._record, _id: u._records[3]._id }; }],
  ['wrong record identity', r => { r._records[0]._record._id = randomUUID(); }],
  ['wrong entity identity', r => { r._records[0]._entity = 'receipts'; }],
  ['missing record item', r => { r._records.pop(); }],
  ['missing record property', r => { delete r._records[0]._record; }],
  ['array record', r => { r._records[0]._record = []; }],
  ['changed create intent in both lists', r => { r._records[0]._record.amount = r._changed[0]._record.amount = 999; }],
  ['changed normalized default in both lists', r => { r._records[0]._record.counter = r._changed[0]._record.counter = 999; }],
  ['dropped create field in both lists', r => { delete r._records[0]._record.key; delete r._changed[0]._record.key; }],
  ['extra create field in both lists', r => { r._records[0]._record.extra = r._changed[0]._record.extra = true; }],
  ['changed update intent in both lists', r => { r._records[1]._record.amount = r._changed[1]._record.amount = 999; }],
  ['lost unchanged update field in both lists', r => { delete r._records[1]._record.note; delete r._changed[1]._record.note; }],
  ['changed creation timestamp', r => { r._records[1]._record._created_at = r._changed[1]._record._created_at = '2000-01-01T00:00:00.000Z'; }],
  ['invalid update timestamp', r => { r._records[0]._record._updated_at = r._changed[0]._record._updated_at = 'invalid'; }],
  ['inconsistent write timestamps', r => { r._records[0]._record._updated_at = r._changed[0]._record._updated_at = '2000-01-01T00:00:00.000Z'; }],
  ['missing notification', r => { r._changed.pop(); }],
  ['duplicate notification', r => { r._changed.push(r._changed[0]); }],
  ['unknown notification entity', r => { r._changed[0]._entity = 'unbound'; }],
  ['wrong notification operation', r => { r._changed[0]._event = 'xdb:delete'; }],
  ['swapped notification operations', r => { r._changed[0]._event = 'xdb:update'; r._changed[1]._event = 'xdb:create'; }],
  ['inconsistent notification record', r => { r._changed[0]._record.amount = 777; }],
  ['notification on a guard', r => { r._changed.push({ ...r._records[2], _event: 'xdb:update' }); }],
  ['reordered notifications', r => { r._changed.reverse(); }],
  ['null notifications', r => { r._changed = null; }],
  ['non-JSON notification data', r => { r._changed[0]._record = new Date(); }],
];
for (const [label, corrupt] of corruptions) test(`actual committed PG response corruption: ${label} is uncertain and never broadcast`, async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { counter: { _type: 'Number', _default: '7' } }), unitDefinition('receipts', true)] });
  const seed = f.create('effects', undefined, { note: 'preserved' }); assert.equal((await f.bound.commit(unit(seed)))._ok, true);
  const row = await f.read('effects', seed._id), create = f.create('effects'), receipt = f.create('receipts');
  const u = unit(create, { _entity: 'effects', _id: seed._id, _expect: row, _update: { amount: 2 } },
    { _entity: 'effects', _id: randomUUID(), _expect: null }, { _entity: 'receipts', _id: randomUUID(), _expect: null }, receipt);
  // The expected-record guard uses the newly seeded existing immutable receipt.
  const guard = f.create('receipts'); assert.equal((await f.bound.commit(unit(guard)))._ok, true);
  u._records[2] = { _entity: 'receipts', _id: guard._id, _expect: await f.read('receipts', guard._id) };
  const owned = [...f.manager._local_units.values()].at(-1), backend = owned._backend; let commits = 0, events = 0;
  const listeners = ['xdb:create', 'xdb:update', 'xdb:delete'].map(event => _xem.on(event, data => { if (data._app_id === 'pg73') events++; }));
  t.after(() => { for (const listener of listeners) _xem.remove(listener); });
  owned._backend = { ...backend, commit: async (...args) => {
    commits++; const committed = await backend.commit(...args);
    // JSON clone separates the two lists: prove the validator checks their consistency.
    const result = JSON.parse(JSON.stringify(committed)); corrupt(result, u); return result;
  } };
  const r = await f.bound.commit(u);
  assert.equal(errorCode(r), 'E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN'); assert.equal(r._ok, false);
  assert.equal(r._result._durability_attestation, undefined); assert.equal(commits, 1); assert.equal(events, 0);
  assert.equal((await f.read('effects', create._id)).amount, 1);
  assert.equal((await f.read('effects', seed._id)).amount, 2);
  assert.equal((await f.read('receipts', receipt._id)).amount, 1);
  // Reconciliation is independent. Blind replay conflicts rather than silently writing twice.
  owned._backend = backend;
  assert.equal(errorCode(await f.bound.commit(u)), 'E_ENTITY_LOCAL_UNIT_CONFLICT'); assert.equal(events, 0);
});

test('PG acknowledges real writes, normalized defaults, existing/absent guards and Hash redaction together', async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { password: { _type: 'Hash', _required: true, _default: null },
    counter: { _type: 'Number', _default: '7' }, active: { _type: 'Boolean', _default: 'true' } }), unitDefinition('receipts', true)],
    binding: { _hash_policy: 'create-and-preserve-v1' } });
  const op = f.create('effects', undefined, { password: 'synthetic-review-passphrase' }), receipt = f.create('receipts');
  const events = [], listener = _xem.on('xdb:create', data => { if (data._app_id === 'pg73') events.push(data); }); t.after(() => _xem.remove(listener));
  const r = await f.bound.commit(unit(op, receipt, { _entity: 'effects', _id: randomUUID(), _expect: null },
    { _entity: 'receipts', _id: randomUUID() }));
  assert.equal(r._ok, true, JSON.stringify(r)); assert.equal(r._result._records[0]._record.counter, 7);
  assert.equal(r._result._records[0]._record.active, true); assert.equal(r._result._records[2]._record, null); assert.equal(r._result._records[3]._record, null);
  assert.equal(events.length, 2); assert.equal(JSON.stringify(events).includes('password'), false);
  const row = await f.read('effects', op._id);
  assert.equal((await f.bound.commit(unit({ _entity: 'effects', _id: op._id, _expect: row, _update: { amount: 2 } },
    { _entity: 'receipts', _id: receipt._id, _expect: await f.read('receipts', receipt._id) })))._ok, true);
});

for (const kind of ['create', 'update']) test(`PG rejects a valid bcrypt value for the wrong ${kind} result after real COMMIT`, async t => {
  const f = await unitFixture(t, { definitions: [unitDefinition('effects', false, { password: { _type: 'Hash', _required: true } })],
    binding: { _hash_policy: 'create-and-preserve-v1' } });
  const create = f.create('effects', undefined, { password: 'synthetic-original' });
  let op = create;
  if (kind === 'update') {
    assert.equal((await f.bound.commit(unit(create)))._ok, true);
    op = { _entity: 'effects', _id: create._id, _expect: await f.read('effects', create._id), _update: { amount: 2 } };
  }
  const wrong = await bcrypt.hash('synthetic-other', 10), owned = [...f.manager._local_units.values()].at(-1), original = owned._backend;
  owned._backend = { ...original, commit: async (...args) => {
    const r = JSON.parse(JSON.stringify(await original.commit(...args)));
    r._records[0]._record.password = r._changed[0]._record.password = wrong; return r;
  } };
  const response = await f.bound.commit(unit(op)); assert.equal(errorCode(response), 'E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN');
  assert.equal(JSON.stringify(response).includes(wrong), false); assert.equal(JSON.stringify(response).includes(create._create.password), false);
  const actual = await f.read('effects', create._id); assert.equal(await bcrypt.compare(create._create.password, actual.password), true);
  assert.equal(actual.amount, kind === 'update' ? 2 : 1);
});
