import fs from "node:fs";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { EntityPhysicalIdentity, EntityStorageScope } from "./EntityProvider.js";
import { resolve_entity_scope_identity } from "./EntityScope.js";
import { canonicalJSON, definitionDigest, digest, pgError, quote } from "./PostgreSQLValues.js";

export type PostgreSQLConnectionOptions = {
    _connection_string_env: string; _database: string; _schema: string; _expected_store_id: string;
    _expected_inventory_sha256: string; _expected_schema_version?: 1 | 2;
    _tls: { _mode: "verify" | "isolated-loopback"; _ca_file?: string };
    _pool?: { _max?: number; _max_waiting?: number };
    _timeouts?: { _acquire_ms?: number; _connect_ms?: number; _statement_ms?: number; _lock_ms?: number; _idle_transaction_ms?: number; _idle_ms?: number; _drain_ms?: number };
};
export type PostgreSQLPlacement = {
    _app_id?: string; _env?: string; _scope?: EntityStorageScope; _entities: string[]; _connection: string;
    _accepted_artifact_provider?: string; _definition_sha256?: Record<string, string>;
};
export type PostgreSQLRuntimeOptions = { _connections: Record<string, PostgreSQLConnectionOptions>; _placements: PostgreSQLPlacement[] };
export type PostgreSQLRuntimeHandle = { readonly _kind: "postgresql-runtime-v1"; close(): Promise<void>; diagnostics(): ReturnType<PostgreSQLRuntime["diagnostics"]> };
type Limits = { acquire: number; connect: number; statement: number; lock: number; idleTransaction: number; idle: number; drain: number; max: number; waiting: number };
type Entry = { config: PostgreSQLConnectionOptions; pool: Pool; limits: Limits; admitted: number; clients: Set<PoolClient>; idleFailures: number };
type CheckoutAttempt = { client?: PoolClient; expired: boolean };
export const pgNamespace = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;
export function safeIdentifier(value: string) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw pgError("CONFIG");
    return value;
}
function bounded(value: number | undefined, fallback: number, maximum: number, zero = false) {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1) || n > maximum) throw pgError("CONFIG");
    return n;
}
function allowedProperties(value: any, allowed: string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw pgError("CONFIG");
}
function limitsFor(c: PostgreSQLConnectionOptions): Limits {
    const t = c._timeouts;
    return { max: bounded(c._pool?._max, 10, 64), waiting: bounded(c._pool?._max_waiting, 32, 256, true),
        acquire: bounded(t?._acquire_ms, 5000, 60000), connect: bounded(t?._connect_ms, 5000, 60000),
        statement: bounded(t?._statement_ms, 5000, 60000), lock: bounded(t?._lock_ms, 1000, 60000),
        idleTransaction: bounded(t?._idle_transaction_ms, 5000, 60000), idle: bounded(t?._idle_ms, 30000, 300000), drain: bounded(t?._drain_ms, 10000, 60000) };
}

/** Internal only. Native maintenance APIs use the same strict connection parser. */
export function poolConfiguration(c: PostgreSQLConnectionOptions): PoolConfig {
    allowedProperties(c, ["_connection_string_env", "_database", "_schema", "_expected_store_id", "_expected_inventory_sha256", "_expected_schema_version", "_tls", "_pool", "_timeouts"]);
    allowedProperties(c._tls, ["_mode", "_ca_file"]);
    if (c._tls._ca_file !== undefined && typeof c._tls._ca_file !== "string") throw pgError("CONFIG");
    if (c._pool !== undefined) allowedProperties(c._pool, ["_max", "_max_waiting"]);
    if (c._timeouts !== undefined) allowedProperties(c._timeouts, ["_acquire_ms", "_connect_ms", "_statement_ms", "_lock_ms", "_idle_transaction_ms", "_idle_ms", "_drain_ms"]);
    for (const options of [c._pool, c._timeouts]) for (const v of Object.values(options ?? {})) if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw pgError("CONFIG");
    safeIdentifier(c._database); safeIdentifier(c._schema);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c._expected_store_id) || !/^[a-f0-9]{64}$/.test(c._expected_inventory_sha256)
        || ![1, 2].includes(c._expected_schema_version ?? 1) || !/^[A-Z][A-Z0-9_]*$/.test(c._connection_string_env)) throw pgError("CONFIG");
    const secret = process.env[c._connection_string_env];
    if (!secret) throw pgError("CONFIG");
    let url: URL;
    try { url = new URL(secret); decodeURIComponent(url.username); decodeURIComponent(url.password); decodeURIComponent(url.pathname); } catch { throw pgError("CONFIG"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash || url.search
        || decodeURIComponent(url.pathname.slice(1)) !== c._database) throw pgError("CONFIG");
    const policy = c._tls;
    if (!policy || !["verify", "isolated-loopback"].includes(policy._mode)) throw pgError("CONFIG");
    if (policy._mode === "isolated-loopback" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw pgError("CONFIG");
    let ssl: PoolConfig["ssl"];
    try { ssl = policy._mode === "verify" ? { rejectUnauthorized: true, ...(policy._ca_file ? { ca: fs.readFileSync(policy._ca_file, "utf8") } : {}) } : false; }
    catch { throw pgError("CONFIG"); }
    const l = limitsFor(c);
    return { connectionString: secret, ssl, max: l.max, min: 0, connectionTimeoutMillis: Math.min(l.connect, l.acquire),
        idleTimeoutMillis: l.idle, query_timeout: l.statement, statement_timeout: l.statement, lock_timeout: l.lock,
        idle_in_transaction_session_timeout: l.idleTransaction, application_name: "xpell-postgresql-v1", options: "" };
}

export function sanitizedPGError(error: any, commitSubmitted = false) {
    if (String(error?._code ?? "").startsWith("E_ENTITY_POSTGRESQL_")) return error;
    const state = String(error?.code ?? "");
    if (state === "23505" || state === "23502" || state === "23514") return pgError("CONSTRAINT");
    if (["40001", "40P01"].includes(state)) return pgError("CONFLICT");
    if (["57014", "55P03"].includes(state)) return pgError("TIMEOUT");
    if (state === "P0001") return pgError("GUARD");
    return pgError(commitSubmitted ? "WRITE_UNCERTAIN" : "UNAVAILABLE");
}

export class PostgreSQLRuntime {
    #entries = new Map<string, Entry>();
    #placements = new Map<string, { entry: Entry; policy: PostgreSQLPlacement }>();
    #closing?: Promise<void>;
    #closed = false;
    #appContexts = new Map<string, Entry>();
    #forced = new WeakSet<PoolClient>();
    #errorHandlers = new WeakMap<PoolClient, () => void>();

    constructor(options: PostgreSQLRuntimeOptions) {
        allowedProperties(options, ["_connections", "_placements"]);
        if (!options || !options._connections || !Array.isArray(options._placements) || !options._placements.length) throw pgError("CONFIG");
        const physical = new Map<string, Entry>();
        const storeIdentities = new Set<string>();
        try {
            for (const [name, raw] of Object.entries(options._connections)) {
                safeIdentifier(name);
                const poolConfig = poolConfiguration(raw);
                const config = JSON.parse(JSON.stringify(raw)) as PostgreSQLConnectionOptions;
                const limits = limitsFor(config);
                const url = new URL(poolConfig.connectionString!);
                const key = canonicalJSON([url.hostname, url.port || "5432", config._database, config._schema]);
                let entry = physical.get(key);
                if (entry) {
                    if (canonicalJSON(entry.config) !== canonicalJSON(config)) throw pgError("CONFIG_CONFLICT");
                } else {
                    if (storeIdentities.has(config._expected_store_id)) throw pgError("CONFIG_CONFLICT");
                    entry = { config, limits, pool: new Pool(poolConfig), admitted: 0, clients: new Set(), idleFailures: 0 };
                    const owned = entry;
                    owned.pool.on("error", () => { owned.idleFailures++; });
                    physical.set(key, entry);
                    storeIdentities.add(config._expected_store_id);
                }
                this.#entries.set(name, entry);
            }
            for (const original of options._placements) {
                allowedProperties(original, ["_app_id", "_env", "_scope", "_entities", "_connection", "_accepted_artifact_provider", "_definition_sha256"]);
                const policy: PostgreSQLPlacement = JSON.parse(JSON.stringify(original));
                if (policy._accepted_artifact_provider) {
                    policy._accepted_artifact_provider = policy._accepted_artifact_provider.trim().toLowerCase();
                    if (!["xdb", "memory", "sqlite", "mongo", "postgresql"].includes(policy._accepted_artifact_provider)) throw pgError("CONFIG");
                }
                const entry = this.#entries.get(policy._connection);
                if (!entry || !Array.isArray(policy._entities) || !policy._entities.length) throw pgError("CONFIG");
                for (const entity of policy._entities) {
                    const id = resolve_entity_scope_identity({ _provider: "postgresql", _app_id: policy._app_id, _env: policy._env,
                        _storage_scope: policy._scope ?? "app", _entity_id: entity });
                    if (id._storage_scope === "app") {
                        const key = canonicalJSON([id._app_id, id._env]), existing = this.#appContexts.get(key);
                        if (existing && existing !== entry) throw pgError("CONFIG_CONFLICT");
                        this.#appContexts.set(key, entry);
                    }
                    if (this.#placements.has(id._physical_identity)) throw pgError("CONFIG_CONFLICT");
                    if (policy._accepted_artifact_provider && !/^[a-f0-9]{64}$/.test(policy._definition_sha256?.[entity] ?? "")) throw pgError("CONFIG");
                    this.#placements.set(id._physical_identity, { entry, policy });
                }
            }
        } catch (error: any) { for (const e of new Set(this.#entries.values())) void e.pool.end(); throw String(error?._code ?? "").startsWith("E_ENTITY_POSTGRESQL_") ? error : pgError("CONFIG"); }
    }

    resolveProvider(definition: any, identity: EntityPhysicalIdentity, scope?: { _app_id?: unknown; _env?: unknown }) {
        const placement = this.#placements.get(identity._physical_identity);
        const context = scope ?? identity as EntityPhysicalIdentity & { _app_id?: unknown; _env?: unknown };
        if (context._app_id != null && context._env != null && context._app_id !== "" && context._env !== "") {
            const appIdentity = resolve_entity_scope_identity({ _provider: "postgresql", _app_id: context._app_id, _env: context._env, _entity_id: identity._logical_entity_id });
            if (this.#appContexts.has(canonicalJSON([appIdentity._app_id, appIdentity._env])) && (!placement || identity._storage_scope !== "app")) throw pgError("PLACEMENT");
        }
        if (!placement) { if (identity._provider === "postgresql") throw pgError("PLACEMENT"); return identity._provider; }
        const storage = definition?._storage ?? {};
        if (typeof storage !== "object" || Array.isArray(storage) || Object.keys(storage).some(k => !["_provider", "_scope", "_append_only"].includes(k))) throw pgError("PLACEMENT");
        const actual = String(definition?._storage?._provider ?? "xdb").trim().toLowerCase();
        if (actual !== "postgresql" && (placement.policy._accepted_artifact_provider !== actual
            || placement.policy._definition_sha256?.[identity._logical_entity_id] !== definitionDigest(definition))) throw pgError("PLACEMENT");
        return "postgresql" as const;
    }

    namespace(identity: EntityPhysicalIdentity, table: string) { return pgNamespace(this.#entry(identity).config._schema, table); }
    #entry(identity: EntityPhysicalIdentity) {
        const placement = this.#placements.get(identity._physical_identity);
        if (!placement || this.#closed) throw pgError("UNAVAILABLE");
        return placement.entry;
    }
    async #verify(client: PoolClient, entry: Entry) {
        const c = entry.config, l = entry.limits;
        await client.query("SELECT set_config('search_path','pg_catalog',false), set_config('TimeZone','UTC',false), set_config('synchronous_commit','on',false), set_config('statement_timeout',$1,false), set_config('lock_timeout',$2,false), set_config('idle_in_transaction_session_timeout',$3,false)", [String(l.statement), String(l.lock), String(l.idleTransaction)]);
        const settings = (await client.query("SELECT current_setting('server_version_num') AS version, current_setting('server_encoding') AS encoding, current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_pages, current_setting('synchronous_commit') AS synchronous, r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
        if (settings.version !== "170012" || settings.encoding !== "UTF8" || settings.fsync !== "on" || settings.full_pages !== "on" || settings.synchronous !== "on") throw pgError("DURABILITY");
        if ([settings.rolsuper, settings.rolcreatedb, settings.rolcreaterole, settings.rolreplication, settings.rolbypassrls].some(Boolean)) throw pgError("ROLE");
        if ((await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS unsafe")).rows[0].unsafe) throw pgError("ROLE");
        const meta = (await client.query(`SELECT store_id, schema_version, inventory_sha256 FROM ${pgNamespace(c._schema, "ep_store")} WHERE singleton=TRUE`)).rows;
        if (meta.length !== 1 || meta[0].store_id !== c._expected_store_id || meta[0].schema_version !== (c._expected_schema_version ?? 1)
            || meta[0].inventory_sha256 !== c._expected_inventory_sha256) throw pgError("STORE_IDENTITY");
        const privilege = (await client.query("SELECT has_schema_privilege(current_user,$1,'CREATE') AS create_schema, pg_has_role(current_user,n.nspowner,'MEMBER') AS owner FROM pg_namespace n WHERE n.nspname=$1", [c._schema])).rows[0];
        if (!privilege || privilege.create_schema || privilege.owner) throw pgError("ROLE");
    }

    async #checkout(entry: Entry, attempt: CheckoutAttempt) {
        let client: PoolClient | undefined;
        try {
            client = await entry.pool.connect(); entry.clients.add(client);
            attempt.client = client;
            const owned = client, handler = () => this.#destroy(entry, owned);
            this.#errorHandlers.set(client, handler); client.on("error", handler);
            if (attempt.expired) { this.#destroy(entry, client); throw pgError("TIMEOUT"); }
            await this.#verify(client, entry); return client;
        }
        catch (error) { if (client) this.#destroy(entry, client); throw sanitizedPGError(error); }
    }

    #destroy(entry: Entry, client: PoolClient) {
        if (this.#forced.has(client)) return;
        this.#forced.add(client); entry.clients.delete(client); client.release(true);
    }

    async withClient<T>(identity: EntityPhysicalIdentity, action: (client: PoolClient) => Promise<T>): Promise<T> {
        const e = this.#entry(identity);
        if (e.admitted >= e.limits.max + e.limits.waiting) throw pgError("POOL_SATURATED");
        e.admitted++;
        let client: PoolClient | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let destroyed = false;
        const attempt: CheckoutAttempt = { expired: false }, deadline = Date.now() + e.limits.acquire;
        const checkout = this.#checkout(e, attempt);
        try {
            client = await Promise.race([checkout, new Promise<never>((_, reject) => { timer = setTimeout(() => {
                attempt.expired = true; if (attempt.client) this.#destroy(e, attempt.client); reject(pgError("TIMEOUT"));
            }, e.limits.acquire); })]);
            clearTimeout(timer);
            if (Date.now() >= deadline) { this.#destroy(e, client); throw pgError("TIMEOUT"); }
            if (this.#closed) throw pgError("UNAVAILABLE");
            return await action(client);
        } catch (error: any) {
            destroyed = true;
            throw sanitizedPGError(error);
        } finally {
            clearTimeout(timer);
            if (client) {
                e.clients.delete(client);
                if (!this.#forced.has(client)) {
                    if (destroyed) this.#destroy(e, client);
                    else { const handler = this.#errorHandlers.get(client); if (handler) client.removeListener("error", handler); client.release(); }
                }
                e.admitted--;
            }
            else { void checkout.then(late => this.#destroy(e, late), () => {}).finally(() => { e.admitted--; }); }
        }
    }

    async transaction<T>(identity: EntityPhysicalIdentity, write: boolean, action: (client: PoolClient) => Promise<T>): Promise<T> {
        return this.withClient(identity, async client => {
            let commitSubmitted = false;
            const entry = this.#entry(identity), deadline = Date.now() + entry.limits.statement;
            let expired = false;
            const timer = setTimeout(() => { expired = true; this.#destroy(entry, client); }, entry.limits.statement);
            try {
                await client.query(write ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
                const result = await action(client);
                if (Date.now() >= deadline || expired) throw pgError("TIMEOUT");
                commitSubmitted = true;
                await client.query("COMMIT");
                return result;
            } catch (error) {
                if (!commitSubmitted) { try { await client.query("ROLLBACK"); } catch { /* broken client is discarded by withClient */ } }
                if (expired) throw pgError(write && commitSubmitted ? "WRITE_UNCERTAIN" : "TIMEOUT");
                throw sanitizedPGError(error, write && commitSubmitted);
            } finally { clearTimeout(timer); }
        });
    }

    diagnostics() {
        return { _closed: this.#closed, _stores: [...new Set(this.#entries.values())].map(e => ({ _store_id: e.config._expected_store_id,
            _total: e.pool.totalCount, _idle: e.pool.idleCount, _waiting: e.pool.waitingCount, _admitted: e.admitted, _idle_errors: e.idleFailures })) };
    }

    close(): Promise<void> {
        if (this.#closing) return this.#closing;
        this.#closed = true;
        this.#closing = (async () => {
            const results = await Promise.allSettled([...new Set(this.#entries.values())].map(async e => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([e.pool.end(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
                        for (const c of e.clients) this.#destroy(e, c);
                        reject(pgError("DRAIN_TIMEOUT"));
                    }, e.limits.drain); })]);
                } finally { clearTimeout(timer); }
            }));
            if (results.some(r => r.status === "rejected")) throw pgError("DRAIN_TIMEOUT");
        })();
        return this.#closing;
    }
}

const runtimeOwners = new WeakMap<PostgreSQLRuntimeHandle, PostgreSQLRuntime>();
/** Opaque native handle. No client, pool, SQL callback or transaction method is public. */
export function createPostgreSQLRuntime(options: PostgreSQLRuntimeOptions): PostgreSQLRuntimeHandle {
    const owner = new PostgreSQLRuntime(options);
    const handle: PostgreSQLRuntimeHandle = Object.freeze({ _kind: "postgresql-runtime-v1" as const,
        close: () => owner.close(), diagnostics: () => owner.diagnostics() });
    runtimeOwners.set(handle, owner); return handle;
}
/** @internal Provider/manager bridge; intentionally absent from package exports. */
export function getPostgreSQLRuntime(handle: PostgreSQLRuntimeHandle | undefined): PostgreSQLRuntime {
    const owner = handle && runtimeOwners.get(handle);
    if (!owner) throw pgError("CONFIG");
    return owner;
}
