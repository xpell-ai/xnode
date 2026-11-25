import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fixture } from './postgresql-fixture.mjs';

async function worker(t, f, mode) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pg73-node-'));
  const child = fork(new URL('./postgresql-worker.mjs', import.meta.url), [], { execPath: process.execPath,
    execArgv: ['--import', new URL('./postgresql-network-guard.mjs', import.meta.url).href],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', XPELL_PG_TEST_PORT: process.env.XPELL_PG_TEST_PORT, [f.runtimeEnv]: process.env[f.runtimeEnv] }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let logs = ''; child.stderr.on('data', b => { logs = (logs + b.toString()).slice(-2000); });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); await exited; await rm(work, { recursive: true, force: true }); });
  let timer;
  try {
    const response = once(child, 'message');
    child.send({ mode, work, runtime: f.runtimeOptions, entity: f.entities[0] });
    const [message] = await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PG worker timeout: ' + logs)), 10000); })]);
    assert.equal(message.error, undefined, logs); return { child, exited, result: message.result };
  } finally { clearTimeout(timer); }
}

for (const mode of ['normal', 'startup-failure']) {
  test(`real XNode ${mode} closes only its owned PG pool and stops idempotently`, { timeout: 15000 }, async t => {
    const f = await fixture(t), independent = f.make(); await independent.init();
    const w = await worker(t, f, mode);
    assert.deepEqual(w.result, { failed: mode === 'startup-failure', sameStop: true, closed: true, total: 0, coreRunning: false, listening: false });
    const [code] = await w.exited; assert.equal(code, 0);
    assert.equal(await independent.count(), 1); // Another runtime's pool remained usable.
  });
}

test('an acknowledged real PG record survives client process SIGKILL and provider recreation', async t => {
  const f = await fixture(t), w = await worker(t, f, 'persist');
  assert.equal(w.result._id, 'child-acknowledged'); w.child.kill('SIGKILL'); await w.exited;
  const p = f.make(); await p.init(); assert.deepEqual(await p.get('child-acknowledged'), w.result);
});

test('offline preload blocks external AI/payment hosts and existing local services', async () => {
  await import('./postgresql-network-guard.mjs');
  for (const options of [{ host: 'api.openai.com', port: 443 }, { host: 'api.paypal.com', port: 443 }, { host: '127.0.0.1', port: 3001 }, { host: '127.0.0.1', port: 3100 }]) {
    assert.throws(() => net.connect(options), /E_TEST_NETWORK_ISOLATION/);
  }
});
