// Isolated real-bootstrap actor. IPC controls tests, never XNet message transport.
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { XNode, XModule, WHWSClient, _x, _xd, wsGetConnections, Settings } from '../dist/index.js';
import { SQLiteXNetStore, createXNetWormholesHost } from '../../modules/xnet/dist/server/index.js';

let node, host, store, config, server, starting;
let now = 1_000_000;
const probes = new Map();
const key = Buffer.alloc(32, 42);
const turn = () => new Promise(resolve => setImmediate(resolve));
const code = e => e?._code ?? e?.code ?? e?.message ?? 'TEST_FAILURE';
class Probe extends WHWSClient {
  async unauthenticated(command) { return (await this._callEnvelope('REQ', command, { _call_timeout_ms: 1000 }))._payload; }
}

async function initialize(input) {
  config = input; now = input.now;
  node = new XNode();
  const work = path.join(input.dir, 'xnode-work');
  const systems = path.join(input.dir, 'empty-system-apps'); mkdirSync(systems, { recursive: true });
  const options = { _work_folder: work, _system_xapps_path: systems, _port: 0, _host: '127.0.0.1',
    _web_settings: { 'enable-wormhole': input.mode === 'wormholes', 'enable-ssl': false, domain: 'public.example.invalid' },
    _xdb: { _type: 'sqlite', _root: path.join(work, 'xdb'), _cache: false } };
  if (input.mode === 'ownership') {
    const owner = {}; _x.start(owner); let rejected;
    try { await node.start(options); } catch (e) { rejected = code(e); }
    const before = _xd.get('engine:frame-number'); await node.stop(); await delay(10);
    const result = { rejected, foreignRunSurvived: _x.isRunning(),
      framesContinued: _xd.get('engine:frame-number') > before, workCreated: existsSync(work),
      wrongOwnerStop: _x.stop({}) };
    _x.stop(owner); return result;
  }
  if (input.mode === 'bind-failure') {
    const unrelated = http.createServer();
    await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
    options._port = unrelated.address().port; let rejected;
    try { await node.start(options); } catch (e) { rejected = code(e); }
    await node.stop();
    const result = { rejected, coreRunning: _x.isRunning(), unrelatedListening: unrelated.listening,
      ownedListening: node._web_server._web_server?.listening ?? false };
    await new Promise(resolve => unrelated.close(resolve)); return result;
  }
  if (input.mode === 'partial-failure') {
    class Failing extends XModule {
      constructor() { super({ _name: 'injected-failure' }); }
      async onLoad() { throw new Error('injected module load failure'); }
    }
    options._modules = [new Failing()]; let rejected;
    try { await node.start(options); } catch (e) { rejected = code(e); }
    await node.stop();
    return { rejected, coreRunning: _x.isRunning(), started: node._started,
      ownedListening: node._web_server._web_server?.listening ?? false };
  }
  if (input.mode === 'stop-during-load') {
    let entered, release; const loaded = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    class Gated extends XModule {
      constructor() { super({ _name: 'gated-load' }); }
      async onLoad() { entered(); await gate; }
    }
    options._modules = [new Gated()]; starting = node.start(options); void starting.catch(() => {});
    await loaded; const stopped = node.stop(); await turn(); await turn();
    const result = { coreRunningDuringStop: _x.isRunning(), listeningDuringStop: node._web_server._web_server.listening };
    release(); try { await starting; } catch (e) { result.rejected = code(e); }
    await stopped; return result;
  }
  if (input.mode === 'xnet') {
    store = new SQLiteXNetStore({ _db_path: input.db, _claim_key: key, _clock: () => now, _limits: input.limits }); store.open();
    host = createXNetWormholesHost({ _store: store, _clock: () => now, _hint_interval_ms: 1,
      _verify_credential: token => {
        const index = input.tokens.indexOf(token);
        return index < 0 ? undefined : { _principal: input.receivers[index], _expires_at: 2_000_000 };
      } });
    Object.assign(options, host.nodeOptions(), { _web_settings: { ...options._web_settings, ...host.nodeOptions()._web_settings } });
  }
  await node.start(options);
  server = node._web_server._web_server;
  const before = server.listenerCount('upgrade');
  if (host) await host.start(server);
  await node.start(options); await node._web_server.start();
  return { started: node._started, address: server.address(), domain: Settings.get('xweb').domain,
    loaded: host ? _x.getModule('xnet') === host._module : true, readiness: host?._module.get_readiness(),
    upgradesBeforeAdapter: before, upgradeListeners: server.listenerCount('upgrade') };
}

async function execute(op, data) {
  if (op === 'initialize') return initialize(data);
  if (data.now !== undefined) now = data.now;
  if (op === 'advance') { await turn(); return {}; }
  if (op === 'accept') return store.accept(config.senders[data.tenant ?? 0], {
    message_type: 'mock.inbound-text.v1', idempotency_key: data.event, event_id: data.event,
    payload: { _mode: 'inline', _content_type: 'application/json', _schema_id: 'mock.text.v1', _data: data.payload ?? { text: 'synthetic' } } });
  if (op === 'status') return store.getStatus(config.senders[data.tenant ?? 0], data.message);
  if (op === 'probe') {
    let p = probes.get(data.id);
    if (!p) { p = new Probe({ _url: `ws://127.0.0.1:${server.address().port}/wh/v2`, _log: false }); probes.set(data.id, p); await p.connect(); }
    if (data.token !== undefined) return p.auth({ _token: data.token });
    if (data.close) { p.close(); probes.delete(data.id); return {}; }
    return data.unauth ? p.unauthenticated(data.command) : p.call(data.command);
  }
  if (op === 'disconnect') {
    for (const c of wsGetConnections()) if (c._ctx._auth._user_id === config.receivers[data.tenant]._principal_id) c._ws.terminate();
    return {};
  }
  if (op === 'reject-second') {
    const other = new XNode(); let rejected;
    try { await other.start({ _work_folder: path.join(config.dir, 'unrelated-work'), _port: 0, _host: '127.0.0.1' }); }
    catch (e) { rejected = code(e); }
    await other.stop();
    return { rejected, firstListening: server.listening, firstCoreRunning: _x.isRunning() };
  }
  if (op === 'stop-node') {
    const first = node.stop(); const readinessOffImmediately = !node._started && !_x.isRunning();
    const second = node.stop(); await first; await turn(); await turn();
    const frame = _xd.get('engine:frame-number'); await delay(20);
    let restart; try { await node.start(); } catch (e) { restart = code(e); }
    return { sameStop: first === second, readinessOffImmediately, listening: server.listening, connections: wsGetConnections().length,
      frameStable: frame === _xd.get('engine:frame-number'), coreRunning: _x.isRunning(), restart,
      upgradeListeners: server.listenerCount('upgrade'),
      commandRejected: (() => { try { _x.execute({ _module: 'ping', _op: 'ping', _params: {} }); return false; } catch { return true; } })() };
  }
  if (op === 'finish') {
    for (const p of probes.values()) p.close(); probes.clear();
    await host?.stop(); await node?.stop(); store?.close(); return {};
  }
  throw new Error('UNKNOWN_TEST_OP');
}
process.on('message', async message => {
  try {
    const result = await execute(message.op, message.data ?? {});
    process.send({ id: message.id, result }, () => { if (message.op === 'finish') process.disconnect(); });
  } catch (e) { process.send({ id: message.id, error: code(e) }); }
});
