import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fixture } from '../../modules/xnet/tests/fixtures.mjs';

async function actor(cleanups, script, input, finish = 'finish') {
  const child = fork(script, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', TZ: 'UTC' } });
  let id = 0, logs = ''; const pending = new Map();
  child.stderr.on('data', b => { logs += b.toString().slice(-2000); });
  child.on('message', m => {
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.deadline);
    m.error ? p.reject(Object.assign(new Error(m.error), { code: m.error })) : p.resolve(m.result);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const p of pending.values()) { clearTimeout(p.deadline); p.reject(new Error('worker exited: ' + logs)); }
    pending.clear(); resolve({ code, signal });
  }));
  function call(op, data = {}) {
    return new Promise((resolve, reject) => {
      const seq = ++id;
      const deadline = setTimeout(() => { pending.delete(seq); reject(new Error('test actor deadline: ' + op)); }, 10_000);
      pending.set(seq, { resolve, reject, deadline });
      child.send({ id: seq, op, data });
    });
  }
  let done;
  async function stop() {
    if (done) return done;
    done = (async () => {
      try { if (child.connected) await call(finish); }
      catch (e) { child.kill('SIGKILL'); await exited; throw e; }
      let timer;
      const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
      clearTimeout(timer);
      if (!outcome) { child.kill('SIGKILL'); await exited; assert.fail('runtime leaked handles after public cleanup: ' + logs); }
      assert.deepEqual(outcome, { code: 0, signal: null });
    })(); return done;
  }
  cleanups.push(stop);
  return { call, stop, ready: await call('initialize', input) };
}
async function environment(t, mode) {
  const cleanup = [], files = [];
  const f = fixture({ after: fn => files.push(fn) }, { _ttl_ms: 10_000, _registration_lease_ms: 1000, _claim_lease_ms: 200 });
  f.store.close(); let now = f.now;
  t.after(async () => { for (const fn of cleanup.reverse()) await fn(); for (const fn of files) fn(); });
  const input = { mode, dir: f.dir, db: f.options._db_path, limits: f.options._limits, now,
    addresses: f.addresses, senders: f.senders, receivers: f.receivers, tokens: ['synthetic-a', 'synthetic-b'] };
  let server = await actor(cleanup, new URL('./lifecycle-worker.mjs', import.meta.url), input);
  const clients = [];
  const e = { f, input, get server() { return server; },
    async restart() { server = await actor(cleanup, new URL('./lifecycle-worker.mjs', import.meta.url), { ...input, now }); },
    async client(i) {
      const client = await actor(cleanup, new URL('../../modules/xnet/tests/transport-worker.mjs', import.meta.url), {
        role: 'client', ledger: path.join(f.dir, `target-${i}.sqlite`), address: f.addresses[i],
        url: `ws://127.0.0.1:${server.ready.address.port}/wh/v2`, token: input.tokens[i], now }, 'stop');
      clients[i] = client; return client;
    },
    async drive(message, tenant = 0) {
      for (let n = 0; n < 30; n++) {
        if ((await server.call('status', { message, tenant }))._state === 'processed') return;
        now += 10; await server.call('advance', { now });
        for (const c of clients) if (c) await c.call('advance', { now });
      }
      assert.fail('message did not receive a durable ACK within bounded frames');
    },
    clearClients() { clients.length = 0; },
  };
  return e;
}
const req = (op, params = {}, extra = {}) => ({ _module: 'xnet', _op: op, _params: params, ...extra });

for (const mode of ['ownership', 'bind-failure', 'partial-failure', 'stop-during-load']) {
  test(`isolated XNode lifecycle: ${mode}`, { timeout: 20_000 }, async t => {
    const e = await environment(t, mode); const r = e.server.ready;
    if (mode === 'ownership') assert.deepEqual(r, { rejected: 'E_XNODE_CORE_IN_USE', foreignRunSurvived: true,
      framesContinued: true, workCreated: false, wrongOwnerStop: false });
    if (mode === 'bind-failure') assert.deepEqual(r, { rejected: 'EADDRINUSE', coreRunning: false, unrelatedListening: true, ownedListening: false });
    if (mode === 'partial-failure') assert.deepEqual(r, { rejected: 'injected module load failure', coreRunning: false, started: false, ownedListening: false });
    if (mode === 'stop-during-load') assert.deepEqual(r, { coreRunningDuringStop: false, listeningDuringStop: false, rejected: 'E_XNODE_STOPPING' });
  });
}

test('full XNode closes owned Wormholes sockets/listeners, fences work and stops frames idempotently', { timeout: 20_000 }, async t => {
  const e = await environment(t, 'wormholes');
  assert.equal(e.server.ready.address.address, '127.0.0.1');
  assert.equal(e.server.ready.upgradeListeners, 1);
  assert.deepEqual(await e.server.call('reject-second'), { rejected: 'E_XNODE_CORE_IN_USE', firstListening: true, firstCoreRunning: true });
  await e.server.call('probe', { id: 'socket', token: 'not-valid' });
  const stopped = await e.server.call('stop-node');
  assert.deepEqual(stopped, { sameStop: true, readinessOffImmediately: true, listening: false, connections: 0, frameStable: true,
    coreRunning: false, restart: 'E_XNODE_RESTART_REQUIRES_PROCESS', upgradeListeners: 0, commandRejected: true });
});

test('full XNode hosts two authenticated XNet endpoints, rejects forgery and recovers after process restart', { timeout: 40_000 }, async t => {
  const e = await environment(t, 'xnet'); const host = e.server;
  assert.equal(host.ready.started, true); assert.equal(host.ready.loaded, true); assert.equal(host.ready.readiness._ready, true);
  assert.equal(host.ready.address.address, '127.0.0.1'); assert.equal(host.ready.domain, 'public.example.invalid');
  assert.equal(host.ready.upgradesBeforeAdapter, 0); assert.equal(host.ready.upgradeListeners, 1);
  const a = await e.client(0), b = await e.client(1); const oldRegistration = a.ready.registration;
  assert.equal(a.ready.readiness._ready, true); assert.equal(b.ready.readiness._ready, true);
  const one = await host.call('accept', { event: 'same-provider-event', tenant: 0,
    payload: { _tenant_id: e.f.tenants[1], _endpoint_id: e.f.addresses[1]._endpoint_id, _module: 'xd', _op: 'set' } });
  const two = await host.call('accept', { event: 'same-provider-event', tenant: 1 });
  await e.drive(one._message_id); await e.drive(two._message_id, 1);
  assert.equal((await a.call('inspect')).effects.length, 1); assert.equal((await b.call('inspect')).effects.length, 1);
  assert.equal((await host.call('probe', { id: 'anonymous', unauth: true, command: req('get-readiness') }))._ok, false);
  assert.equal((await host.call('probe', { id: 'probe-a', token: e.input.tokens[0] }))._ok, true);
  await assert.rejects(host.call('probe', { id: 'probe-a', command: { _module: 'xd', _op: 'set', _params: { key: 'forged', value: true } } }));
  await assert.rejects(host.call('probe', { id: 'probe-a', command: req('register-endpoint', { address: e.f.addresses[1] }) }));
  await assert.rejects(host.call('probe', { id: 'probe-a', command: req('get-message-status', { message_id: two._message_id }) }));
  await assert.rejects(host.call('probe', { id: 'probe-a', command: req('receive-next', { registration_id: oldRegistration._id, request_key: 'steal' }) }));
  await a.stop(); await b.stop(); e.clearClients();
  const offline = await host.call('accept', { event: 'offline-across-restart', tenant: 1 });
  const stopped = await host.call('stop-node');
  assert.equal(stopped.listening, false); assert.equal(stopped.connections, 0); assert.equal(stopped.frameStable, true);
  await host.stop(); await e.restart();
  assert.equal((await e.server.call('status', { message: one._message_id }))._state, 'processed');
  assert.equal((await e.server.call('status', { message: two._message_id, tenant: 1 }))._state, 'processed');
  assert.equal((await e.server.call('accept', { event: 'same-provider-event', tenant: 1 }))._message_id, two._message_id);
  assert.equal((await e.server.call('probe', { id: 'fresh', unauth: true, command: req('get-readiness') }))._ok, false);
  await e.server.call('probe', { id: 'fresh', token: e.input.tokens[0] });
  await assert.rejects(e.server.call('probe', { id: 'fresh', command: req('receive-next', { registration_id: oldRegistration._id, request_key: 'old' }) }));
  const aa = await e.client(0), bb = await e.client(1); await e.drive(offline._message_id, 1);
  assert.notEqual(aa.ready.registration._connection_id, oldRegistration._connection_id);
  assert.ok(aa.ready.registration._owner_epoch > oldRegistration._owner_epoch);
  assert.equal((await aa.call('inspect')).effects.length, 1); assert.equal((await bb.call('inspect')).effects.length, 2);
});
