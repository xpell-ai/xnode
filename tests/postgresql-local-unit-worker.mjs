import { writeSync, existsSync } from 'node:fs';
import { Client } from 'pg';
import { _x, createPostgreSQLRuntime } from '../dist/index.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';

let handle, bound, input;
const pids = new Set(), query = Client.prototype.query;
Client.prototype.query = function(sql, ...args) {
  if (typeof sql === 'string' && sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE')) pids.add(this.processID);
  return query.call(this, sql, ...args);
};
const send = message => new Promise(resolve => process.send(message, resolve));
process.on('message', async message => {
  try {
    if (message.start) {
      pids.clear(); const result = await bound.commit(input.unit);
      await handle.close(); await send({ result, backendPids: [...pids] }); process.disconnect(); return;
    }
    input = message; handle = createPostgreSQLRuntime(input.runtime);
    const manager = new XEntityManager({ _provider_runtime_context: { _work_folder: input.work, _postgresql: handle } });
    await _x.loadModuleAsync(manager);
    for (const d of input.definitions) {
      const r = await _x.execute({ _module: 'entity-manager', _op: 'register', _params: { _app_id: 'pg73', _env: 'test', _entity: d } });
      if (!r._ok) throw new Error('WORKER_REGISTRATION');
    }
    bound = await manager.bindLocalUnit({ _app_id: 'pg73', _env: 'test', _entities: input.definitions.map(d => ({ _entity: d._id, _write: true })),
      _durability_contract: 'provider-neutral-v1', _capacity_profile: 'expanded-v1', _clock: () => 1000,
      _fault: point => {
        if (point === input.crash) { writeSync(1, 'UNIT_POINT ' + point + '\n'); process.kill(process.pid, 'SIGKILL'); }
        if (point === input.pause) {
          writeSync(1, 'UNIT_POINT ' + point + '\n');
          const sleep = new Int32Array(new SharedArrayBuffer(4)); let count = 0;
          // Bounded test-only synchronous barrier inside the existing native fault hook.
          while (!existsSync(input.release) && count++ < 350) Atomics.wait(sleep, 0, 0, 10);
          if (!existsSync(input.release)) throw new Error('WORKER_BARRIER_DEADLINE');
        }
      } });
    await send({ ready: true });
  } catch (error) {
    await handle?.close().catch(() => {}); await send({ error: error?._code ?? 'WORKER_FAILURE' }); process.disconnect();
  }
});
