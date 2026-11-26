import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simpleDefinition, isPGError } from './postgresql-fixture.mjs';
import { runEntityProviderConformanceSuite } from '../dist/XEntityManager/EntityProviderConformanceTests.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';
import { Client } from 'pg';
import { quote } from '../dist/XEntityManager/PostgreSQLValues.js';

test('real PostgreSQL runs the existing portable EntityProvider conformance suite', { timeout: 30000 }, async t => {
  const definition = { _id: 'portable', _storage: { _provider: 'postgresql', _scope: 'app' }, _schema: {
    name: { _type: 'String', _required: true, _index: { _unique: true } }, category: { _type: 'String', _required: true, _index: true },
    score: { _type: 'Number', _required: true, _index: true }, active: { _type: 'Boolean', _required: true, _index: true } } };
  const f = await fixture(t, [definition]);
  await runEntityProviderConformanceSuite({ _provider: 'postgresql', _durable: true, _definition: definition,
    _physical_identity: f.entities[0]._physical_identity, _runtime_context: f.context, _create: () => f.make() });
});

test('manager envelopes, trusted placement, capability denial and shared owner cleanup', async t => {
  const f = await fixture(t);
  const manager = new XEntityManager({ _provider_runtime_context: f.context });
  const params = { _app_id: 'pg73', _env: 'test', _entity: 'records' };
  const invoke = (op, extra = {}) => manager['_' + op]({ _params: { ...params, ...extra } });
  assert.equal((await invoke('register', { _entity: f.definitions[0] }))._ok, true);
  const added = await invoke('add', { _data: { name: 'manager', score: 3 } }); assert.equal(added._ok, true);
  assert.equal((await invoke('get', { _id: added._result._record._id }))._result._record.name, 'manager');
  assert.equal((await invoke('find'))._result._records._meta._total_records, 1);
  assert.equal((await invoke('storage_diagnostics'))._result._diagnostic._storage_provider, 'postgresql');
  assert.equal((await invoke('get_entity'))._ok, false);
  const p = f.make(); await p.init();
  for (const cap of ['transactions', 'app-local-atomic-unit', 'runtime-entity-handle', 'physical-unregister']) assert.equal(p.getCapability(cap)._supported, false);
  const unknown = simpleDefinition('unmapped');
  assert.equal((await invoke('register', { _entity: { ...unknown, _storage: { _provider: 'sqlite', _scope: 'app' } } }))._ok, false);
  assert.equal((await invoke('register', { _entity: { ...f.definitions[0], _storage: { _provider: 'sqlite', _scope: 'app' } } }))._ok, false);
  assert.equal(await p.count(), 1);
  await manager.closePostgreSQLResources(); await manager.closePostgreSQLResources();
  await assert.rejects(p.count(), isPGError('UNAVAILABLE'));
});

test('unknown fields, non-finite values, immutable/required fields fail before data changes', async t => {
  const f = await fixture(t); const p = f.make(); await p.init();
  const row = await p.add({ name: 'kept', score: 1.5 });
  for (const score of [Infinity, -Infinity, NaN, 'Infinity', '1e999']) {
    await assert.rejects(p.add({ name: 'bad', score }), isPGError('VALUE'));
    await assert.rejects(p.update({ _id: row._id }, { score }), isPGError('VALUE'));
  }
  await assert.rejects(p.add({ name: 'bad', extra: 1 }), isPGError('UNKNOWN_FIELD'));
  await assert.rejects(p.update({ _id: row._id }, { extra: 1 }), isPGError('UNKNOWN_FIELD'));
  await assert.rejects(p.add({ score: 2 }), isPGError('REQUIRED'));
  await assert.rejects(p.update({ _id: row._id }, { _id: 'changed' }));
  for (const operator of ['constructor', 'toString', '=;DROP TABLE x']) await assert.rejects(p.count({ score: { [operator]: 1 } }), isPGError('QUERY_UNSUPPORTED'));
  assert.equal(await p.count(), 1); assert.deepEqual(await p.get(row._id), row);
});

test('whole multi-record operation rolls back on uniqueness failure and native writes require SERIALIZABLE', async t => {
  const f = await fixture(t); const p = f.make(); await p.init();
  const a = await p.add({ name: 'a', score: 1 }), b = await p.add({ name: 'b', score: 2 });
  await assert.rejects(p.update({ score: { _in: [1, 2] } }, { name: 'collision' }), isPGError('CONSTRAINT'));
  assert.deepEqual(await p.get(a._id), a); assert.deepEqual(await p.get(b._id), b);
  const c = await f.client(); const table = '"xpell73"."' + f.inventory._layouts[0]._table + '"';
  await assert.rejects(c.query(`UPDATE ${table} SET _json=_json`), e => e.code === 'P0001');
  await assert.rejects(c.query(`TRUNCATE ${table}`), e => e.code === '42501');
  const id = f.inventory._layouts[0]._fields.find(f => f._name === '_id');
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await assert.rejects(c.query(`UPDATE ${table} SET ${quote(id._column)}=$1`, [Buffer.from('forbidden')]), e => e.code === 'P0001');
  await c.query('ROLLBACK');
});

test('same logical IDs and unique values remain isolated across actual app/environment tables', async t => {
  const scopes = [{ _app_id: 'one', _env: 'test' }, { _app_id: 'one', _env: 'other' }, { _app_id: 'two', _env: 'test' }];
  const defs = scopes.map(() => simpleDefinition('isolated'));
  const f = await fixture(t, defs, { entityScopes: scopes });
  for (let i = 0; i < defs.length; i++) {
    const p = f.make(defs[i], f.handle, f.entities[i]._physical_identity); await p.init();
    await p.add({ _id: 'same-legacy-id', name: 'same-unique-name', score: i });
  }
  for (let i = 0; i < defs.length; i++) {
    const p = f.make(defs[i], f.handle, f.entities[i]._physical_identity); await p.init();
    assert.equal((await p.get('same-legacy-id')).score, i); assert.equal(await p.count(), 1);
  }
});

test('provider selection retains existing registry case/whitespace normalization without rewriting the definition', async t => {
  const definition = simpleDefinition(); definition._storage._provider = ' PostGreSQL ';
  const f = await fixture(t, [definition]), p = f.make(); await p.init();
  assert.equal(p.getSchema()._storage._provider, ' PostGreSQL ');
  await p.add({ name: 'normalized provider' }); assert.equal(await p.count(), 1);
});

test('count and page share one real repeatable-read snapshot during a concurrent insert', async t => {
  const f = await fixture(t), p = f.make(), other = f.make(); await p.init(); await other.init();
  await p.add({ name: 'before' }); const original = Client.prototype.query; let inserted = false;
  Client.prototype.query = function(...args) {
    const result = original.apply(this, args);
    if (!inserted && typeof args[0] === 'string' && args[0].startsWith('SELECT count(*)::text AS total')) {
      inserted = true; return Promise.resolve(result).then(async value => { await other.add({ name: 'after' }); return value; });
    }
    return result;
  };
  let result;
  try { result = await p.find(); } finally { Client.prototype.query = original; }
  assert.equal(result._meta._total_records, 1); assert.equal(result._data.length, 1); assert.equal(result._data[0].name, 'before');
  assert.equal(await p.count(), 2);
});

test('real exact count exceeds the default 100000-row page limit without count truncation', { timeout: 90000 }, async t => {
  const f = await fixture(t, [simpleDefinition()], { connection: { _timeouts: { _statement_ms: 60000 } } });
  const p = f.make(); await p.init(); const owner = await f.client('owner'), layout = f.inventory._layouts[0];
  const fieldValue = field => field._name === '_id' ? "convert_to('bulk-'||i,'UTF8')" : field._name === 'name' ? "convert_to('name-'||i,'UTF8')"
    : ['_created_at', '_updated_at'].includes(field._name) ? "convert_to($1::text,'UTF8')" : field._name === 'score' ? '(i%100)::float8' : 'NULL';
  const columns = ['_row_key', '_json', ...layout._fields.map(f => f._column)];
  const values = ["gen_random_uuid()", "json_build_object('_id','bulk-'||i,'name','name-'||i,'score',i%100,'_created_at',$1::text,'_updated_at',$1::text)::text", ...layout._fields.map(fieldValue)];
  await owner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await owner.query("SET LOCAL statement_timeout='60s'; SET LOCAL enable_seqscan=off");
    await owner.query({ text: `INSERT INTO xpell73.${quote(layout._table)}(${columns.map(quote).join(',')}) SELECT ${values.join(',')} FROM generate_series(1,100003) i`, values: ['2020-01-01T00:00:00.000Z'], query_timeout: 65000 });
    await owner.query('COMMIT');
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
  assert.equal(await p.count({ score: { _gte: 0 } }), 100003);
  const result = await p.find(); assert.equal(result._meta._total_records, 100003); assert.equal(result._data.length, 100000);
  assert.equal((await p.find({}, { _skip: 100000 }))._data.length, 3);
});
