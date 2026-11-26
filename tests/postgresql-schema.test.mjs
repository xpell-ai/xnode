import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { fixture, simpleDefinition, isPGError } from './postgresql-fixture.mjs';
import { initializePostgreSQLStore, migratePostgreSQLStore } from '../dist/XEntityManager/PostgreSQLSchema.js';
import { quote, layoutFor } from '../dist/XEntityManager/PostgreSQLValues.js';

test('invalid protection/index flags and non-string identity schemas reject explicitly', () => {
  const mutations = [d => { d._storage._append_only = 'true'; }, d => { d._schema.name._immutable = 'true'; },
    d => { d._schema.name._required = 'true'; }, d => { d._schema.name._index = { _unique: 'true' }; },
    d => { d._schema.name._index = { _compound: ['name', 'score'] }; }, d => { d._schema._id = { _type: 'Number' }; }];
  for (const change of mutations) { const d = simpleDefinition(); change(d); assert.throws(() => layoutFor(d, 'synthetic'), isPGError('SCHEMA_UNSUPPORTED')); }
});

test('ordinary init refuses missing schema; explicit bootstrap is authorized, transactional and nonrepeatable', async t => {
  const f = await fixture(t, [simpleDefinition()], { uninitialized: true }), p = f.make();
  await assert.rejects(p.init());
  const owner = await f.client('owner');
  assert.equal((await owner.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', ['xpell73'])).rowCount, 0);
  await assert.rejects(initializePostgreSQLStore({ ...f.maintenance, _authorize_empty_store: false }), isPGError('INITIALIZATION_AUTHORITY'));
  await initializePostgreSQLStore(f.maintenance); await p.init();
  await p.add({ name: 'persisted' }); await p.dispose();
  const reopened = f.make(); await reopened.init(); assert.equal(await reopened.count(), 1);
  await assert.rejects(initializePostgreSQLStore(f.maintenance), isPGError('TARGET_NOT_EMPTY'));
});

test('wrong expected UUID/inventory and changed logical schema refuse without replacement tables', async t => {
  const f = await fixture(t), options = structuredClone(f.runtimeOptions);
  options._connections.primary._expected_store_id = randomUUID();
  await assert.rejects(f.make(f.definitions[0], f.runtime(options)).init(), isPGError('STORE_IDENTITY'));
  options._connections.primary._expected_store_id = f.connection._expected_store_id;
  options._connections.primary._expected_inventory_sha256 = 'a'.repeat(64);
  await assert.rejects(f.make(f.definitions[0], f.runtime(options)).init(), isPGError('STORE_IDENTITY'));
  const changed = structuredClone(f.definitions[0]); changed._schema.extra = { _type: 'String' };
  await assert.rejects(f.make(changed).init(), isPGError('SCHEMA_MISMATCH'));
  const p = f.make(); await p.init(); await assert.rejects(p.syncSchema(changed), isPGError('SCHEMA_MISMATCH'));
  assert.equal(await p.count(), 0);
});

test('native append-only/immutable and restricted runtime role survive direct SQL attempts', async t => {
  const definition = simpleDefinition('history'); definition._storage._append_only = true;
  const f = await fixture(t, [definition]), p = f.make(); await p.init();
  const row = await p.add({ name: 'immutable' });
  await assert.rejects(p.update({ _id: row._id }, { name: 'changed' }), isPGError('APPEND_ONLY'));
  await assert.rejects(p.delete({ _id: row._id }), isPGError('APPEND_ONLY'));
  const downgraded = structuredClone(definition); downgraded._storage._append_only = false;
  await assert.rejects(f.make(downgraded).init(), isPGError('SCHEMA_MISMATCH'));
  const c = await f.client(), owner = await f.client('owner'), table = 'xpell73.' + quote(f.inventory._layouts[0]._table);
  for (const sql of [`TRUNCATE ${table}`, `DELETE FROM ${table}`, `ALTER TABLE ${table} DISABLE TRIGGER ALL`, 'CREATE TABLE xpell73.bypass(a int)', 'CREATE TEMP TABLE bypass(a int)']) {
    await assert.rejects(c.query(sql), e => e.code === '42501');
  }
  await owner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await assert.rejects(owner.query(`DELETE FROM ${table}`), e => e.code === 'P0001'); await owner.query('ROLLBACK');
  assert.equal(await p.count(), 1);
});

test('removed native constraint trigger refuses readiness without automatic repair', async t => {
  const f = await fixture(t), p = f.make(); await p.init(); const owner = await f.client('owner');
  await owner.query(`DROP TRIGGER ep_unique_guard ON xpell73.${quote(f.inventory._layouts[0]._table)}`);
  await assert.rejects(p.count(), isPGError('SCHEMA_MISMATCH'));
  await assert.rejects(f.make().init(), isPGError('SCHEMA_MISMATCH'));
});

test('partial entity inventory refuses readiness and is never reconstructed on boot', async t => {
  const f = await fixture(t), owner = await f.client('owner');
  await owner.query('DELETE FROM xpell73.ep_entities');
  await assert.rejects(f.make().init(), isPGError('SCHEMA_MISMATCH'));
  assert.equal((await owner.query('SELECT count(*) FROM xpell73.ep_entities')).rows[0].count, '0');
});

test('explicit initialization refuses pre-existing non-table user objects and unsafe runtime roles', async t => {
  const f = await fixture(t, [simpleDefinition()], { uninitialized: true }), owner = await f.client('owner');
  await owner.query("CREATE FUNCTION public.preexisting() RETURNS integer LANGUAGE sql RETURN 1");
  await assert.rejects(initializePostgreSQLStore(f.maintenance), isPGError('TARGET_NOT_EMPTY'));
  assert.equal((await owner.query("SELECT 1 FROM pg_namespace WHERE nspname='xpell73'")).rowCount, 0);
  await owner.query('DROP FUNCTION public.preexisting()');
  await assert.rejects(initializePostgreSQLStore({ ...f.maintenance, _runtime_role: f.owner }), isPGError('ROLE'));
  await initializePostgreSQLStore(f.maintenance);
});

test('native initialization snapshots the authorized identity before asynchronous connection setup', async t => {
  const f = await fixture(t, [simpleDefinition()], { uninitialized: true });
  const options = structuredClone(f.maintenance), original = options._connection._expected_store_id;
  const pending = initializePostgreSQLStore(options);
  options._connection._expected_store_id = randomUUID(); options._runtime_role = f.owner;
  const receipt = await pending; assert.equal(receipt._store_id, original);
  const p = f.make(); await p.init(); assert.equal(await p.count(), 0);
});

test('compatible versioned migration rolls back interrupted DDL and requalifies only the expected new version', async t => {
  const f = await fixture(t), p = f.make(); await p.init(); await p.add({ name: 'survives' });
  const original = Client.prototype.query;
  Client.prototype.query = function(...args) {
    const result = original.apply(this, args);
    if (typeof args[0] === 'string' && args[0].includes('ADD COLUMN description')) return Promise.resolve(result).then(() => { throw new Error('synthetic interruption after actual DDL'); });
    return result;
  };
  try { await assert.rejects(migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 })); }
  finally { Client.prototype.query = original; }
  const owner = await f.client('owner');
  assert.equal((await owner.query('SELECT schema_version FROM xpell73.ep_store')).rows[0].schema_version, 1);
  assert.equal((await owner.query("SELECT 1 FROM information_schema.columns WHERE table_schema='xpell73' AND table_name='ep_migrations' AND column_name='description'")).rowCount, 0);
  assert.equal(await p.count(), 1);
  await migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 });
  await assert.rejects(p.count(), isPGError('STORE_IDENTITY'));
  const options = structuredClone(f.runtimeOptions); options._connections.primary._expected_schema_version = 2;
  const upgraded = f.make(f.definitions[0], f.runtime(options)); await upgraded.init(); assert.equal(await upgraded.count(), 1);
  await assert.rejects(migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 }), isPGError('MIGRATION_MISMATCH'));
  await owner.query("UPDATE xpell73.ep_migrations SET checksum='corrupt' WHERE version=2");
  await assert.rejects(upgraded.count(), isPGError('MIGRATION_MISMATCH'));
});

test('lost migration COMMIT acknowledgement reports uncertainty without rerunning an applied upgrade', async t => {
  const f = await fixture(t), original = Client.prototype.query;
  Client.prototype.query = function(...args) {
    const result = original.apply(this, args);
    if (args[0] === 'COMMIT') return Promise.resolve(result).then(() => { throw new Error('synthetic acknowledgement loss after real commit'); });
    return result;
  };
  try { await assert.rejects(migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 }), isPGError('WRITE_UNCERTAIN')); }
  finally { Client.prototype.query = original; }
  const owner = await f.client('owner');
  assert.equal((await owner.query('SELECT schema_version FROM xpell73.ep_store')).rows[0].schema_version, 2);
  await assert.rejects(migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 }), isPGError('MIGRATION_MISMATCH'));
});
