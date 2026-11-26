import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, simpleDefinition, isPGError } from './postgresql-fixture.mjs';
import { quote, definitionDigest } from '../dist/XEntityManager/PostgreSQLValues.js';

for (const name of ['ep_write_guard', 'ep_unique_guard']) for (const mode of ['DISABLE', 'ENABLE REPLICA', 'ENABLE ALWAYS']) {
  test(`maintenance ${mode} of ${name} fails closed for new and initialized providers`, async t => {
    const f = await fixture(t), p = f.make(); await p.init(); const owner = await f.client('owner');
    await owner.query(`ALTER TABLE xpell73.${quote(f.inventory._layouts[0]._table)} ${mode} TRIGGER ${name}`);
    await assert.rejects(f.make().init(), isPGError('SCHEMA_MISMATCH'));
    await assert.rejects(p.count(), isPGError('SCHEMA_MISMATCH'));
    await assert.rejects(p.add({ name: 'must-not-commit' }), isPGError('SCHEMA_MISMATCH'));
    assert.equal((await owner.query(`SELECT count(*)::int AS total FROM xpell73.${quote(f.inventory._layouts[0]._table)}`)).rows[0].total, 0);
  });
}

for (const target of ['entity', 'ep_store', 'ep_migrations', 'ep_entities']) {
  test(`maintenance SET UNLOGGED on ${target} fails closed`, async t => {
    const f = await fixture(t), p = f.make(); await p.init(); const owner = await f.client('owner');
    const table = target === 'entity' ? f.inventory._layouts[0]._table : target;
    await owner.query(`ALTER TABLE xpell73.${quote(table)} SET UNLOGGED`);
    await assert.rejects(f.make().init(), isPGError('SCHEMA_MISMATCH'));
    await assert.rejects(p.count(), isPGError('SCHEMA_MISMATCH'));
  });
}

test('failed concurrent rebuild leaves a required index invalid despite identical index DDL', async t => {
  const def = simpleDefinition(); def._schema.score._index = { _unique: true };
  const f = await fixture(t, [def]), p = f.make(); await p.init();
  await p.add({ name: 'one', score: 1 }); const second = await p.add({ name: 'two', score: 2 });
  const owner = await f.client('owner'), table = f.inventory._layouts[0]._table;
  const field = f.inventory._layouts[0]._fields.find(f => f._name === 'score');
  const index = (await owner.query("SELECT ci.relname,pg_get_indexdef(i.indexrelid) AS ddl FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=to_regclass($1) AND pg_get_indexdef(i.indexrelid) LIKE $2", ['xpell73.' + quote(table), '%' + field._column + '%'])).rows[0];
  await owner.query(`DROP INDEX xpell73.${quote(index.relname)}`);
  await owner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await owner.query(`UPDATE xpell73.${quote(table)} SET ${quote(field._column)}=1,_json=$1 WHERE ${quote(field._column)}=2`, [JSON.stringify({ ...second, score: 1 })]);
  await owner.query('COMMIT');
  await assert.rejects(owner.query(index.ddl.replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX CONCURRENTLY ')), e => e.code === '23505');
  const state = (await owner.query('SELECT indisvalid,indisready,pg_get_indexdef(indexrelid) AS ddl FROM pg_index WHERE indexrelid=to_regclass($1)', ['xpell73.' + quote(index.relname)])).rows[0];
  assert.equal(state.indisvalid, false); assert.equal(state.indisready, false); assert.equal(state.ddl, index.ddl);
  await assert.rejects(f.make().init(), isPGError('SCHEMA_MISMATCH'));
  await assert.rejects(p.count(), isPGError('SCHEMA_MISMATCH'));
});

async function startup(t, f, input = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pg73-startup-'));
  const child = fork(new URL('./postgresql-startup-worker.mjs', import.meta.url), [], { execPath: process.execPath,
    execArgv: ['--import', new URL('./postgresql-network-guard.mjs', import.meta.url).href],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', XPELL_PG_TEST_PORT: process.env.XPELL_PG_TEST_PORT, [f.runtimeEnv]: process.env[f.runtimeEnv] },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000); });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); await exited; await rm(work, { recursive: true, force: true }); });
  let timer;
  try {
    const response = once(child, 'message');
    child.send({ work, runtime: f.runtimeOptions, definition: f.definitions[0], ...input });
    const [message] = await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup worker deadline: ' + stderr)), 15000); })]);
    assert.equal(message.error, undefined, stderr); const [code] = await exited; assert.equal(code, 0); return message.result;
  } finally { clearTimeout(timer); }
}

for (const failure of ['unavailable', 'wrong-store', 'incompatible-schema']) {
  test(`real XNode rejects startup after required PG registration fails: ${failure}`, { timeout: 20000 }, async t => {
    const f = await fixture(t), options = structuredClone(f.runtimeOptions);
    if (failure === 'unavailable') await f.admin.query(`ALTER DATABASE ${quote(f.db)} ALLOW_CONNECTIONS false`);
    if (failure === 'wrong-store') options._connections.primary._expected_store_id = randomUUID();
    if (failure === 'incompatible-schema') {
      const owner = await f.client('owner'); await owner.query(`ALTER TABLE xpell73.${quote(f.inventory._layouts[0]._table)} ADD COLUMN incompatible text`);
    }
    const result = await startup(t, f, { runtime: options });
    assert.deepEqual(result, { rejected: true, started: false, ready: false, startedEvents: 0,
      coreRunning: false, listening: false, stopped: true, poolClosed: true });
  });
}

test('real XNode loads a healthy explicitly configured PG application', { timeout: 20000 }, async t => {
  const f = await fixture(t), result = await startup(t, f);
  assert.deepEqual(result, { rejected: false, started: true, ready: true, startedEvents: 1,
    coreRunning: true, listening: true, stopped: true, poolClosed: true });
});

for (const missing of ['omitApp', 'omitEntity']) {
  test(`real XNode cannot report ready with an absent required PG ${missing}`, { timeout: 20000 }, async t => {
    const f = await fixture(t), result = await startup(t, f, { [missing]: true });
    assert.deepEqual(result, { rejected: true, started: false, ready: false, startedEvents: 0,
      coreRunning: false, listening: false, stopped: true, poolClosed: true });
  });
}

test('trusted SQLite-artifact PG placement propagates a real registration failure', { timeout: 20000 }, async t => {
  const def = simpleDefinition(); def._storage._provider = 'sqlite';
  const f = await fixture(t, [def]), options = structuredClone(f.runtimeOptions);
  options._placements[0]._accepted_artifact_provider = 'sqlite';
  options._placements[0]._definition_sha256 = { records: definitionDigest(def) };
  options._connections.primary._expected_store_id = randomUUID();
  const result = await startup(t, f, { runtime: options });
  assert.deepEqual(result, { rejected: true, started: false, ready: false, startedEvents: 0,
    coreRunning: false, listening: false, stopped: true, poolClosed: true });
});

test('a required PG host preserves unrelated legacy registration-error behavior', { timeout: 20000 }, async t => {
  const f = await fixture(t), result = await startup(t, f, { unrelatedApp: true });
  assert.deepEqual(result, { rejected: false, started: true, ready: true, startedEvents: 1,
    coreRunning: true, listening: true, stopped: true, poolClosed: true });
});

test('real SQLite-only XNode startup remains successful without PostgreSQL native configuration', { timeout: 20000 }, async t => {
  const f = await fixture(t), definition = structuredClone(f.definitions[0]); definition._storage._provider = 'sqlite';
  const result = await startup(t, f, { runtime: null, definition });
  assert.deepEqual(result, { rejected: false, started: true, ready: true, startedEvents: 1,
    coreRunning: true, listening: true, stopped: true, poolClosed: true });
});
