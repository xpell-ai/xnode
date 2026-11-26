// Real XNode/XVM bootstrap actor: no patched onLoad or simulated registration responses.
import fs from 'node:fs';
import path from 'node:path';
import { XNode, _x, _xem } from '../dist/index.js';
import { getXpellMCPRuntimeReadiness } from '@xpell/mcp';

process.on('message', async input => {
  const node = new XNode();
  try {
    const systems = path.join(input.work, 'empty-systems');
    fs.mkdirSync(systems, { recursive: true });
    fs.mkdirSync(path.join(input.work, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(input.work, 'settings/mcp.json'), '{"enabled":false}');
    if (!input.omitApp) {
      const app = path.join(input.work, 'xvm/apps/test/pg73');
      fs.mkdirSync(path.join(app, 'entities'), { recursive: true });
      fs.writeFileSync(path.join(app, 'app.json'), JSON.stringify({ _app_id: 'pg73', _env: 'test', _config: {} }));
      if (!input.omitEntity) fs.writeFileSync(path.join(app, 'entities/records.json'), JSON.stringify(input.definition));
    }
    if (input.unrelatedApp) {
      const app = path.join(input.work, 'xvm/apps/test/unrelated');
      fs.mkdirSync(path.join(app, 'entities'), { recursive: true });
      fs.writeFileSync(path.join(app, 'app.json'), JSON.stringify({ _app_id: 'unrelated', _env: 'test', _config: {} }));
      fs.writeFileSync(path.join(app, 'entities/records.json'), JSON.stringify({ ...input.definition, _storage: { _provider: 'unsupported-test-provider', _scope: 'app' } }));
    }
    let startedEvents = 0, rejected = false;
    const listener = _xem.on('server:started', () => { startedEvents++; });
    try {
      await node.start({ _work_folder: input.work, _system_xapps_path: systems,
        ...(input.runtime ? { _entity_postgresql: input.runtime } : {}), _host: '127.0.0.1', _port: 0,
        _web_settings: { 'enable-wormhole': false, 'enable-ssl': false, domain: 'example.invalid' } });
    } catch { rejected = true; }
    const handle = node._entity_manager?._provider_runtime_context._postgresql;
    const result = { rejected, started: node._started, ready: getXpellMCPRuntimeReadiness()._ready, startedEvents,
      coreRunning: _x.isRunning(), listening: node._web_server._web_server?.listening ?? false };
    if (!rejected) {
      const diagnostic = await _x.execute({ _module: 'entity-manager', _op: 'storage-diagnostics',
        _params: { _app_id: 'pg73', _env: 'test', _entity: 'records' } });
      const expected = input.runtime ? 'postgresql' : 'sqlite';
      if (diagnostic?._result?._diagnostic?._storage_provider !== expected) throw new Error('STARTUP_ENTITY_NOT_REGISTERED');
      if (input.unrelatedApp) {
        const unrelated = await _x.execute({ _module: 'entity-manager', _op: 'storage-diagnostics',
          _params: { _app_id: 'unrelated', _env: 'test', _entity: 'records' } });
        if (unrelated?._ok !== false) throw new Error('LEGACY_FAILURE_NOT_REPRODUCED');
      }
    }
    await node.stop(); _xem.remove(listener);
    result.stopped = !_x.isRunning() && !(node._web_server._web_server?.listening ?? false);
    result.poolClosed = !handle || handle.diagnostics()._closed && handle.diagnostics()._stores.every(s => s._total === 0);
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    await node.stop().catch(() => {});
    process.send({ error: error?._code ?? error?.code ?? 'PG_STARTUP_WORKER_FAILURE' }, () => process.disconnect());
  }
});
