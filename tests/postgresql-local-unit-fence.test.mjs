import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';
import { migratePostgreSQLStore } from '../dist/XEntityManager/PostgreSQLSchema.js';
import { fixture } from './postgresql-fixture.mjs';
import { fenceFixture, latch, waitFor } from './postgresql-local-unit-fence-fixture.mjs';
import { unit, unitDefinition } from './postgresql-local-unit-fixture.mjs';

const create = (entity = 'effects') => { const id = randomUUID(); return { _entity: entity, _id: id, _expect: null, _create: { _id: id, key: id, amount: 1 } }; };

test('explicit metadata v3 retains old ledgers, supports shared locks and denies all meaningful runtime fence mutations', async t => {
  const f = await fenceFixture(t), p = f.make(); await p.init(); assert.equal(await p.count(), 0);
  const client = await f.client();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal((await client.query('SELECT epoch::text AS epoch FROM xpell73.ep_fence FOR SHARE')).rows[0].epoch, '1');
  await client.query('ROLLBACK');
  for (const sql of ['UPDATE xpell73.ep_fence SET epoch=epoch+1', 'UPDATE xpell73.ep_fence SET owner_id=NULL',
    'UPDATE xpell73.ep_fence SET required=FALSE', 'DELETE FROM xpell73.ep_fence', 'TRUNCATE xpell73.ep_fence',
    'ALTER TABLE xpell73.ep_fence DROP CONSTRAINT ep_fence_lock_anchor_check']) await assert.rejects(client.query(sql), e => e.code === '42501');
  await assert.rejects(client.query('UPDATE xpell73.ep_fence SET lock_anchor=FALSE'), e => e.code === '23514');
  const op = create(); await assert.rejects(p.add(op._create), e => e._code === 'E_ENTITY_LOCAL_UNIT_FENCED');
  assert.equal(await p.count(), 0);
});

test('public native binding fails closed without a production issuer or with a copied owner tuple', async t => {
  const f = await fenceFixture(t), manager = new XEntityManager({ _provider_runtime_context: { ...f.context, _postgresql: f.handle } });
  for (const d of f.definitions) assert.equal((await manager._register({ _params: { _app_id: 'pg73', _env: 'test', _entity: d } }))._ok, true);
  const options = { _app_id: 'pg73', _env: 'test', _entities: [{ _entity: 'effects', _write: true }], _durability_contract: 'provider-neutral-v1' };
  for (const context of [undefined, {}, f.frame, { ...f.frame }]) await assert.rejects(manager.bindLocalUnit({ ...options, ...(context ? { _owner_context: context } : {}) }),
    e => e._code === 'E_ENTITY_LOCAL_UNIT_FENCED');
});

test('real transaction-side fence kernel accepts current authority and rejects stale/wrong/revoked frames atomically', async t => {
  const f = await fenceFixture(t), p = f.make(); await p.init();
  for (const changed of [{ _epoch: '2' }, { _epoch: '01' }, { _store_id: randomUUID() }, { _owner_id: randomUUID() }, { _revoked: true }]) {
    const a = create(), b = create('receipts');
    await assert.rejects(f.run(unit(a, b), { ...f.frame, ...changed }), e => e._code === 'E_ENTITY_LOCAL_UNIT_FENCED');
    assert.equal(await p.get(a._id), null);
  }
  const a = create(), b = create('receipts'), r = await f.run(unit(a, b));
  assert.equal(r._records.length, 2); assert.equal(r._ownership._epoch, '1'); assert.equal((await p.get(a._id)).amount, 1);
});

for (const revoke of [false, true]) test(`exclusive owner handover waits for in-flight unit; known revocation=${revoke}`, async t => {
  const f = await fenceFixture(t), held = latch(), release = latch(), a = create(), b = create('receipts');
  const old = f.run(unit(a, b), f.frame, async client => { held.resolve(client.processID); await release.promise; });
  const oldPid = await held.promise;
  await f.owner.query('SELECT pg_advisory_unlock_all()');
  const next = await f.client('owner'), newOwner = randomUUID();
  assert.equal((await next.query('SELECT pg_try_advisory_lock(hashtextextended(current_database() || $1,0)) AS acquired', [f.key])).rows[0].acquired, true);
  await next.query('BEGIN');
  let advanced = false;
  const transition = next.query('SELECT epoch FROM xpell73.ep_fence WHERE singleton=TRUE FOR UPDATE').then(async () => {
    await next.query('UPDATE xpell73.ep_fence SET owner_id=$1,epoch=2 WHERE singleton=TRUE', [newOwner]); await next.query('COMMIT'); advanced = true;
  });
  await waitFor(t, async () => (await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [next.processID])).rowCount === 1);
  assert.equal(advanced, false); assert.notEqual(oldPid, next.processID);
  if (revoke) f.frame._revoked = true;
  const oldOutcome = old.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
  release.resolve(); const outcome = await oldOutcome; await transition;
  assert.equal(outcome.ok, !revoke); assert.equal(advanced, true);
  const p = f.make(); await p.init(); assert.equal((await p.get(a._id)) !== null, !revoke);
  await assert.rejects(f.run(unit(create()), { ...f.frame, _revoked: false }), e => e._code === 'E_ENTITY_LOCAL_UNIT_FENCED');
  const r = await f.run(unit(create()), { ...f.frame, _owner_id: newOwner, _epoch: '2', _revoked: false }); assert.equal(r._ownership._epoch, '2');
});

test('shared ownership barrier permits independent units to finish concurrently', async t => {
  const f = await fenceFixture(t), held = latch(), release = latch();
  const a = f.run(unit(create()), f.frame, async () => { held.resolve(); await release.promise; }); await held.promise;
  const b = await f.run(unit(create())); assert.equal(b._records.length, 1); release.resolve(); await a;
});

for (const alteration of ['unlogged', 'constraint', 'privilege', 'missing']) test(`fence metadata verification rejects ${alteration} protection drift`, async t => {
  const f = await fenceFixture(t), p = f.make(); await p.init();
  if (alteration === 'unlogged') await f.owner.query('ALTER TABLE xpell73.ep_fence SET UNLOGGED');
  if (alteration === 'constraint') await f.owner.query('ALTER TABLE xpell73.ep_fence DROP CONSTRAINT ep_fence_lock_anchor_check');
  if (alteration === 'privilege') await f.owner.query(`GRANT UPDATE(epoch) ON xpell73.ep_fence TO "${f.role}"`);
  if (alteration === 'missing') await f.owner.query('DROP TABLE xpell73.ep_fence');
  await assert.rejects(p.count()); await assert.rejects(f.run(unit(create())));
});

test('metadata v2 to v3 interruption rolls back actual DDL and preserves exact source version', async t => {
  const f = await fixture(t, [unitDefinition('effects')]);
  await migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 });
  const options = { ...f.maintenance, _connection: { ...f.maintenance._connection, _expected_schema_version: 2 }, _from_version: 2, _to_version: 3 };
  const original = Client.prototype.query; let ddl = false;
  Client.prototype.query = async function(sql, ...args) { const r = await original.call(this, sql, ...args);
    if (typeof sql === 'string' && sql.startsWith('CREATE TABLE "xpell73"."ep_fence"')) { ddl = true; throw new Error('synthetic failure after actual DDL'); } return r; };
  try { await assert.rejects(migratePostgreSQLStore(options)); } finally { Client.prototype.query = original; }
  assert.equal(ddl, true); const owner = await f.client('owner');
  assert.equal((await owner.query("SELECT to_regclass('xpell73.ep_fence') AS name")).rows[0].name, null);
  assert.equal((await owner.query('SELECT schema_version FROM xpell73.ep_store')).rows[0].schema_version, 2);
  assert.equal((await owner.query('SELECT count(*) FROM xpell73.ep_migrations')).rows[0].count, '2');
  assert.equal((await migratePostgreSQLStore(options))._schema_version, 3);
});

test('owner epoch larger than Number.MAX_SAFE_INTEGER is compared exactly without rounding', async t => {
  const f = await fenceFixture(t), epoch = '9007199254740993';
  await f.owner.query('UPDATE xpell73.ep_fence SET epoch=$1 WHERE singleton=TRUE', [epoch]);
  const r = await f.run(unit(create()), { ...f.frame, _epoch: epoch }); assert.equal(r._ownership._epoch, epoch);
  await assert.rejects(f.run(unit(create()), { ...f.frame, _epoch: '9007199254740992' }), e => e._code === 'E_ENTITY_LOCAL_UNIT_FENCED');
});
