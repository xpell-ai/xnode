import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function actor(t, f, options = {}) {
  const { env: workerEnv, ...payload } = options;
  const work = await mkdtemp(path.join(os.tmpdir(), 'issue-74-unit-worker-'));
  const release = path.join(work, 'release');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', XPELL_PG_TEST_PORT: process.env.XPELL_PG_TEST_PORT,
    [f.runtimeEnv]: process.env[f.runtimeEnv], ...(workerEnv ?? {}) };
  const child = fork(new URL('./postgresql-local-unit-worker.mjs', import.meta.url), [], { execPath: process.execPath,
    execArgv: ['--import', new URL('./postgresql-network-guard.mjs', import.meta.url).href],
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'), checkpoint = new Promise(resolve => {
    let pending = ''; child.stdout.on('data', b => { pending += b; if (pending.includes('UNIT_POINT ')) resolve(pending); });
  });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-1000); });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await exited; await rm(work, { recursive: true, force: true });
  });
  const ready = once(child, 'message');
  child.send({ work, release, runtime: f.runtimeOptions, definitions: f.definitions, ...payload });
  assert.equal((await ready)[0].ready, true, stderr);
  return { child, checkpoint, exited, release: () => writeFile(release, 'release'),
    start() { const result = once(child, 'message').then(([r]) => { assert.equal(r.error, undefined, stderr); return r; }); child.send({ start: true }); return result; },
    crash() { child.send({ start: true }); } };
}
