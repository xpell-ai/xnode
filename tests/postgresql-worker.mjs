import fs from 'node:fs';
import path from 'node:path';
import { XNode, _x, createPostgreSQLRuntime } from '../dist/index.js';
import { createEntityProvider } from '../dist/XEntityManager/EntityProviderRegistry.js';
import { ServerXVMModule } from '../dist/XVM/ServerXVMModule.js';

let handle;
async function run(input) {
  if (input.mode === 'persist') {
    handle = createPostgreSQLRuntime(input.runtime);
    const provider = createEntityProvider(input.entity._definition, input.entity._physical_identity, { _work_folder: input.work, _postgresql: handle });
    await provider.init(); return provider.add({ _id: 'child-acknowledged', name: 'durable-child' });
  }
  const node = new XNode(), systems = path.join(input.work, 'empty-systems');
  fs.mkdirSync(path.join(input.work, 'settings'), { recursive: true }); fs.mkdirSync(systems, { recursive: true });
  fs.writeFileSync(path.join(input.work, 'settings/mcp.json'), '{"enabled":false}');
  // Required native PG placements must exist during startup, rather than first
  // registering after XNode has already announced readiness.
  const app = path.join(input.work, 'xvm/apps/test/pg73');
  fs.mkdirSync(path.join(app, 'entities'), { recursive: true });
  fs.writeFileSync(path.join(app, 'app.json'), JSON.stringify({ _app_id: 'pg73', _env: 'test', _config: {} }));
  fs.writeFileSync(path.join(app, 'entities/records.json'), JSON.stringify(input.entity._definition));
  const register = async () => {
    const response = await _x.execute({ _module: 'entity-manager', _op: 'register', _params: { _app_id: 'pg73', _env: 'test', _entity: input.entity._definition } });
    if (!response?._ok) throw new Error('WORKER_REGISTRATION_FAILED');
    handle = _x.getModule('entity-manager')._provider_runtime_context._postgresql;
    const response2 = await _x.execute({ _module: 'entity-manager', _op: 'add', _params: { _app_id: 'pg73', _env: 'test', _entity: 'records', _data: { name: 'node-owned' } } });
    if (!response2?._ok) throw new Error('WORKER_WRITE_FAILED');
  };
  const original = ServerXVMModule.prototype.onLoad;
  if (input.mode === 'startup-failure') ServerXVMModule.prototype.onLoad = async function() { await register(); throw new Error('synthetic failure after PG allocation'); };
  let failed = false;
  try {
    await node.start({ _work_folder: input.work, _system_xapps_path: systems, _entity_postgresql: input.runtime,
      _host: '127.0.0.1', _port: 0, _web_settings: { 'enable-wormhole': false, 'enable-ssl': false, domain: 'example.invalid' } });
    await register();
  } catch { failed = true; }
  finally { ServerXVMModule.prototype.onLoad = original; }
  const first = node.stop(), same = first === node.stop(); await first;
  return { failed, sameStop: same, closed: handle?.diagnostics()._closed,
    total: handle?.diagnostics()._stores.reduce((n, s) => n + s._total, 0), coreRunning: _x.isRunning(), listening: node._web_server._web_server?.listening ?? false };
}
process.on('message', async input => {
  try { const result = await run(input); process.send({ result }, () => { if (input.mode !== 'persist') process.disconnect(); }); }
  catch (error) { process.send({ error: error?._code ?? error?.code ?? 'PG_WORKER_FAILURE' }, () => process.disconnect()); }
});
