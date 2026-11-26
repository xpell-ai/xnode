import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { _x } from '../dist/index.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';
import { fixture } from './postgresql-fixture.mjs';

let manager;
export const unitDefinition = (name, append = false, extra = {}) => ({ _id: name,
  _storage: { _provider: 'postgresql', _scope: 'app', ...(append ? { _append_only: true } : {}) },
  _schema: { key: { _type: 'String', _required: true, _index: { _unique: true } },
    amount: { _type: 'Number', _min: 0, _max: Number.MAX_SAFE_INTEGER, _index: true },
    note: { _type: 'String' }, payload: { _type: 'Object' }, ...extra } });

export async function unitFixture(t, input = {}) {
  const definitions = input.definitions ?? [unitDefinition('effects'), unitDefinition('receipts', true)];
  const f = await fixture(t, definitions, input.fixture);
  if (!manager) { manager = new XEntityManager({ _provider_runtime_context: f.context }); await _x.loadModuleAsync(manager); }
  else manager._provider_runtime_context = f.context; // Isolated test native bootstrap; previous fixture is closed.
  assert.equal(_x.getModule('entity-manager'), manager);
  const scope = { _app_id: 'pg73', _env: 'test' };
  const command = (op, params = {}) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
  for (const definition of definitions) assert.equal((await command('register', { _entity: definition }))._ok, true);
  t.after(async () => { for (const definition of definitions) await command('unregister', { _entity: definition._id }); });
  const control = { now: 1000, fault: undefined, hook: undefined };
  const options = { ...scope, _entities: definitions.map(d => ({ _entity: d._id, _write: true })),
    _durability_contract: 'provider-neutral-v1', _clock: () => control.now,
    _fault: point => { control.hook?.(point); if (point === control.fault) throw new Error('synthetic fault'); }, ...input.binding };
  const bound = await manager.bindLocalUnit(options);
  const read = async (entity, id) => {
    const r = await command('get', { _entity: entity, _id: id }); assert.equal(r._ok, true); return r._result._record;
  };
  const create = (entity, id = randomUUID(), data = {}) => ({ _entity: entity, _id: id, _expect: null,
    _create: { _id: id, key: id, amount: 1, ...data } });
  const count = async entity => (await command('find', { _entity: entity }))._result._records._meta._total_records;
  return { ...f, manager, scope, command, control, options, bound, read, create, count };
}
export const unit = (...records) => ({ _unit_id: randomUUID(), _records: records });
export const errorCode = response => response?._result?._code ?? response?._result?._error?._code;
