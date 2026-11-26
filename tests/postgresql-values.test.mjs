import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, simpleDefinition, scopeIdentity, isPGError } from './postgresql-fixture.mjs';
import { SQLiteEntityProvider } from '../dist/XEntityManager/SQLiteEntityProvider.js';
import { sqliteStringKey, projected, prepareRecord, quote } from '../dist/XEntityManager/PostgreSQLValues.js';
import { recordDDL } from '../dist/XEntityManager/PostgreSQLSchema.js';

async function sqlite(t, definition) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pg73-sqlite-'));
  const d = { ...definition, _storage: { ...definition._storage, _provider: 'sqlite' } }, identity = { ...scopeIdentity(d), _provider: 'sqlite' };
  const provider = new SQLiteEntityProvider({ _definition: d, _physical_identity: identity, _runtime_context: { _work_folder: work } });
  await provider.init(); t.after(async () => { await provider.dispose(); await fs.rm(work, { recursive: true, force: true }); }); return provider;
}
export async function nativeInsert(client, layout, record, schema = 'xpell73') {
  const columns = ['_row_key', '_json', ...layout._fields.map(f => f._column)];
  const values = [randomUUID(), JSON.stringify(record), ...layout._fields.map(f => projected(f, record[f._name]))];
  return client.query(`INSERT INTO ${quote(schema)}.${quote(layout._table)} (${columns.map(quote).join(',')}) VALUES(${values.map((_, i) => '$' + (i + 1)).join(',')})`, values);
}

test('string projection matches native SQLite for well-formed Unicode and embedded NUL', () => {
  const db = new Database(':memory:');
  try {
    for (const value of ['', '\0', 'a\0b', 'שלום', '😀', '\ufffd']) {
      assert.equal(sqliteStringKey(value).toString('hex').toUpperCase(), db.prepare('SELECT hex(?) AS hex').get(value).hex);
    }
  } finally { db.close(); }
});

// Explicit owner-approved exception: SQLite's native lone-surrogate encoding differs
// across Node22/24. Retain this assertion as deferred evidence, not a compatibility PASS.
test('DEFERRED: SQLite parity for unpaired UTF-16 surrogate keys', {
  skip: 'Owner-approved deferral on 2026-11-25; see PostgreSQL provider contract: Unicode compatibility exception'
}, () => {
  const db = new Database(':memory:');
  try {
    for (const value of ['\ud800', '\udc00', 'a\ud800z']) {
      assert.equal(sqliteStringKey(value).toString('hex').toUpperCase(), db.prepare('SELECT hex(?) AS hex').get(value).hex);
    }
  } finally { db.close(); }
});

test('PostgreSQL fixed string codec preserves unpaired surrogates independently of Node version', () => {
  for (const [value, hex] of [['\ud800', 'eda080'], ['\udc00', 'edb080'], ['\ufffd', 'efbfbd'], ['a\ud800z', '61eda0807a']]) {
    assert.equal(sqliteStringKey(value).toString('hex'), hex);
  }
});

test('real PostgreSQL preserves distinct exceptional Unicode IDs/values, exact uniqueness and restart reads', async t => {
  const f = await fixture(t), p = f.make(); await p.init();
  const values = ['\ud800', '\udc00', '\ufffd', 'a\ud800z', 'a\ufffdz'];
  for (const name of values) {
    const row = await p.add({ _id: 'id-' + name, name });
    assert.equal(row.name, name); assert.equal((await p.get('id-' + name)).name, name);
    assert.deepEqual((await p.find({ name }))._data.map(r => r._id), ['id-' + name]);
    await assert.rejects(p.add({ name }), isPGError('CONSTRAINT'));
  }
  await assert.rejects(p.update({ _id: 'id-\ud800' }, { name: '\ufffd' }), isPGError('CONSTRAINT'));
  assert.deepEqual((await p.find({}, { _sort: { _sort_by: 'name' } }))._data.map(r => r.name),
    ['a\ud800z', 'a\ufffdz', '\ud800', '\udc00', '\ufffd']);
  await p.dispose(); await f.handle.close();
  const reopened = f.make(f.definitions[0], f.runtime()); await reopened.init();
  for (const name of values) assert.equal((await reopened.get('id-' + name)).name, name);
  assert.equal(await reopened.count(), values.length);
});

test('real PostgreSQL and SQLite preserve JSON, dates, null/absent and well-formed Unicode keys', async t => {
  const def = simpleDefinition('values', { details: { _type: 'Object' }, items: { _type: 'Array' }, when: { _type: 'Date', _index: true } });
  const f = await fixture(t, [def]), pg = f.make(); await pg.init(); const sq = await sqlite(t, def);
  const names = ['', 'A', 'a', 'a\0b', 'שלום', '😀', '\ufffd'];
  for (let i = 0; i < names.length; i++) {
    const input = { _id: 'legacy-' + i, _created_at: '2020-01-01T00:00:00.000Z', _updated_at: '2020-01-01T00:00:00.000Z',
      name: names[i], score: i === 0 ? 0 : 1.5, active: i % 2, when: '2026-01-01T03:00:00+03:00',
      details: { z: 1, a: [true, null, { value: '\ud800\0' }] }, items: [3, 'x'], ...(i === 0 ? { note: null } : {}) };
    const a = await pg.add(input), b = await sq.add(input);
    assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.deepEqual(await pg.get(a._id), b);
  }
  for (const order of ['asc', 'desc']) {
    const options = { _sort: { _sort_by: 'name', _sort_order: order } };
    assert.deepEqual((await pg.find({}, options))._data.map(r => r._id), (await sq.find({}, options))._data.map(r => r._id));
  }
  for (const filter of [{ name: '\ufffd' }, { name: { _in: [null, '😀'] } }, { score: { _in: [null] } }, { note: null }, { when: { _gte: '2026-01-01' } }]) {
    assert.deepEqual((await pg.find(filter, { _sort: { _sort_by: '_id' } }))._data, (await sq.find(filter, { _sort: { _sort_by: '_id' } }))._data);
  }
  assert.equal(Object.hasOwn(await pg.get('legacy-1'), 'note'), false);
  assert.equal((await pg.get('legacy-0')).note, null);
});

test('long indexed strings and legacy IDs exceed B-tree entry size without truncation or false uniqueness', async t => {
  const f = await fixture(t), p = f.make(); await p.init();
  const long = Array.from({ length: 256 }, (_, i) => createHash('sha256').update('synthetic-long-key-' + i).digest('hex')).join('');
  const first = await p.add({ _id: long, name: long, note: null });
  await p.add({ _id: long + 'b', name: long + 'b' });
  assert.deepEqual(await p.get(long), first);
  assert.equal((await p.find({ name: long }))._data.length, 1);
  await assert.rejects(p.add({ name: long }), isPGError('CONSTRAINT'));
  const owner = await f.client('owner'), layout = f.inventory._layouts[0];
  await assert.rejects(owner.query(`CREATE INDEX too_long_proof ON xpell73.${quote(layout._table)} (${quote(layout._fields.find(f => f._name === 'name')._column)})`), e => e.code === '54000');
  assert.equal(await p.count(), 2);
});

test('concurrent duplicate insert has exactly one committed effect across real pool connections', async t => {
  const f = await fixture(t), p = f.make(); await p.init();
  const result = await Promise.allSettled([p.add({ name: 'same' }), p.add({ name: 'same' })]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const error = result.find(r => r.status === 'rejected').reason;
  assert.ok(['E_ENTITY_POSTGRESQL_CONFLICT', 'E_ENTITY_POSTGRESQL_CONSTRAINT'].includes(error._code));
  assert.equal(await p.count(), 1);
});

test('native constraint guard compares full values even with an injected constant digest', async t => {
  const f = await fixture(t), owner = await f.client('owner'), layout = f.inventory._layouts[0];
  await owner.query('CREATE SCHEMA collision');
  await owner.query("CREATE FUNCTION collision.constant_digest(bytea) RETURNS bytea IMMUTABLE STRICT LANGUAGE sql RETURN decode(repeat('00',32),'hex')");
  for (const sql of recordDDL('collision', layout)) await owner.query(sql.replaceAll('pg_catalog.sha256', 'collision.constant_digest'));
  await owner.query(`GRANT USAGE ON SCHEMA collision TO ${quote(f.role)}; GRANT SELECT,INSERT,UPDATE,DELETE ON collision.${quote(layout._table)} TO ${quote(f.role)}`);
  const a = await f.client(), b = await f.client();
  const insert = async (client, name) => { await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try { await nativeInsert(client, layout, await prepareRecord(layout, { name }), 'collision'); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK'); throw e; } };
  await insert(a, 'one'); await insert(b, 'two');
  await assert.rejects(insert(a, 'one'), e => e.code === '23505');
  assert.equal((await a.query(`SELECT count(*) FROM collision.${quote(layout._table)}`)).rows[0].count, '2');
  // Force both absent-value checks before either COMMIT; SSI must abort a duplicate writer.
  await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await Promise.all([nativeInsert(a, layout, await prepareRecord(layout, { name: 'three' }), 'collision'), nativeInsert(b, layout, await prepareRecord(layout, { name: 'three' }), 'collision')]);
  const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, '40001');
  await a.query('ROLLBACK'); await b.query('ROLLBACK');
  assert.equal((await a.query(`SELECT count(*) FROM collision.${quote(layout._table)}`)).rows[0].count, '3');
});

test('Hash normalization/defaults, bounded verification and redaction', async t => {
  const def = simpleDefinition('hash', { password: { _type: 'Hash', _required: true }, backup: { _type: 'Hash', _default: 'default-synthetic' } });
  const f = await fixture(t, [def]), p = f.make(); await p.init();
  const row = await p.add({ name: 'hash', password: 'synthetic-secret' });
  assert.equal(await bcrypt.compare('synthetic-secret', row.password), true);
  assert.equal(await bcrypt.compare('default-synthetic', row.backup), true);
  const verified = await p.applyHashFilter(await p.find(), { password: 'synthetic-secret' });
  assert.equal(verified._data.length, 1); assert.equal(Object.hasOwn(verified._data[0], 'password'), false); assert.equal(Object.hasOwn(verified._data[0], 'backup'), false);
  assert.equal((await p.applyHashFilter(await p.find(), { password: 'wrong' }))._data.length, 0);
  await assert.rejects(p.applyHashFilter({ _data: Array(26).fill(row) }, { password: 'synthetic-secret' }), isPGError('HASH_FILTER_UNBOUNDED'));
  const hash = await bcrypt.hash('new-synthetic', 10); await p.update({ _id: row._id }, { password: hash }); assert.equal((await p.get(row._id)).password, hash);
});

test('PG tied sort pages have an explicit ID order; SQLite source remains unchanged', async t => {
  const f = await fixture(t), p = f.make(); await p.init();
  for (const id of ['z', 'a', 'm']) await p.add({ _id: id, _created_at: '2020-01-01', name: id, score: 10 });
  assert.deepEqual((await p.find({}, { _limit: 2 }))._data.map(r => r._id), ['a', 'm']);
  assert.deepEqual((await p.find({}, { _skip: 2, _limit: 2 }))._data.map(r => r._id), ['z']);
  assert.deepEqual((await p.find({}, { _sort: { _sort_by: 'score', _sort_order: 'desc' } }))._data.map(r => r._id), ['z', 'm', 'a']);
  assert.equal((await p.find({}, { _limit: 0 }))._meta._total_records, 3);
});
