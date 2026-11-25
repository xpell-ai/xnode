import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { fixture, simpleDefinition, isPGError } from './postgresql-fixture.mjs';
import { quote, definitionDigest } from '../dist/XEntityManager/PostgreSQLValues.js';

async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await delay(10); } assert.fail('bounded fixture condition not reached'); }

test('entities and identical aliases share one pool; opaque handles expose no clients or SQL callbacks', async t => {
  const f = await fixture(t, [simpleDefinition('one'), simpleDefinition('two')]);
  const options = structuredClone(f.runtimeOptions); options._connections.alias = structuredClone(options._connections.primary);
  options._placements = [{ _app_id: 'pg73', _env: 'test', _entities: ['one'], _connection: 'primary' }, { _app_id: 'pg73', _env: 'test', _entities: ['two'], _connection: 'alias' }];
  const handle = f.runtime(options), a = f.make(f.definitions[0], handle), b = f.make(f.definitions[1], handle);
  await Promise.all([a.init(), b.init()]);
  options._connections.primary._expected_store_id = 'mutated'; options._placements[0]._entities.length = 0;
  assert.equal(await a.count(), 0);
  assert.equal(handle.diagnostics()._stores.length, 1);
  assert.equal(handle.transaction, undefined); assert.equal(handle.withClient, undefined); assert.equal(handle.pool, undefined);
  assert.equal(JSON.stringify(handle).includes(f.password), false);
  await a.dispose(); await b.add({ name: 'sibling' }); assert.equal(await b.count(), 1);
});

test('trusted legacy placement preserves original artifact/schema while rejecting conflicting overrides', async t => {
  const definition = simpleDefinition(); definition._storage._provider = 'sqlite';
  const f = await fixture(t, [definition]);
  const options = structuredClone(f.runtimeOptions);
  options._placements[0]._accepted_artifact_provider = 'sqlite';
  options._placements[0]._definition_sha256 = { records: definitionDigest(definition) };
  const p = f.make(definition, f.runtime(options)); await p.init();
  assert.equal(p.getSchema()._storage._provider, 'sqlite'); assert.equal(p.getPhysicalIdentity()._provider, 'postgresql');
  await p.add({ name: 'same logical definition' });
  const changed = structuredClone(definition); changed._schema.name._max_length = 10;
  assert.throws(() => f.make(changed, f.runtime(options)), isPGError('PLACEMENT'));
});

test('trusted placement can select PG for a default-xdb artifact without adding or rewriting storage metadata', async t => {
  const definition = simpleDefinition(); delete definition._storage;
  const f = await fixture(t, [definition]), options = structuredClone(f.runtimeOptions);
  options._placements[0]._accepted_artifact_provider = 'xdb'; options._placements[0]._definition_sha256 = { records: definitionDigest(definition) };
  const p = f.make(definition, f.runtime(options)); await p.init();
  assert.equal(Object.hasOwn(p.getSchema(), '_storage'), false);
  await p.add({ name: 'explicit native placement' }); assert.equal(await p.count(), 1);
});

test('bounded queue, lock/acquisition deadlines and recovery release all requests', async t => {
  const f = await fixture(t, [simpleDefinition()], { connection: { _pool: { _max: 1, _max_waiting: 1 }, _timeouts: { _acquire_ms: 200, _connect_ms: 200, _statement_ms: 500, _lock_ms: 120 } } });
  const p = f.make(); await p.init(); const owner = await f.client('owner');
  await owner.query('BEGIN'); await owner.query(`LOCK TABLE xpell73.${quote(f.inventory._layouts[0]._table)} IN ACCESS EXCLUSIVE MODE`);
  const a = p.count(), b = p.count();
  const settled = Promise.allSettled([a, b]); // Attach rejection handlers before intentionally blocking.
  await until(() => f.handle.diagnostics()._stores[0]._admitted === 2);
  await assert.rejects(p.count(), isPGError('POOL_SATURATED'));
  const results = await settled; assert.ok(results.every(r => r.status === 'rejected'));
  await owner.query('ROLLBACK');
  await until(() => f.handle.diagnostics()._stores[0]._admitted === 0);
  assert.equal(await p.count(), 0); assert.equal(f.handle.diagnostics()._stores[0]._waiting, 0);
});

test('late checkout after acquisition timeout is destroyed and never leaks a client', async t => {
  const f = await fixture(t, [simpleDefinition()], { connection: { _timeouts: { _acquire_ms: 70, _connect_ms: 70, _statement_ms: 1000 } } });
  const original = Client.prototype.query;
  Client.prototype.query = function(...args) {
    if (typeof args[0] === 'string' && args[0].startsWith("SELECT set_config('search_path'")) return delay(180).then(() => original.apply(this, args));
    return original.apply(this, args);
  };
  try { await assert.rejects(f.make().init(), isPGError('TIMEOUT')); }
  finally { Client.prototype.query = original; }
  assert.equal(f.handle.diagnostics()._stores[0]._total, 0, 'timed-out checkout must destroy its already-connected client immediately');
  await until(() => f.handle.diagnostics()._stores[0]._admitted === 0);
  assert.equal(f.handle.diagnostics()._stores[0]._total, 0);
  const p = f.make(); await p.init(); assert.equal(await p.count(), 0);
});

test('idle connection loss is handled and a replacement connection rechecks store identity', async t => {
  const f = await fixture(t), p = f.make(); await p.init(); await p.add({ name: 'kept' });
  const pid = (await f.admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND state=$3', [f.db, f.role, 'idle'])).rows[0].pid;
  await f.admin.query('SELECT pg_terminate_backend($1)', [pid]);
  await until(() => f.handle.diagnostics()._stores[0]._idle_errors > 0);
  assert.equal(await p.count(), 1);
  const owner = await f.client('owner'); await owner.query("UPDATE xpell73.ep_store SET store_id='wrong-store'");
  await assert.rejects(p.count(), isPGError('STORE_IDENTITY'));
});

test('connection loss between actual writes rolls back; lost COMMIT acknowledgement is uncertain', async t => {
  const f = await fixture(t), p = f.make(); await p.init();
  const a = await p.add({ name: 'a', score: 1 }), b = await p.add({ name: 'b', score: 1 });
  const original = Client.prototype.query; let interrupted = false;
  Client.prototype.query = function(...args) {
    const result = original.apply(this, args);
    if (!interrupted && typeof args[0] === 'string' && args[0].startsWith('UPDATE "xpell73"."ep_')) {
      interrupted = true;
      return Promise.resolve(result).then(async () => { await f.admin.query('SELECT pg_terminate_backend($1)', [this.processID]); throw new Error('synthetic precommit connection loss'); });
    }
    return result;
  };
  try { await assert.rejects(p.update({ score: 1 }, { score: 2 })); }
  finally { Client.prototype.query = original; }
  assert.deepEqual(await p.get(a._id), a); assert.deepEqual(await p.get(b._id), b);
  Client.prototype.query = function(...args) {
    const result = original.apply(this, args);
    if (args[0] === 'COMMIT') return Promise.resolve(result).then(() => { throw new Error('synthetic acknowledgement loss'); });
    return result;
  };
  try { await assert.rejects(p.add({ _id: 'uncertain', name: 'uncertain' }), isPGError('WRITE_UNCERTAIN')); }
  finally { Client.prototype.query = original; }
  assert.equal((await p.get('uncertain')).name, 'uncertain'); assert.equal(await p.count(), 3);
});

test('shutdown stops admission, drains once and bounds a stuck operation without false clean completion', async t => {
  const f = await fixture(t, [simpleDefinition()], { connection: { _timeouts: { _drain_ms: 40, _lock_ms: 2000, _statement_ms: 4000 } } });
  const p = f.make(); await p.init(); const owner = await f.client('owner');
  await owner.query('BEGIN'); await owner.query(`LOCK TABLE xpell73.${quote(f.inventory._layouts[0]._table)} IN ACCESS EXCLUSIVE MODE`);
  const pending = p.count(); const outcome = Promise.allSettled([pending]);
  await until(async () => (await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'", [f.db, f.role])).rowCount > 0);
  const closing = f.handle.close(); assert.equal(closing, f.handle.close());
  await assert.rejects(closing, isPGError('DRAIN_TIMEOUT'));
  await assert.rejects(p.add({ name: 'not admitted' }), isPGError('UNAVAILABLE'));
  assert.equal((await outcome)[0].status, 'rejected');
  await owner.query('ROLLBACK'); await until(() => f.handle.diagnostics()._stores[0]._total === 0);
});

test('configuration and driver errors are sanitized and never expose the secret URI/password', async t => {
  const f = await fixture(t); const options = structuredClone(f.runtimeOptions);
  options._connections.primary._connection_string_env = 'MISSING_SYNTHETIC_PG73';
  assert.throws(() => f.runtime(options), isPGError('CONFIG'));
  for (const invalid of [{ _pool: { _max: NaN } }, { _pool: { _max: 0 } }, { _pool: { _max: 2, _typo: 1 } }, { _tls: { _mode: 'verify', rejectUnauthorized: false } }]) {
    const bad = structuredClone(f.runtimeOptions); Object.assign(bad._connections.primary, invalid);
    assert.throws(() => f.runtime(bad), isPGError('CONFIG'));
  }
  const override = structuredClone(f.definitions[0]); override._storage._connection = 'other';
  assert.throws(() => f.make(override), isPGError('PLACEMENT'));
  const duplicate = structuredClone(f.runtimeOptions); duplicate._connections.alias = { ...duplicate._connections.primary, _schema: 'another_schema' };
  assert.throws(() => f.runtime(duplicate), isPGError('CONFIG_CONFLICT'));
  const originalSecret = process.env[f.runtimeEnv];
  process.env[f.runtimeEnv] = originalSecret + '?sslmode=no-verify';
  try { assert.throws(() => f.runtime(), isPGError('CONFIG')); } finally { process.env[f.runtimeEnv] = originalSecret; }
  process.env[f.runtimeEnv] = originalSecret.replace(f.password, 'wrong-synthetic-password');
  try {
    const p = f.make(f.definitions[0], f.runtime());
    await assert.rejects(p.init(), e => {
      const text = JSON.stringify(e) + String(e);
      assert.equal(text.includes(f.password), false); assert.equal(text.includes('postgresql://'), false);
      return isPGError('UNAVAILABLE')(e);
    });
  } finally { process.env[f.runtimeEnv] = originalSecret; }
});

test('verified TLS connects to the real pinned server; missing CA and DSN policy overrides fail closed', async t => {
  assert.ok(process.env.XPELL_PG_TEST_CA, 'Explicit synthetic test CA required');
  const f = await fixture(t), options = structuredClone(f.runtimeOptions);
  options._connections.primary._tls = { _mode: 'verify', _ca_file: process.env.XPELL_PG_TEST_CA };
  const p = f.make(f.definitions[0], f.runtime(options)); await p.init(); await p.add({ name: 'verified TLS' });
  assert.equal(await p.count(), 1);
  options._connections.primary._tls = { _mode: 'verify' };
  await assert.rejects(f.make(f.definitions[0], f.runtime(options)).init(), isPGError('UNAVAILABLE'));
  const original = process.env[f.runtimeEnv]; process.env[f.runtimeEnv] = original + '?sslmode=disable';
  try { assert.throws(() => f.runtime(options), isPGError('CONFIG')); } finally { process.env[f.runtimeEnv] = original; }
});
