// Synthetic native storage-half fixture only. Never shipped as a production issuer.
import { randomUUID } from 'node:crypto';
import { fixture } from './postgresql-fixture.mjs';
import { unitDefinition } from './postgresql-local-unit-fixture.mjs';
import { migratePostgreSQLStore } from '../dist/XEntityManager/PostgreSQLSchema.js';
import { getPostgreSQLRuntime } from '../dist/XEntityManager/PostgreSQLRuntime.js';
import { preparePostgreSQLUnit, executePostgreSQLUnit } from '../dist/XEntityManager/PostgreSQLLocalUnit.js';
import { ENTITY_LOCAL_UNIT_CAPABILITIES } from '../dist/XEntityManager/EntityLocalUnit.js';
import { pgNamespace } from '../dist/XEntityManager/PostgreSQLRuntime.js';

export async function fenceFixture(t, input = {}) {
  const f = await fixture(t, [unitDefinition('effects'), unitDefinition('receipts', true)]);
  await migratePostgreSQLStore({ ...f.maintenance, _from_version: 1, _to_version: 2 });
  const maintenance = { ...f.maintenance, _connection: { ...f.maintenance._connection, _expected_schema_version: 2 } };
  await migratePostgreSQLStore({ ...maintenance, _from_version: 2, _to_version: 3 });
  const config = structuredClone(f.runtimeOptions); config._connections.primary._expected_schema_version = 3;
  const handle = f.runtime(config), runtime = getPostgreSQLRuntime(handle), identity = f.entities[0]._physical_identity;
  const owner = await f.client('owner'), ownerId = randomUUID(), storeId = f.connection._expected_store_id;
  const key = `issue74-owner:${storeId}`;
  const lock = await owner.query('SELECT pg_try_advisory_lock(hashtextextended(current_database() || $1,0)) AS acquired', [key]);
  if (!lock.rows[0].acquired) throw new Error('synthetic owner lock unavailable');
  await owner.query('BEGIN'); await owner.query('SELECT * FROM xpell73.ep_fence WHERE singleton=TRUE FOR UPDATE');
  await owner.query('UPDATE xpell73.ep_fence SET owner_id=$1,epoch=1 WHERE singleton=TRUE', [ownerId]); await owner.query('COMMIT');
  const frame = { _store_id: storeId, _owner_id: ownerId, _epoch: '1', _revoked: false };
  const entities = new Map(f.inventory._layouts.map(l => [l._definition._id, { _layout: l, _namespace: name => pgNamespace('xpell73', name) }]));
  const control = { now: 1000, fault: undefined, hook: undefined };
  const options = { _clock: () => control.now, _limits: ENTITY_LOCAL_UNIT_CAPABILITIES._profiles['expanded-v1'],
    _strict_final_checks: true, _revalidate: () => {},
    _fault: p => { control.hook?.(p); if (p === control.fault) throw new Error('synthetic fixed fault'); } };
  const run = async (unit, selected = frame, hold) => {
    const prepared = await preparePostgreSQLUnit(entities, unit, options); let finish;
    return runtime.transaction(identity, true, async client => {
      const result = await executePostgreSQLUnit(client, entities, prepared, { _id: storeId, _schema_version: 3, _inventory_sha256: f.inventory._sha256 }, options, selected);
      finish = result._finalize; await hold?.(client); return result;
    }, () => finish());
  };
  const make = () => f.make(f.definitions[0], handle, identity);
  return { ...f, handle, runtime, config, identity, entities, owner, ownerId, storeId, key, frame, control, options, run, make };
}

export function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function waitFor(t, action, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('bounded synthetic synchronization deadline');
}
