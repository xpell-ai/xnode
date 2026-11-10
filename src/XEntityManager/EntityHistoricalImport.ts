import fs from "node:fs";
import { registerHistoricalOwner } from "./EntityHistoricalOwner.js";
import path from "node:path";
import Database from "better-sqlite3";
import { _xu } from "@xpell/core";
import { SQLiteEntityProvider } from "./SQLiteEntityProvider.js";
import { resolve_entity_scope_identity } from "./EntityScope.js";
import { ENTITY_LOCAL_UNIT_CAPABILITIES, ENTITY_LOCAL_UNIT_HASH_CAPABILITIES, localUnitCanonical, localUnitGuid, localUnitHash, resolveLocalUnitCapacity, validateLocalUnit, type EntityLocalUnit, type EntityLocalUnitCapacityProfile } from "./EntityLocalUnit.js";
import { XError } from "@xpell/core";

export const ENTITY_HISTORICAL_IMPORT_CAPABILITIES = Object.freeze({
    _version: 1 as const, _policy: "preserve-historical-v1" as const,
    _guid: "preserve" as const, _hash: "preserve-valid-bcrypt" as const,
    _timestamps: "preserve-canonical-utc" as const, _writes: "source-bound-creates-only" as const,
    _receipt: "atomic-append-only-v1" as const, _destination: "new-quarantined-v1" as const,
    _financial_ready: false as const
});
/** Contract identity, not an artifact signature. Hosts must also verify their pinned artifact. */
export const ENTITY_HISTORICAL_IMPORT_RUNTIME = localUnitHash({
    _import: ENTITY_HISTORICAL_IMPORT_CAPABILITIES,
    _capacity: ENTITY_LOCAL_UNIT_CAPABILITIES, _hash: ENTITY_LOCAL_UNIT_HASH_CAPABILITIES
});
export type EntityHistoricalImportManifest = Readonly<{
    _version: 1; _run_id: string; _destination_id: string; _source_id: string;
    _source_root: string; _record_root: string; _captured_at: string;
    _env: string; _app_id: string; _runtime: string;
    _entities: readonly Readonly<{ _entity: string; _schema_sha256: string;
        _records: readonly Readonly<{ _id: string; _sha256: string }>[] }>[];
}>;
export type EntityHistoricalImportBinding = Readonly<{
    _destination: string;
    _manifest: EntityHistoricalImportManifest;
    /** Independent trusted approval anchor for the verified frozen source manifest. */
    _manifest_sha256: string;
    _expected_capability: typeof ENTITY_HISTORICAL_IMPORT_CAPABILITIES;
    _entities: readonly any[];
    _capacity_profile?: EntityLocalUnitCapacityProfile;
    _clock?: () => number;
    _fault?: (point: string) => void;
}>;
export type EntityHistoricalImportUnit = Omit<EntityLocalUnit, "_unit_id">;
export type BoundEntityHistoricalImport = Readonly<{
    _import: Readonly<Record<string, any>>;
    _capacity: ReturnType<typeof resolveLocalUnitCapacity>;
    commit: (unit: EntityHistoricalImportUnit) => Promise<any>;
    reconcile: () => Promise<any>;
    close: () => Promise<void>;
}>;
const error = (code = "E_ENTITY_HISTORICAL_IMPORT_INVALID") => new XError(code, code);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
export const historicalImportTimestamp = (v: unknown): v is string => typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const guid = (v: any) => { if (!localUnitGuid(v)) throw error(); };
const keys = (v: any, names: string[]) => {
    if (!_xu.is_plain_object(v) || Object.keys(v).sort().join() !== [...names].sort().join()) throw error();
};
const freeze = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const identity = (file: string) => {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw error("E_ENTITY_HISTORICAL_IMPORT_DESTINATION");
    return { _dev: s.dev, _ino: s.ino };
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const definitionHash = (definition: any) => localUnitHash(definition);
const ddlHash = (db: Database.Database) => localUnitHash(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
const receiptName = "entity_historical_import_receipts";
const metaName = "entity_historical_import_meta";
const receiptEntity = "@xpell/historical-import-receipt";

// Opaque per-transaction authority. Serialized objects cannot populate either registry.
type ImportContext = {
    _captured_at: string;
    approve: (op: any, values: any) => void;
    before: (db: Database.Database) => any;
    after: (db: Database.Database) => void;
};
const contexts = new WeakMap<object, ImportContext>();
const providers = new WeakSet<SQLiteEntityProvider>();
export function historicalImportContext(token: object): ImportContext {
    const context = contexts.get(token); if (!context) throw error("E_ENTITY_HISTORICAL_IMPORT_UNAUTHORIZED"); return context;
}
export const isHistoricalImportProvider = (provider: SQLiteEntityProvider) => providers.has(provider);

/** Internal trusted factory; EntityManager retains the returned authority privately. */
export async function openEntityHistoricalImport(options: EntityHistoricalImportBinding): Promise<BoundEntityHistoricalImport> {
    const manifestHash = options._manifest_sha256, clock = options._clock ?? Date.now, fault = options._fault;
    let owner: Database.Database | undefined, inspect: Database.Database | undefined;
    const entities = new Map<string, SQLiteEntityProvider>();
    try {
        if (Object.keys(options).some(k => !["_destination", "_manifest", "_manifest_sha256", "_expected_capability", "_entities", "_capacity_profile", "_clock", "_fault"].includes(k))) throw error();
        if (localUnitCanonical(options._expected_capability) !== localUnitCanonical(ENTITY_HISTORICAL_IMPORT_CAPABILITIES)) throw error("E_ENTITY_HISTORICAL_IMPORT_RUNTIME");
        const manifest = freeze(JSON.parse(localUnitCanonical(options._manifest))) as EntityHistoricalImportManifest;
        keys(manifest, ["_version", "_run_id", "_destination_id", "_source_id", "_source_root", "_record_root", "_captured_at", "_env", "_app_id", "_runtime", "_entities"]);
        if (manifest._version !== 1 || manifest._runtime !== ENTITY_HISTORICAL_IMPORT_RUNTIME) throw error("E_ENTITY_HISTORICAL_IMPORT_RUNTIME");
        if (!digest(manifestHash) || localUnitHash(manifest) !== manifestHash ||
            !digest(manifest._source_root) || !digest(manifest._record_root) || !historicalImportTimestamp(manifest._captured_at) ||
            typeof manifest._env !== "string" || !manifest._env || typeof manifest._app_id !== "string" || !manifest._app_id) throw error("E_ENTITY_HISTORICAL_IMPORT_SOURCE");
        for (const id of [manifest._run_id, manifest._destination_id, manifest._source_id]) guid(id);
        const capacity = resolveLocalUnitCapacity(options._capacity_profile);
        const approved = new Map<string, string>(), inventory: any[] = [], schemas = new Map<string, string>();
        if (!Array.isArray(manifest._entities) || !manifest._entities.length || manifest._entities.length > 128) throw error();
        for (const entity of manifest._entities) {
            keys(entity, ["_entity", "_schema_sha256", "_records"]);
            if (typeof entity._entity !== "string" || !entity._entity || entity._entity === receiptEntity || schemas.has(entity._entity) ||
                !digest(entity._schema_sha256) || !Array.isArray(entity._records)) throw error();
            schemas.set(entity._entity, entity._schema_sha256);
            const seen = new Set<string>();
            for (const row of entity._records) {
                keys(row, ["_id", "_sha256"]); guid(row._id);
                if (!digest(row._sha256) || seen.has(row._id.toLowerCase()) || approved.size >= 100000) throw error("E_ENTITY_HISTORICAL_IMPORT_SOURCE");
                seen.add(row._id.toLowerCase()); approved.set(JSON.stringify([entity._entity, row._id]), row._sha256);
                inventory.push({ _entity: entity._entity, _id: row._id, _sha256: row._sha256 });
            }
        }
        inventory.sort((a, b) => compare(localUnitCanonical([a._entity, a._id]), localUnitCanonical([b._entity, b._id])));
        if (localUnitHash(inventory) !== manifest._record_root) throw error("E_ENTITY_HISTORICAL_IMPORT_SOURCE");
        const definitions = JSON.parse(localUnitCanonical(options._entities));
        if (!Array.isArray(definitions) || definitions.length !== schemas.size) throw error("E_ENTITY_HISTORICAL_IMPORT_SCHEMA");
        const names = new Set();
        for (const def of definitions) {
            if (Object.values(def?._schema ?? {}).some((field: any) => String(field?._type).toLowerCase() === "hash" &&
                ["_default", "_enum"].some(key => Object.hasOwn(field, key)))) throw error("E_ENTITY_HISTORICAL_IMPORT_SCHEMA");
            if (names.has(def._id) || schemas.get(def._id) !== definitionHash(def) || def._storage?._provider !== "sqlite" || def._storage?._scope !== "app" ||
                Object.keys(def._storage).some(k => !["_provider", "_scope", "_append_only"].includes(k))) throw error("E_ENTITY_HISTORICAL_IMPORT_SCHEMA");
            const scope = resolve_entity_scope_identity({ _env: manifest._env, _app_id: manifest._app_id, _entity_id: def._id, _provider: "sqlite" });
            if (scope._env !== manifest._env || scope._app_id !== manifest._app_id || scope._logical_entity_id !== def._id) throw error("E_ENTITY_HISTORICAL_IMPORT_SCOPE");
            names.add(def._id); freeze(def);
        }
        if (typeof options._destination !== "string" || !path.isAbsolute(options._destination)) throw error("E_ENTITY_HISTORICAL_IMPORT_DESTINATION");
        const requested = path.resolve(options._destination), parent = fs.realpathSync(path.dirname(requested));
        const destination = path.join(parent, path.basename(requested));
        let fresh = false;
        try { fs.mkdirSync(destination, { mode: 0o700 }); fresh = true; }
        catch (e: any) { if (e.code !== "EEXIST") throw e; }
        const dir = fs.lstatSync(destination);
        if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) throw error("E_ENTITY_HISTORICAL_IMPORT_DESTINATION");
        const file = path.join(destination, "database.sqlite"), lock = path.join(destination, "owner.sqlite");
        if (!fresh && (!fs.existsSync(file) || !fs.existsSync(lock))) throw error("E_ENTITY_HISTORICAL_IMPORT_DESTINATION");
        if (fresh) { for (const f of [file, lock]) fs.closeSync(fs.openSync(f, "wx", 0o600)); }
        const dbIdentity = identity(file), lockIdentity = identity(lock);
        owner = new Database(lock, { fileMustExist: true }); owner.pragma("busy_timeout = 0");
        try { owner.exec("BEGIN EXCLUSIVE"); } catch { throw error("E_ENTITY_HISTORICAL_IMPORT_OWNED"); }
        const owned = owner;
        let closed = false;
        const assertOwned = () => {
            if (closed || !owned.open || !owned.inTransaction || localUnitCanonical(identity(file)) !== localUnitCanonical(dbIdentity) ||
                localUnitCanonical(identity(lock)) !== localUnitCanonical(lockIdentity) || fs.realpathSync(destination) !== destination) throw error("E_ENTITY_HISTORICAL_IMPORT_FENCED");
        };
        inspect = new Database(file, { fileMustExist: true });
        inspect.pragma("journal_mode = WAL"); inspect.pragma("synchronous = FULL"); inspect.pragma("foreign_keys = ON"); inspect.pragma("busy_timeout = 5000");
        const db = inspect;
        // Persist bounded identities/roots, not an unbounded source inventory. The
        // independently approved complete manifest is required again on restart.
        const base = { _version: 1, _state: "quarantined", _manifest_sha256: manifestHash,
            _source: { _run_id: manifest._run_id, _destination_id: manifest._destination_id, _source_id: manifest._source_id,
                _source_root: manifest._source_root, _record_root: manifest._record_root, _captured_at: manifest._captured_at,
                _env: manifest._env, _app_id: manifest._app_id, _runtime: manifest._runtime },
            _destination: localUnitHash(destination), _database: dbIdentity, _owner: lockIdentity };
        if (Buffer.byteLength(localUnitCanonical(base)) > capacity._limits._bytes) throw error();
        if (fresh) {
            db.transaction(() => {
                db.exec(`CREATE TABLE ${metaName} (_id INTEGER PRIMARY KEY CHECK(_id=1), _json TEXT NOT NULL);
                    CREATE TABLE ${receiptName} (_id TEXT PRIMARY KEY NOT NULL, _json TEXT NOT NULL);
                    CREATE TRIGGER import_receipt_update BEFORE UPDATE ON ${receiptName} BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END;
                    CREATE TRIGGER import_receipt_delete BEFORE DELETE ON ${receiptName} BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END;`);
                db.prepare(`INSERT INTO ${metaName} VALUES(1,?)`).run(localUnitCanonical({ ...base, _state: "initializing" }));
            }).immediate();
        } else {
            const row = db.prepare(`SELECT _json FROM ${metaName} WHERE _id=1`).get() as any;
            const saved = row && JSON.parse(row._json);
            if (!saved || localUnitCanonical(saved._base) !== localUnitCanonical(base)) throw error("E_ENTITY_HISTORICAL_IMPORT_DESTINATION");
        }
        for (const def of definitions) {
            const p = new SQLiteEntityProvider({ _definition: def,
                _physical_identity: resolve_entity_scope_identity({ _env: manifest._env, _app_id: manifest._app_id, _entity_id: def._id, _provider: "sqlite" }),
                _runtime_context: { _work_folder: destination, _sqlite_require_full_durability: true },
                // Internal physical location; never inserted into approved schema definitions.
                _historical_database: file });
            providers.add(p); entities.set(def._id, p); await p.init();
        }
        const tables = new Map([...entities].map(([name, p]) => [name, p.getDebugStats()._table_name]));
        const quote = (name: string) => '"' + name.replace(/"/gu, '""') + '"';
        if (fresh) {
            for (const table of tables.values()) for (const op of ["UPDATE", "DELETE"]) db.exec(
                `CREATE TRIGGER ${quote(`${table}_historical_${op.toLowerCase()}`)} BEFORE ${op} ON ${quote(table)} BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END`);
        }
        const schemaRoot = localUnitHash([...entities].map(([name, p]) => ({ _entity: name, _schema: p.getSchema() })).sort((a,b)=>compare(a._entity,b._entity)));
        const metadata = { _base: base, _schema_root: schemaRoot, _ddl_sha256: ddlHash(db) };
        if (fresh) db.prepare(`UPDATE ${metaName} SET _json=? WHERE _id=1`).run(localUnitCanonical(metadata));
        else if ((db.prepare(`SELECT _json FROM ${metaName} WHERE _id=1`).get() as any)?._json !== localUnitCanonical(metadata)) throw error("E_ENTITY_HISTORICAL_IMPORT_SCHEMA");
        const ack = freeze({ ...ENTITY_HISTORICAL_IMPORT_CAPABILITIES, _run_id: manifest._run_id, _destination_id: manifest._destination_id,
            _source_id: manifest._source_id, _source_root: manifest._source_root, _record_root: manifest._record_root,
            _manifest_sha256: manifestHash, _schema_root: schemaRoot, _runtime: ENTITY_HISTORICAL_IMPORT_RUNTIME, _quarantined: true });
        const assertSchema = (connection: Database.Database) => {
            assertOwned();
            if (ddlHash(connection) !== metadata._ddl_sha256 || (connection.prepare(`SELECT _json FROM ${metaName} WHERE _id=1`).get() as any)?._json !== localUnitCanonical(metadata)) throw error("E_ENTITY_HISTORICAL_IMPORT_SCHEMA");
        };
        const read = (connection: Database.Database, entity: string, id: string) => {
            const row = connection.prepare(`SELECT _json FROM ${quote(tables.get(entity)!)} WHERE _id=?`).get(id) as any;
            return row ? JSON.parse(row._json) : null;
        };
        const approve = (op: any, values: any) => {
            if (approved.get(JSON.stringify([op._entity, op._id])) !== localUnitHash(values)) throw error("E_ENTITY_HISTORICAL_IMPORT_SOURCE");
        };
        assertSchema(db);
        const commit = async (raw: EntityHistoricalImportUnit) => {
            try {
                assertOwned();
                const copied = JSON.parse(localUnitCanonical(raw));
                if (Object.keys(copied).some(k => !["_records", "_lease", "_valid_until"].includes(k))) throw error();
                const unit = validateLocalUnit({ ...copied, _unit_id: manifest._run_id }, capacity._limits);
                const creates = unit._records.filter(op => op._create !== undefined);
                if (!creates.length || unit._records.some(op => op._update !== undefined || !entities.has(op._entity) || !Object.hasOwn(op, "_expect"))) throw error();
                const used = new Set(unit._records.map(op => op._entity));
                if (used.size + 1 > capacity._limits._entities) throw error("E_ENTITY_LOCAL_UNIT_CAPACITY");
                // Validate preserved values before computing any record/proposal fingerprint.
                for (const op of unit._records) {
                    const value = op._create ?? op._expect;
                    if (!value) throw error();
                    const p = entities.get(op._entity)!;
                    p.validateHistoricalRecord(value, manifest._captured_at); approve(op, value);
                }
                const refs = creates.map(op => ({ _entity: op._entity, _id: op._id, _sha256: approved.get(JSON.stringify([op._entity, op._id]))! }))
                    .sort((a,b)=>compare(localUnitCanonical([a._entity,a._id]),localUnitCanonical([b._entity,b._id])));
                const proposal = localUnitHash({ _records: unit._records, _lease: unit._lease ?? null, _valid_until: unit._valid_until ?? null });
                const rawID = localUnitHash({ _run_id: manifest._run_id, _manifest: manifestHash, _records: refs });
                const id = `${rawID.slice(0,8)}-${rawID.slice(8,12)}-${rawID.slice(12,16)}-${rawID.slice(16,20)}-${rawID.slice(20,32)}`;
                const receiptBase = { _id: id, _run_id: manifest._run_id, _manifest_sha256: manifestHash,
                    _record_root: localUnitHash(refs), _records: refs, _unit_sha256: proposal };
                const now = clock();
                if (!Number.isSafeInteger(now) || now < Date.parse(manifest._captured_at)) throw error();
                const receipt = { ...receiptBase, _committed_at: new Date(now).toISOString() };
                // The genuine maintenance receipt consumes one record, write, entity and bytes.
                validateLocalUnit({ ...unit, _records: [...unit._records, { _entity: receiptEntity, _id: id, _expect: null, _create: receipt }] }, capacity._limits);
                const token = {}, result = () => ({ _import: ack, _capacity: capacity, _receipt: receipt,
                    _durability: { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1 }, _quarantined: true, _financial_ready: false });
                let committedReceipt: any = receipt, replay = false;
                contexts.set(token, { _captured_at: manifest._captured_at, approve,
                    before: connection => {
                        assertSchema(connection);
                        const row = connection.prepare(`SELECT _json FROM ${receiptName} WHERE _id=?`).get(id) as any;
                        if (!row) return undefined;
                        const stored = JSON.parse(row._json), { _committed_at, ...rest } = stored;
                        if (!historicalImportTimestamp(_committed_at) || localUnitCanonical(rest) !== localUnitCanonical(receiptBase)) throw error("E_ENTITY_HISTORICAL_IMPORT_INTEGRITY");
                        for (const ref of refs) approve(ref, read(connection, ref._entity, ref._id));
                        committedReceipt = stored; replay = true;
                        return { _records: [], _changed: [], _durability: { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1 } };
                    },
                    after: connection => {
                        connection.prepare(`INSERT INTO ${receiptName} VALUES(?,?)`).run(id, localUnitCanonical(receipt));
                        fault?.(`after_write_${creates.length + 1}`);
                    }
                });
                try {
                    const selected = new Map([...entities].filter(([name]) => used.has(name)));
                    await SQLiteEntityProvider.commitLocalUnit(selected, unit, clock, fault, undefined, capacity._limits, assertOwned, token);
                    if (!replay) fault?.("after_commit");
                    return { _ok: true, _result: { ...result(), _receipt: committedReceipt, _replayed: replay } };
                } finally { contexts.delete(token); }
            } catch { return { _ok: false, _result: { _code: "E_ENTITY_HISTORICAL_IMPORT_REJECTED", _quarantined: true, _financial_ready: false } }; }
        };
        // Pure image validation also serves the separately opted-in backup contract.
        const inspectRecords = (connection: Database.Database) => {
                    if (connection.pragma("integrity_check", { simple: true }) !== "ok" || (connection.pragma("foreign_key_check") as any[]).length) throw error();
                    const present = new Set<string>();
                    for (const [name, table] of tables) for (const row of connection.prepare(`SELECT * FROM ${quote(table)}`).all() as any[]) {
                        const value = JSON.parse(row._json);
                        entities.get(name)!.validateHistoricalStoredRow(row);
                        entities.get(name)!.validateHistoricalRecord(value, manifest._captured_at); approve({ _entity: name, _id: row._id }, value);
                        present.add(JSON.stringify([name,row._id]));
                    }
                    const covered = new Set<string>(), receipts: any[] = [];
                    for (const row of connection.prepare(`SELECT _id,_json FROM ${receiptName} ORDER BY _id`).all() as any[]) {
                        const value = JSON.parse(row._json);
                        keys(value, ["_id", "_run_id", "_manifest_sha256", "_record_root", "_records", "_unit_sha256", "_committed_at"]);
                        const rawID = localUnitHash({ _run_id: manifest._run_id, _manifest: manifestHash, _records: value._records });
                        const expectedID = `${rawID.slice(0,8)}-${rawID.slice(8,12)}-${rawID.slice(12,16)}-${rawID.slice(16,20)}-${rawID.slice(20,32)}`;
                        if (value._id !== expectedID || !digest(value._unit_sha256) || row._id !== value._id || value._run_id !== manifest._run_id || value._manifest_sha256 !== manifestHash ||
                            !historicalImportTimestamp(value._committed_at) || !Array.isArray(value._records) || localUnitHash(value._records) !== value._record_root) throw error();
                        for (const ref of value._records) {
                            keys(ref, ["_entity", "_id", "_sha256"]);
                            const key = JSON.stringify([ref._entity,ref._id]);
                            if (approved.get(key) !== ref._sha256 || !present.has(key) || covered.has(key)) throw error(); covered.add(key);
                        }
                        receipts.push(value);
                    }
                    if (covered.size !== present.size) throw error();
                    return { _import: ack, _complete: present.size === approved.size, _records: present.size,
                        _expected_records: approved.size, _receipts: receipts.length, _receipt_root: localUnitHash(receipts), _quarantined: true, _financial_ready: false };
        };
        const reconcile = async () => {
            try {
                const result = db.transaction(() => {
                    assertSchema(db);
                    return inspectRecords(db);
                })();
                return { _ok: true, _result: result };
            } catch { return { _ok: false, _result: { _code: "E_ENTITY_HISTORICAL_IMPORT_INTEGRITY", _quarantined: true, _financial_ready: false } }; }
        };
        const handle = Object.freeze({ _import: ack, _capacity: capacity, commit, reconcile,
            close: async () => { if (!closed) { closed = true; for (const p of entities.values()) await p.dispose(); db.close(); owned.close(); } } });
        registerHistoricalOwner(handle, { _file: file, _destination: destination, _manifest: manifest, _manifest_sha256: manifestHash,
            _definitions: definitions, _metadata: metadata, _capacity: capacity, _import: ack,
            _ddl: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
            _provider_meta: db.prepare("SELECT * FROM entity_provider_meta ORDER BY physical_entity_name").all(),
            _provider_indexes: db.prepare("SELECT * FROM entity_provider_indexes ORDER BY physical_entity_name,field_name").all(),
            assertOwned: () => assertSchema(db), inspectRecords });
        return handle;
    } catch {
        for (const p of entities.values()) await p.dispose();
        if (inspect?.open) inspect.close(); if (owner?.open) owner.close();
        throw error("E_ENTITY_HISTORICAL_IMPORT_UNAVAILABLE");
    }
}
