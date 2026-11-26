import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unitFixture, unit } from './postgresql-local-unit-fixture.mjs';
import { actor } from './postgresql-local-unit-process.mjs';
import { waitFor } from './postgresql-local-unit-fence-fixture.mjs';

test('separate real PG processes competing on a complete expected record produce one winner without lost updates', async t => {
  const f = await unitFixture(t), a = f.create('effects'); assert.equal((await f.bound.commit(unit(a)))._ok, true);
  const row = await f.read('effects', a._id);
  const make = () => unit({ _entity: 'effects', _id: a._id, _expect: row, _update: { amount: 2 } }, f.create('receipts'));
  const x = await actor(t, f, { unit: make(), pause: 'after_guards' }), y = await actor(t, f, { unit: make() });
  const px = x.start(); await x.checkpoint; const py = y.start();
  await waitFor(t, async () => (await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [f.role])).rowCount > 0);
  await x.release(); const results = await Promise.all([px, py]);
  assert.equal(results.filter(r => r.result._ok).length, 1);
  assert.notEqual(results[0].backendPids[0], results[1].backendPids[0]);
  assert.equal((await f.read('effects', a._id)).amount, 2);
  assert.equal(await f.count('receipts'), 1);
});

test('expected-absence predicate cycle is rejected by actual SERIALIZABLE transactions across processes', async t => {
  const f = await unitFixture(t), xId = randomUUID(), yId = randomUUID();
  const ua = unit({ _entity: 'effects', _id: xId, _expect: null }, f.create('effects', yId), f.create('receipts'));
  const ub = unit({ _entity: 'effects', _id: yId, _expect: null }, f.create('effects', xId), f.create('receipts'));
  const a = await actor(t, f, { unit: ua, pause: 'after_guards' }), b = await actor(t, f, { unit: ub, pause: 'after_guards' });
  const pa = a.start(), pb = b.start(); await Promise.all([a.checkpoint, b.checkpoint]);
  await Promise.all([a.release(), b.release()]); const results = await Promise.all([pa, pb]);
  assert.equal(results.filter(r => r.result._ok).length, 1);
  const failed = results.find(r => !r.result._ok); assert.equal(failed.result._result._code, 'E_ENTITY_POSTGRESQL_CONFLICT');
  assert.notEqual(results[0].backendPids[0], results[1].backendPids[0]);
  assert.equal(await f.count('effects'), 1);
  assert.equal(await f.count('receipts'), 1);
});

test('independent accounts progress concurrently; confirmed SSI abort permits only a fresh caller attempt', async t => {
  const f = await unitFixture(t), ua = unit(f.create('effects')), a = await actor(t, f, { unit: ua, pause: 'after_guards' });
  const b = await actor(t, f, { unit: unit(f.create('effects')) });
  let firstDone = false; const pa = a.start().then(r => { firstDone = true; return r; }); await a.checkpoint;
  const rb = await b.start(); assert.equal(rb.result._ok, true); assert.equal(firstDone, false);
  await a.release(); const ra = await pa;
  // SSI may conservatively conflict on small-table predicate/page locks. No hidden retry.
  if (!ra.result._ok) {
    assert.equal(ra.result._result._code, 'E_ENTITY_POSTGRESQL_CONFLICT');
    assert.equal(await f.read('effects', ua._records[0]._id), null);
    assert.equal((await f.bound.commit(unit(...ua._records)))._ok, true); // Explicit fresh absence guard after proven abort.
  }
  assert.notEqual(ra.backendPids[0], rb.backendPids[0]);
  assert.equal(await f.count('effects'), 2);
});

test('concurrent same unique value creates have exactly one whole-unit effect', async t => {
  const f = await unitFixture(t);
  const a = await actor(t, f, { unit: unit(f.create('effects', undefined, { key: 'same' }), f.create('receipts')), pause: 'after_guards' });
  const b = await actor(t, f, { unit: unit(f.create('effects', undefined, { key: 'same' }), f.create('receipts')), pause: 'after_guards' });
  const pa = a.start(), pb = b.start(); await Promise.all([a.checkpoint, b.checkpoint]);
  await Promise.all([a.release(), b.release()]); const rs = await Promise.all([pa, pb]);
  assert.equal(rs.filter(r => r.result._ok).length, 1);
  assert.equal(await f.count('effects'), 1);
  assert.equal(await f.count('receipts'), 1);
});

test('ordinary CRUD cannot silently overwrite a unit holding the same expected record', async t => {
  const f = await unitFixture(t), a = f.create('effects'); assert.equal((await f.bound.commit(unit(a)))._ok, true);
  const row = await f.read('effects', a._id), worker = await actor(t, f, { pause: 'after_guards',
    unit: unit({ _entity: 'effects', _id: a._id, _expect: row, _update: { amount: 2 } }) });
  const p = worker.start(); await worker.checkpoint;
  const update = f.command('update', { _entity: 'effects', _filter: { _id: a._id }, _updates: { amount: 3 } });
  await waitFor(t, async () => (await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [f.role])).rowCount > 0);
  await worker.release(); assert.equal((await p).result._ok, true); assert.equal((await update)._ok, false);
  assert.equal((await f.read('effects', a._id)).amount, 2);
});

test('actual row lock timeout aborts all unit effects and permits a fresh explicit attempt', async t => {
  const f = await unitFixture(t), a = f.create('effects'); assert.equal((await f.bound.commit(unit(a)))._ok, true);
  const row = await f.read('effects', a._id), locker = await f.client();
  await locker.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await locker.query(`SELECT * FROM xpell73."${f.inventory._layouts[0]._table}" FOR UPDATE`);
  const receipt = f.create('receipts'), u = unit({ _entity: 'effects', _id: a._id, _expect: row, _update: { amount: 2 } }, receipt);
  const r = await f.bound.commit(u); assert.equal(r._result._code, 'E_ENTITY_POSTGRESQL_TIMEOUT');
  await locker.query('ROLLBACK'); assert.equal(await f.read('receipts', receipt._id), null);
  assert.equal((await f.bound.commit(u))._ok, true);
});

test('actual PostgreSQL deadlock involving a bounded unit has a confirmed abort and no partial unit effects', async t => {
  const f = await unitFixture(t, { fixture: { connection: { _timeouts: { _lock_ms: 2500 } } } });
  const ids = [randomUUID(), randomUUID()].sort(), creates = ids.map(id => f.create('effects', id));
  assert.equal((await f.bound.commit(unit(...creates)))._ok, true);
  const rows = await Promise.all(ids.map(id => f.read('effects', id)));
  const column = f.inventory._layouts[0]._fields.find(field => field._name === '_id')._column;
  const sql = `SELECT * FROM xpell73."${f.inventory._layouts[0]._table}" WHERE "${column}"=$1 FOR UPDATE`;
  const locker = await f.client(); await locker.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await locker.query(sql, [Buffer.from(ids[1])]);
  const worker = await actor(t, f, { pause: 'after_lock_1', unit: unit(...rows.map(row => ({ _entity: 'effects', _id: row._id,
    _expect: row, _update: { amount: 2 } })).reverse()) });
  const result = worker.start(); await worker.checkpoint;
  const outside = locker.query(sql, [Buffer.from(ids[0])]).then(() => ({ ok: true }), e => ({ code: e.code }))
    .then(async r => { await locker.query('ROLLBACK'); return r; });
  await waitFor(t, async () => (await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [locker.processID])).rowCount === 1);
  await worker.release(); const [r, other] = await Promise.all([result, outside]);
  assert.ok(other.code === '40P01' || r.result._result._code === 'E_ENTITY_POSTGRESQL_CONFLICT');
  const after = await Promise.all(ids.map(id => f.read('effects', id)));
  assert.deepEqual(after.map(row => row.amount), r.result._ok ? [2, 2] : [1, 1]);
  if (!r.result._ok) assert.equal(r.result._result._code, 'E_ENTITY_POSTGRESQL_CONFLICT');
});
