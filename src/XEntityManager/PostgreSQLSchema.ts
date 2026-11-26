import { Pool, type PoolClient } from "pg";
import type { EntityPhysicalIdentity } from "./EntityProvider.js";
import { canonicalJSON, digest, layoutFor, literal, pgError, quote, type PGLayout } from "./PostgreSQLValues.js";
import { pgNamespace, poolConfiguration, sanitizedPGError, safeIdentifier, type PostgreSQLConnectionOptions } from "./PostgreSQLRuntime.js";
import { resolve_entity_scope_identity } from "./EntityScope.js";
import { localUnitError, type EntityLocalUnitOwnership } from "./EntityLocalUnit.js";
import type { PostgreSQLUnitFence } from "./PostgreSQLLocalUnit.js";

export type PostgreSQLStoreEntity = { _definition: any; _physical_identity: EntityPhysicalIdentity };
export function assertPostgreSQLIdentity(definition: any, identity: EntityPhysicalIdentity) {
    try {
        const parts = identity._physical_identity.split("::");
        const extra = identity as EntityPhysicalIdentity & { _app_id?: string; _env?: string };
        const expected = resolve_entity_scope_identity({ _provider: "postgresql", _entity_id: String(definition._id ?? definition._name ?? ""),
            _storage_scope: definition._storage?._scope ?? "app",
            _app_id: extra._app_id ?? (parts.length === 4 ? Buffer.from(parts[2], "base64url").toString("utf8") : undefined),
            _env: extra._env ?? (parts.length === 4 ? Buffer.from(parts[1], "base64url").toString("utf8") : undefined) });
        for (const key of ["_physical_identity", "_physical_entity_name", "_physical_entity_encoding", "_logical_entity_id", "_storage_scope", "_provider"] as const) {
            if (identity[key] !== expected[key]) throw pgError("PLACEMENT");
        }
    } catch { throw pgError("PLACEMENT"); }
}
function metadataDDL(schema: string) {
    const ns = (name: string) => pgNamespace(schema, name);
    return `CREATE TABLE ${ns("ep_store")} (singleton boolean PRIMARY KEY CHECK(singleton),store_id text NOT NULL,schema_version integer NOT NULL,inventory_sha256 text NOT NULL);
CREATE TABLE ${ns("ep_migrations")} (version integer PRIMARY KEY,checksum text NOT NULL);
CREATE TABLE ${ns("ep_entities")} (identity_hash text PRIMARY KEY,physical_identity text NOT NULL,definition_sha256 text NOT NULL,layout_sha256 text NOT NULL,table_name text NOT NULL UNIQUE,ddl_sha256 text NOT NULL,ddl_plan_sha256 text NOT NULL)`;
}
function migrationV2SQL(schema: string) {
    const ns = (name: string) => pgNamespace(schema, name);
    return [`ALTER TABLE ${ns("ep_migrations")} ADD COLUMN description text NOT NULL DEFAULT ''`,
        `INSERT INTO ${ns("ep_migrations")}(version,checksum,description) VALUES(2,$1,'metadata description')`,
        `UPDATE ${ns("ep_store")} SET schema_version=2 WHERE singleton=TRUE`];
}
function migrationV3SQL(schema: string, role: string) {
    const ns = (name: string) => pgNamespace(schema, name);
    return [`CREATE TABLE ${ns("ep_fence")} (singleton boolean PRIMARY KEY CHECK(singleton),store_id text NOT NULL,required boolean NOT NULL CHECK(required),owner_id uuid,epoch bigint NOT NULL CHECK(epoch>=0),lock_anchor boolean NOT NULL DEFAULT TRUE CHECK(lock_anchor),CHECK((epoch=0 AND owner_id IS NULL) OR (epoch>0 AND owner_id IS NOT NULL)))`,
        `INSERT INTO ${ns("ep_fence")} (singleton,store_id,required,owner_id,epoch) VALUES(TRUE,$1,TRUE,NULL,0)`,
        `GRANT SELECT,UPDATE(lock_anchor) ON ${ns("ep_fence")} TO ${quote(role)}`,
        `UPDATE ${ns("ep_store")} SET schema_version=3 WHERE singleton=TRUE`,
        `INSERT INTO ${ns("ep_migrations")}(version,checksum,description) VALUES(3,$1,$2)`];
}
// Hash the executed versioned SQL with a fixed namespace token; entity DDL has its own exact plan hash.
export const MIGRATION_CHECKSUMS = Object.freeze(["", digest(metadataDDL("_xpell_schema")), digest(canonicalJSON(migrationV2SQL("_xpell_schema"))),
    digest(canonicalJSON(migrationV3SQL("_xpell_schema", "_xpell_runtime_role")))]);
export function postgresqlInventory(entities: PostgreSQLStoreEntity[]) {
    const layouts = entities.map(e => {
        assertPostgreSQLIdentity(e._definition, e._physical_identity);
        return layoutFor(e._definition, e._physical_identity._physical_identity);
    });
    if (!layouts.length || new Set(layouts.map(l => l._identity)).size !== layouts.length || new Set(layouts.map(l => l._table)).size !== layouts.length) throw pgError("SCHEMA_COLLISION");
    const inventory = layouts.map(l => ({ identity: l._identity, definition: l._definition_hash, layout: l._layout_hash }))
        .sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
    return { _layouts: layouts, _sha256: digest(canonicalJSON(inventory)) };
}

/** Generated identifiers only; values remain parameters in all record operations. */
export function recordDDL(schema: string, layout: PGLayout): string[] {
    const table = pgNamespace(schema, layout._table), guard = pgNamespace(schema, `g_${digest(layout._table).slice(0, 48)}`), unique = pgNamespace(schema, `u_${digest(layout._table).slice(0, 48)}`);
    const columns = layout._fields.map(f => {
        const col = quote(f._column), s = layout._schema[f._name];
        const checks: string[] = [];
        if (f._type === "number") {
            checks.push(`(${col} > '-Infinity'::float8 AND ${col} < 'Infinity'::float8)`);
            for (const [key, op] of [["_min", ">="], ["_max", "<="]]) {
                if (s[key] != null) { const n = Number(s[key]); if (!Number.isFinite(n)) throw pgError("SCHEMA"); checks.push(`${col} ${op} ${n}`); }
            }
        }
        return `${col} ${f._sql}${f._required ? " NOT NULL" : ""}${checks.length ? ` CHECK (${col} IS NULL OR (${checks.join(" AND ")}))` : ""}`;
    });
    const statements = [`CREATE TABLE ${table} (_row_key uuid PRIMARY KEY, _json text NOT NULL CHECK (json_typeof(_json::json)='object'), ${columns.join(",")})`];
    for (const f of layout._fields.filter(f => f._indexed)) {
        const index = quote(`i_${digest(layout._table + f._column).slice(0, 48)}`), col = quote(f._column);
        statements.push(`CREATE ${f._unique && f._sql !== "BYTEA" ? "UNIQUE " : ""}INDEX ${index} ON ${table} (${f._sql === "BYTEA" ? `pg_catalog.sha256(${col})` : col}) WHERE ${col} IS NOT NULL`);
    }
    const immutable = layout._fields.filter(f => f._immutable).map(f => `NEW.${quote(f._column)} IS DISTINCT FROM OLD.${quote(f._column)}`).join(" OR ");
    statements.push(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_setting('transaction_isolation') <> 'serializable' OR current_setting('synchronous_commit') <> 'on' THEN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='E_ENTITY_POSTGRESQL_WRITE_POLICY';
 END IF;
 ${layout._append_only ? "IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='E_ENTITY_APPEND_ONLY'; END IF;" : ""}
 ${immutable ? `IF TG_OP='UPDATE' AND (${immutable}) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='E_ENTITY_IMMUTABLE'; END IF;` : ""}
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $guard$`);
    statements.push(`CREATE TRIGGER ep_write_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
    const checks = layout._fields.filter(f => f._unique && f._sql === "BYTEA").map(f => {
        const c = quote(f._column);
        return `IF NEW.${c} IS NOT NULL AND EXISTS(SELECT 1 FROM ${table} r WHERE pg_catalog.sha256(r.${c})=pg_catalog.sha256(NEW.${c}) AND r.${c}=NEW.${c} AND r._row_key<>NEW._row_key) THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='E_ENTITY_POSTGRESQL_UNIQUE'; END IF;`;
    });
    statements.push(`CREATE FUNCTION ${unique}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $unique$ BEGIN ${checks.join("\n")} RETURN NEW; END $unique$`);
    statements.push(`CREATE CONSTRAINT TRIGGER ep_unique_guard AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION ${unique}()`);
    return statements;
}

async function fingerprint(client: PoolClient, schema: string, table: string) {
    // Deparsed DDL omits activation/persistence/index-build state. Enforce these
    // independently of the stored digest, including the durable identity/ledger tables.
    const relations = [table, "ep_store", "ep_migrations", "ep_entities"].map(name => pgNamespace(schema, name));
    const states = (await client.query(`SELECT c.relkind,c.relpersistence,
      NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid
        AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive OR ic.relkind<>'i' OR ic.relpersistence<>'p')) AS indexes_ready,
      NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled<>'O') AS triggers_enabled
      FROM unnest($1::text[]) required(name) LEFT JOIN pg_class c ON c.oid=to_regclass(required.name)`, [relations])).rows;
    if (states.length !== relations.length || states.some(s => s.relkind !== "r" || s.relpersistence !== "p" || !s.indexes_ready || !s.triggers_enabled)) throw pgError("SCHEMA_MISMATCH");
    const result = await client.query(`SELECT
      (SELECT json_agg(row_to_json(c) ORDER BY c.attnum) FROM (SELECT a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped) c) AS columns,
      (SELECT json_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=to_regclass($1)) AS indexes,
      (SELECT json_agg(pg_get_constraintdef(c.oid) ORDER BY pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.conrelid=to_regclass($1)) AS constraints,
      (SELECT json_agg(json_build_array(pg_get_triggerdef(t.oid),pg_get_functiondef(t.tgfoid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=to_regclass($1) AND NOT t.tgisinternal) AS triggers`, [pgNamespace(schema, table)]);
    if (!result.rows[0].columns) throw pgError("SCHEMA_MISMATCH");
    return digest(canonicalJSON(result.rows[0]));
}

export async function verifyEntitySchema(client: PoolClient, namespace: (name: string) => string, layout: PGLayout) {
    const metadata = (await client.query(`SELECT identity_hash,physical_identity,definition_sha256,layout_sha256,table_name,ddl_sha256,ddl_plan_sha256 FROM ${namespace("ep_entities")} WHERE identity_hash=$1`, [digest(layout._identity)])).rows;
    const m = metadata[0];
    if (metadata.length !== 1 || m.physical_identity !== layout._identity || m.definition_sha256 !== layout._definition_hash || m.layout_sha256 !== layout._layout_hash || m.table_name !== layout._table) throw pgError("SCHEMA_MISMATCH");
    const namespaceText = namespace(layout._table);
    const schema = (await client.query("SELECT n.nspname, pg_has_role(current_user,c.relowner,'MEMBER') AS owner, has_table_privilege(current_user,c.oid,'TRUNCATE,TRIGGER') AS unsafe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)", [namespaceText])).rows[0];
    if (!schema || schema.owner || schema.unsafe || await fingerprint(client, schema.nspname, layout._table) !== m.ddl_sha256
        || digest(canonicalJSON(recordDDL(schema.nspname, layout))) !== m.ddl_plan_sha256) throw pgError("SCHEMA_MISMATCH");
    const all = (await client.query(`SELECT physical_identity AS identity,definition_sha256 AS definition,layout_sha256 AS layout FROM ${namespace("ep_entities")} ORDER BY physical_identity COLLATE "C"`)).rows;
    all.sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
    const store = (await client.query(`SELECT store_id,schema_version,inventory_sha256 FROM ${namespace("ep_store")} WHERE singleton=TRUE`)).rows[0];
    if (!store || digest(canonicalJSON(all)) !== store.inventory_sha256) throw pgError("SCHEMA_MISMATCH");
    const ledger = (await client.query(`SELECT version,checksum FROM ${namespace("ep_migrations")} ORDER BY version`)).rows;
    if (ledger.length !== store.schema_version || ledger.some((m, i) => m.version !== i + 1 || m.checksum !== MIGRATION_CHECKSUMS[i + 1])) throw pgError("MIGRATION_MISMATCH");
    if (store.schema_version === 3) await verifyFenceStructure(client, namespace, store.store_id);
}

async function verifyFenceStructure(client: PoolClient, ns: (name: string) => string, storeId: string) {
    const relation = ns("ep_fence");
    const schema = (await client.query("SELECT n.nspname,pg_has_role(current_user,c.relowner,'MEMBER') AS owner,has_table_privilege(current_user,c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER') AS unsafe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)", [relation])).rows[0];
    const ledger = (await client.query(`SELECT description FROM ${ns("ep_migrations")} WHERE version=3`)).rows;
    if (!schema || schema.owner || schema.unsafe || ledger.length !== 1 || ledger[0].description !== "fence-v1:" + await fingerprint(client, schema.nspname, "ep_fence")) throw pgError("SCHEMA_MISMATCH");
    const privileges = (await client.query(`SELECT a.attname,has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT') AS readable,has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE') AS writable FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped`, [relation])).rows;
    if (privileges.length !== 6 || privileges.some(p => !p.readable || p.writable !== (p.attname === "lock_anchor"))) throw pgError("ROLE");
    const row = (await client.query(`SELECT store_id,required,owner_id,epoch::text AS epoch FROM ${relation} WHERE singleton=TRUE`)).rows;
    if (row.length !== 1 || row[0].store_id !== storeId || row[0].required !== true || !/^(0|[1-9]\d*)$/.test(row[0].epoch) ||
        BigInt(row[0].epoch) > 9223372036854775807n || (row[0].epoch === "0") !== (row[0].owner_id === null)) throw pgError("STORE_IDENTITY");
}

/** Fixed transaction-side consumer only. Production authority issuance is deferred to P3. */
export async function verifyPostgreSQLFence(client: PoolClient, ns: (name: string) => string, storeId: string,
    frame?: PostgreSQLUnitFence): Promise<EntityLocalUnitOwnership> {
    await verifyFenceStructure(client, ns, storeId);
    const row = (await client.query(`SELECT store_id,required,owner_id,epoch::text AS epoch FROM ${ns("ep_fence")} WHERE singleton=TRUE FOR SHARE`)).rows[0];
    if (!frame || frame._revoked || frame._store_id !== storeId || row.store_id !== storeId || frame._owner_id !== row.owner_id ||
        !/^[1-9]\d*$/.test(frame._epoch) || frame._epoch !== row.epoch) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
    return Object.freeze({ _mode: "epoch-v1", _owner_id: frame._owner_id, _epoch: frame._epoch });
}

export type PostgreSQLMaintenanceOptions = { _connection: PostgreSQLConnectionOptions; _runtime_role: string; _entities: PostgreSQLStoreEntity[] };
async function maintenance<T>(options: PostgreSQLMaintenanceOptions, action: (client: PoolClient) => Promise<T>) {
    safeIdentifier(options._runtime_role);
    const pool = new Pool({ ...poolConfiguration(options._connection), max: 1 });
    pool.on("error", () => {});
    let client: PoolClient | undefined, submitted = false;
    try {
        client = await pool.connect();
        const server = (await client.query("SELECT current_user AS role, r.rolsuper, current_setting('server_version_num') AS version,current_setting('server_encoding') AS encoding,current_setting('fsync') AS fsync,current_setting('full_page_writes') AS pages FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
        if (server.rolsuper || server.role === options._runtime_role) throw pgError("ROLE");
        if (server.version !== "170012" || server.encoding !== "UTF8" || server.fsync !== "on" || server.pages !== "on") throw pgError("DURABILITY");
        await client.query("SELECT set_config('search_path','pg_catalog',false),set_config('TimeZone','UTC',false),set_config('synchronous_commit','on',false)");
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || $1,0))", [options._connection._schema]);
        const result = await action(client);
        submitted = true; await client.query("COMMIT"); return result;
    } catch (error) {
        if (client && !submitted) { try { await client.query("ROLLBACK"); } catch {} }
        throw sanitizedPGError(error, submitted);
    } finally { client?.release(true); await pool.end(); }
}

/** Explicit native bootstrap only. Ordinary provider init never calls this API. */
export async function initializePostgreSQLStore(options: PostgreSQLMaintenanceOptions & { _authorize_empty_store: true }) {
    if (options._authorize_empty_store !== true) throw pgError("INITIALIZATION_AUTHORITY");
    poolConfiguration(options._connection); // Validate raw limits before JSON cloning can normalize invalid values.
    options = { ...options, _connection: JSON.parse(JSON.stringify(options._connection)) };
    const inventory = postgresqlInventory(options._entities), c = options._connection;
    if (inventory._sha256 !== c._expected_inventory_sha256 || (c._expected_schema_version ?? 1) !== 1) throw pgError("SCHEMA_MISMATCH");
    return maintenance(options, async client => {
        const role = (await client.query("SELECT current_user AS name, r.rolsuper FROM pg_roles r WHERE rolname=current_user")).rows[0];
        if (role.rolsuper || role.name === options._runtime_role) throw pgError("ROLE");
        const runtimeRoleState = (await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,pg_has_role(rolname,current_user,'MEMBER') AS owner_member FROM pg_roles WHERE rolname=$1", [options._runtime_role])).rows[0];
        if (!runtimeRoleState || Object.values(runtimeRoleState).some(Boolean)) throw pgError("ROLE");
        const existing = (await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [c._schema])).rowCount;
        const objects = (await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' LIMIT 1")).rowCount;
        const otherObjects = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%') OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_extension WHERE extname<>'plpgsql') AS nonempty")).rows[0].nonempty;
        if (existing || objects || otherObjects) throw pgError("TARGET_NOT_EMPTY");
        const ns = (name: string) => pgNamespace(c._schema, name), runtimeRole = quote(options._runtime_role);
        await client.query(`CREATE SCHEMA ${quote(c._schema)}; REVOKE ALL ON SCHEMA ${quote(c._schema)} FROM PUBLIC; GRANT USAGE ON SCHEMA ${quote(c._schema)} TO ${runtimeRole}`);
        await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${quote(c._database)} FROM PUBLIC,${runtimeRole}`);
        await client.query(metadataDDL(c._schema));
        for (const l of inventory._layouts) {
            for (const sql of recordDDL(c._schema, l)) await client.query(sql);
            await client.query(`INSERT INTO ${ns("ep_entities")} VALUES($1,$2,$3,$4,$5,$6,$7)`, [digest(l._identity), l._identity, l._definition_hash, l._layout_hash, l._table, await fingerprint(client, c._schema, l._table), digest(canonicalJSON(recordDDL(c._schema, l)))]);
            await client.query(`GRANT SELECT,INSERT${l._append_only ? "" : ",UPDATE,DELETE"} ON ${ns(l._table)} TO ${runtimeRole}`);
        }
        await client.query(`INSERT INTO ${ns("ep_store")} VALUES(TRUE,$1,1,$2)`, [c._expected_store_id, inventory._sha256]);
        await client.query(`INSERT INTO ${ns("ep_migrations")} VALUES(1,$1)`, [MIGRATION_CHECKSUMS[1]]);
        for (const name of ["ep_store", "ep_migrations", "ep_entities"]) await client.query(`GRANT SELECT ON ${ns(name)} TO ${runtimeRole}`);
        await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${quote(c._schema)} FROM PUBLIC; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quote(c._schema)} TO ${runtimeRole}`);
        return { _store_id: c._expected_store_id, _schema_version: 1 as const, _inventory_sha256: inventory._sha256 };
    });
}

type PostgreSQLMigrationResult<V extends 2 | 3> = { _store_id: string; _schema_version: V; _inventory_sha256: string };
export function migratePostgreSQLStore(options: PostgreSQLMaintenanceOptions & { _from_version: 1; _to_version: 2 }): Promise<PostgreSQLMigrationResult<2>>;
export function migratePostgreSQLStore(options: PostgreSQLMaintenanceOptions & { _from_version: 2; _to_version: 3 }): Promise<PostgreSQLMigrationResult<3>>;
/** Reviewed metadata-only upgrades; no caller-authored SQL or implicit downgrade. */
export async function migratePostgreSQLStore(options: PostgreSQLMaintenanceOptions & ({ _from_version: 1; _to_version: 2 } | { _from_version: 2; _to_version: 3 })) {
    if (!(options._from_version === 1 && options._to_version === 2 || options._from_version === 2 && options._to_version === 3)) throw pgError("MIGRATION_UNSUPPORTED");
    poolConfiguration(options._connection);
    options = { ...options, _connection: JSON.parse(JSON.stringify(options._connection)) };
    const c = options._connection, inventory = postgresqlInventory(options._entities);
    return maintenance(options, async client => {
        const ns = (name: string) => pgNamespace(c._schema, name);
        const meta = (await client.query(`SELECT * FROM ${ns("ep_store")} WHERE singleton=TRUE FOR UPDATE`)).rows[0];
        const ledger = (await client.query(`SELECT * FROM ${ns("ep_migrations")} ORDER BY version`)).rows;
        if (!meta || meta.store_id !== c._expected_store_id || meta.schema_version !== options._from_version || meta.inventory_sha256 !== inventory._sha256
            || c._expected_inventory_sha256 !== inventory._sha256 || ledger.length !== options._from_version || ledger.some((m, i) => m.version !== i + 1 || m.checksum !== MIGRATION_CHECKSUMS[i + 1])
            || options._from_version === 2 && c._expected_schema_version !== 2) throw pgError("MIGRATION_MISMATCH");
        for (const l of inventory._layouts) {
            const row = (await client.query(`SELECT * FROM ${ns("ep_entities")} WHERE identity_hash=$1`, [digest(l._identity)])).rows[0];
            if (!row || row.physical_identity !== l._identity || row.definition_sha256 !== l._definition_hash || row.layout_sha256 !== l._layout_hash || row.ddl_sha256 !== await fingerprint(client, c._schema, l._table)
                || row.ddl_plan_sha256 !== digest(canonicalJSON(recordDDL(c._schema, l)))) throw pgError("SCHEMA_MISMATCH");
        }
        if (options._to_version === 2) {
            for (const sql of migrationV2SQL(c._schema)) await client.query(sql, sql.includes("$1") ? [MIGRATION_CHECKSUMS[2]] : undefined);
        } else {
            const sql = migrationV3SQL(c._schema, options._runtime_role);
            await client.query(sql[0]); await client.query(sql[1], [c._expected_store_id]);
            await client.query(sql[2]); await client.query(sql[3]);
            await client.query(sql[4], [MIGRATION_CHECKSUMS[3], "fence-v1:" + await fingerprint(client, c._schema, "ep_fence")]);
        }
        return { _store_id: c._expected_store_id, _schema_version: options._to_version, _inventory_sha256: inventory._sha256 };
    });
}
