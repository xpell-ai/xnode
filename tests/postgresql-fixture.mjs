import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Client } from 'pg';
import { createPostgreSQLRuntime } from '../dist/XEntityManager/PostgreSQLRuntime.js';
import { initializePostgreSQLStore, postgresqlInventory } from '../dist/XEntityManager/PostgreSQLSchema.js';
import { resolve_entity_scope_identity } from '../dist/XEntityManager/EntityScope.js';
import { createEntityProvider } from '../dist/XEntityManager/EntityProviderRegistry.js';

export const simpleDefinition = (id = 'records', extra = {}) => ({ _id: id, _storage: { _provider: 'postgresql', _scope: 'app' },
  _schema: { name: { _type: 'String', _required: true, _index: { _unique: true } },
    score: { _type: 'Number', _index: true }, active: { _type: 'Boolean', _index: true },
    note: { _type: 'String', _index: { _unique: true } }, ...extra } });
export const scopeIdentity = (definition, scope = {}) => resolve_entity_scope_identity({ _provider: 'postgresql', _app_id: 'pg73', _env: 'test', _entity_id: definition._id, ...scope });
export const isPGError = suffix => e => e?._code === 'E_ENTITY_POSTGRESQL_' + suffix;

/** Refuses an unmarked/wrong cluster before creating or dropping any database. */
export async function fixture(t, definitions = [simpleDefinition()], options = {}) {
  const cluster = process.env.XPELL_PG_TEST_CLUSTER, port = Number(process.env.XPELL_PG_TEST_PORT);
  assert.ok(cluster?.includes('issue-73-') && Number.isInteger(port) && port > 1024, 'Explicit isolated Issue73 cluster/port required; PostgreSQL lane cannot silently skip');
  const admin = new Client({ host: process.env.XPELL_PG_TEST_SOCKET ?? '/private/tmp', port, user: os.userInfo().username,
    password: 'unused-synthetic-unix-auth', database: 'postgres', ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await admin.connect();
  const actual = (await admin.query("SELECT current_setting('data_directory') AS path,current_setting('server_version_num') AS version")).rows[0];
  if (actual.path !== cluster || actual.version !== '170012') { await admin.end(); assert.fail('Refusing non-qualified disposable PostgreSQL cluster'); }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16), db = 'ep73_' + suffix, owner = 'ep73_m_' + suffix, role = 'ep73_r_' + suffix;
  const password = randomUUID().replaceAll('-', ''), ownerEnv = 'XPELL_PG73_M_' + suffix.toUpperCase(), runtimeEnv = 'XPELL_PG73_R_' + suffix.toUpperCase();
  assert.equal(process.env[ownerEnv], undefined); assert.equal(process.env[runtimeEnv], undefined);
  const runtimes = new Set(), clients = new Set(); let created = false;
  t.after(async () => {
    await Promise.allSettled([...runtimes].map(r => r.close()));
    await Promise.allSettled([...clients].map(c => c.end()));
    if (created) await admin.query(`DROP DATABASE "${db}" WITH (FORCE)`);
    for (const name of [role, owner]) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end(); delete process.env[ownerEnv]; delete process.env[runtimeEnv];
  });
  await admin.query(`CREATE ROLE "${owner}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE "${db}" OWNER "${owner}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); created = true;
  process.env[ownerEnv] = `postgresql://${owner}:${password}@127.0.0.1:${port}/${db}`;
  process.env[runtimeEnv] = `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
  const entities = definitions.map((d, i) => ({ _definition: d, _physical_identity: scopeIdentity(d, options.entityScopes?.[i] ?? options.scope) }));
  const inventory = postgresqlInventory(entities);
  const connection = { _connection_string_env: runtimeEnv, _database: db, _schema: 'xpell73', _expected_store_id: randomUUID(),
    _expected_inventory_sha256: inventory._sha256, _tls: { _mode: 'isolated-loopback' }, ...options.connection };
  const maintenance = { _connection: { ...connection, _connection_string_env: ownerEnv }, _runtime_role: role, _entities: entities, _authorize_empty_store: true };
  if (!options.uninitialized) await initializePostgreSQLStore(maintenance);
  const runtimeOptions = { _connections: { primary: connection }, _placements: [{ _app_id: 'pg73', _env: 'test',
    ...(options.scope ? { _app_id: options.scope._app_id ?? 'pg73', _env: options.scope._env ?? 'test', _scope: options.scope._storage_scope } : {}),
    _entities: definitions.map(d => d._id), _connection: 'primary' }] };
  if (options.entityScopes) runtimeOptions._placements = entities.map(e => ({ _app_id: e._physical_identity._app_id,
    _env: e._physical_identity._env, _scope: e._physical_identity._storage_scope, _entities: [e._definition._id], _connection: 'primary' }));
  function runtime(config = runtimeOptions) { const r = createPostgreSQLRuntime(config); runtimes.add(r); return r; }
  const handle = runtime();
  const context = { _work_folder: os.tmpdir(), _postgresql: handle };
  const make = (definition = definitions[0], r = handle, identity = scopeIdentity(definition, options.scope)) => createEntityProvider(definition, identity, { ...context, _postgresql: r });
  async function client(kind = 'runtime') {
    const c = new Client({ connectionString: process.env[kind === 'owner' ? ownerEnv : runtimeEnv], ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    c.on('error', () => {}); await c.connect(); clients.add(c); return c;
  }
  return { admin, db, role, owner, password, ownerEnv, runtimeEnv, entities, inventory, connection, maintenance, runtimeOptions,
    runtime, handle, context, make, client, definitions };
}
