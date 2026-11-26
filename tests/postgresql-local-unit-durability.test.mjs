import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unitFixture, unit } from './postgresql-local-unit-fixture.mjs';
import { actor } from './postgresql-local-unit-process.mjs';
import { commitFaultProxy } from './postgresql-local-unit-proxy.mjs';

for (const point of ['after_write_1', 'after_write_2', 'after_write_3', 'after_write_4', 'after_write_5', 'before_commit', 'after_commit']) {
  test(`real PG process SIGKILL ${point} preserves all-or-none expanded effects on reopen`, async t => {
    const f = await unitFixture(t), writes = [...Array.from({ length: 4 }, () => f.create('effects')), f.create('receipts')];
    const worker = await actor(t, f, { unit: unit(...writes), crash: point }); worker.crash();
    assert.match(await worker.checkpoint, new RegExp(point)); const [code, signal] = await worker.exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const reopened = f.make(); await reopened.init();
    for (const op of writes) {
      const r = await f.read(op._entity, op._id);
      if (point === 'after_commit') { assert.equal(r.key, op._id); assert.equal(r.amount, 1); }
      else assert.equal(r, null);
    }
    assert.equal(await f.count('effects'), point === 'after_commit' ? 4 : 0);
    assert.equal(await f.count('receipts'), point === 'after_commit' ? 1 : 0);
  });
}

for (const mode of ['before-server', 'after-server']) test(`actual COMMIT transport loss ${mode} is uncertain and never automatically retried`, async t => {
  const f = await unitFixture(t), proxy = await commitFaultProxy(t, mode);
  const envName = 'XPELL_PG74_PROXY_' + randomUUID().replaceAll('-', '').toUpperCase();
  const url = new URL(process.env[f.runtimeEnv]); url.port = String(proxy.port);
  const config = structuredClone(f.runtimeOptions); config._connections.primary._connection_string_env = envName;
  const writes = [f.create('effects'), f.create('receipts')];
  const worker = await actor(t, f, { unit: unit(...writes), runtime: config, env: { [envName]: url.href } });
  proxy.arm(); const response = worker.start(); const observation = await proxy.fault; const r = await response;
  assert.equal(r.result._ok, false); assert.equal(r.result._result._code, 'E_ENTITY_POSTGRESQL_WRITE_UNCERTAIN');
  assert.equal(proxy.commits(), 1); assert.equal(observation.committed, mode === 'after-server');
  // A separate ordinary connection establishes facts; the caller never assumes rollback.
  for (const op of writes) {
    const record = await f.read(op._entity, op._id);
    if (mode === 'after-server') assert.equal(record.key, op._id); else assert.equal(record, null);
  }
  assert.equal(await f.count('effects'), mode === 'after-server' ? 1 : 0);
  assert.equal(await f.count('receipts'), mode === 'after-server' ? 1 : 0);
});
