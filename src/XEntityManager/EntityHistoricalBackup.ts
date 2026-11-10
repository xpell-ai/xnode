import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { XError } from "@xpell/core";
import { openEntityHistoricalImport, ENTITY_HISTORICAL_IMPORT_CAPABILITIES, ENTITY_HISTORICAL_IMPORT_RUNTIME,
    historicalImportTimestamp, type EntityHistoricalImportBinding, type EntityHistoricalImportUnit } from "./EntityHistoricalImport.js";
import { localUnitCanonical as canonical, localUnitHash as hash, localUnitGuid, validateLocalUnit } from "./EntityLocalUnit.js";
import { registerHistoricalOwner, requireHistoricalOwner, type HistoricalOwner } from "./EntityHistoricalOwner.js";

export const ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES = Object.freeze({
    _version: 1 as const, _format: "quarantined-import-backup-v1" as const,
    _backup: "sqlite-online" as const, _encryption: "aes-256-gcm" as const,
    _restore: "new-owner-rebind-v1" as const, _ownership: "hmac-sha256-physical-binding-v1" as const, _quarantined: true as const, _financial_ready: false as const
});
/** Protocol identity only. Deployments must independently pin the package artifact. */
export const ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME = hash({
    _backup: ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES, _import: ENTITY_HISTORICAL_IMPORT_RUNTIME
});
type Policy = Readonly<{
    _expected_capability: typeof ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES;
    /** Complete independently approved original import units, including guards/leases. Never inferred from receipts. */
    _units: readonly EntityHistoricalImportUnit[];
    _key_id: string; _key: Uint8Array;
    /** Trusted host fault injection only; not a command/transport parameter. */
    _fault?: (point: string) => void;
}>;
export type EntityHistoricalBackupOptions = Policy & Readonly<{ _owner: object; _destination: string }>;
export type EntityHistoricalRestoreOptions = Policy & Omit<EntityHistoricalImportBinding, "_expected_capability" | "_fault"> &
    Readonly<{ _backup: string; _restore_id: string }>;
export type BoundEntityHistoricalRestore = Readonly<{
    _restore: Readonly<Record<string, any>>; _import: Readonly<Record<string, any>>;
    reconcile: () => Promise<any>; close: () => Promise<void>;
}>;
const capability = ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES;
const runtime = ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME;
const restoreTable = "entity_historical_import_restores";
const markerName = "historical-restore.pending";
const maxImage = 512 * 1024 * 1024, maxMetadata = 32 * 1024 * 1024;
const fail = (code = "E_ENTITY_HISTORICAL_BACKUP_INVALID"): never => { throw new XError(code, code); };
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const seal = (key: Buffer, fact: any) => createHmac("sha256", key).update("xpell-historical-restore-binding-v1\0").update(canonical(fact)).digest("hex");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const quote = (name: string) => '"' + name.replace(/"/gu, '""') + '"';
const digest = (v: any) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const exact = (v: any, keys: string[]) => { if (!v || typeof v !== "object" || !same(Object.keys(v).sort(), [...keys].sort())) fail(); };
const freeze = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
function policy(options: Policy): Buffer {
    if (!same(options._expected_capability, capability) || !Array.isArray(options._units) ||
        typeof options._key_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(options._key_id) ||
        !(options._key instanceof Uint8Array) || options._key.byteLength !== 32) fail();
    return Buffer.from(options._key);
}
function privateDir(dir: string): string {
    if (typeof dir !== "string" || !path.isAbsolute(dir)) fail();
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid?.()) fail();
    return fs.realpathSync(dir);
}
function newPath(requested: string): string {
    if (typeof requested !== "string" || !path.isAbsolute(requested)) fail();
    const parent = privateDir(path.dirname(requested)), result = path.join(parent, path.basename(requested));
    if (fs.existsSync(result)) fail();
    return result;
}
function identity(file: string) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o077) || s.uid !== process.getuid?.()) fail();
    return { _dev: s.dev, _ino: s.ino };
}
function syncDir(dir: string) { const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function write(file: string, bytes: Uint8Array) {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function read(file: string, max: number): Buffer {
    const expected = identity(file), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const s = fs.fstatSync(fd);
        if (s.size > max || !same(expected, { _dev: s.dev, _ino: s.ino })) fail();
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
const ddl = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as any[];
const restoreDDL = `CREATE TABLE ${restoreTable} (_id INTEGER PRIMARY KEY, _json TEXT NOT NULL);
CREATE TRIGGER historical_restore_update BEFORE UPDATE ON ${restoreTable} BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END;
CREATE TRIGGER historical_restore_delete BEFORE DELETE ON ${restoreTable} BEGIN SELECT RAISE(ABORT,'E_ENTITY_IMPORT_IMMUTABLE'); END;`;
function expectedRestoreDDL() { const db = new Database(":memory:"); try { db.exec(restoreDDL); return ddl(db); } finally { db.close(); } }
function rows(db: Database.Database, table: string) {
    return db.prepare(`SELECT * FROM ${quote(table)}`).all().sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
}
function ready(db: Database.Database) {
    const result = { _journal_mode: db.pragma("journal_mode", { simple: true }),
        _synchronous: db.pragma("synchronous", { simple: true }), _foreign_keys: db.pragma("foreign_keys", { simple: true }) };
    if (!same(result, { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1 })) fail();
    return result;
}
function configure(db: Database.Database) {
    db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
    return ready(db);
}

/** No writes/default insertion. The fresh v1 verifier supplies independently derived DDL and record validators. */
function inspect(db: Database.Database, owner: HistoricalOwner, units: readonly EntityHistoricalImportUnit[]) {
    const schema = ddl(db), baseSchema = schema.filter(row => row.tbl_name !== restoreTable);
    if (!same(baseSchema, owner._ddl) || hash(baseSchema) !== owner._metadata._ddl_sha256) fail();
    const metaRows = db.prepare("SELECT _id,_json FROM entity_historical_import_meta").all() as any[];
    if (metaRows.length !== 1 || metaRows[0]._id !== 1) fail();
    const meta = JSON.parse(metaRows[0]._json);
    exact(meta, ["_base", "_schema_root", "_ddl_sha256"]);
    exact(meta._base, ["_version", "_state", "_manifest_sha256", "_source", "_destination", "_database", "_owner"]);
    for (const id of [meta._base._database, meta._base._owner]) {
        exact(id, ["_dev", "_ino"]);
        if (!Number.isSafeInteger(id._dev) || !Number.isSafeInteger(id._ino) || id._ino <= 0) fail();
    }
    if (meta._base._version !== 1 || meta._base._state !== "quarantined" || !digest(meta._base._destination) ||
        meta._base._manifest_sha256 !== owner._manifest_sha256 || !same(meta._base._source, owner._metadata._base._source) ||
        meta._schema_root !== owner._metadata._schema_root || meta._ddl_sha256 !== owner._metadata._ddl_sha256) fail();
    const withoutTime = (values: readonly any[]) => values.map(({ updated_at, ...v }) => {
        if (!historicalImportTimestamp(updated_at)) fail(); return v;
    });
    if (!same(withoutTime(db.prepare("SELECT * FROM entity_provider_meta ORDER BY physical_entity_name").all()), withoutTime(owner._provider_meta)) ||
        !same(withoutTime(db.prepare("SELECT * FROM entity_provider_indexes ORDER BY physical_entity_name,field_name").all()), withoutTime(owner._provider_indexes))) fail();
    const progress = owner.inspectRecords(db);
    if (!progress._complete || !units.length && progress._receipts) fail("E_ENTITY_HISTORICAL_BACKUP_INCOMPLETE");
    const receipts = db.prepare("SELECT _id,_json FROM entity_historical_import_receipts ORDER BY _id").all() as any[];
    const expected = new Map<string, any>();
    for (const input of units) {
        if (Object.keys(input).some(k => !["_records", "_lease", "_valid_until"].includes(k))) fail();
        const unit = validateLocalUnit({ ...input, _unit_id: owner._manifest._run_id }, owner._capacity._limits);
        const creates = unit._records.filter(op => op._create !== undefined);
        if (!creates.length || unit._records.some(op => op._update !== undefined || !Object.hasOwn(op, "_expect") ||
            !owner._definitions.some(def => def._id === op._entity))) fail();
        const refs = creates.map(op => ({ _entity: op._entity, _id: op._id, _sha256: hash(op._create) }))
            .sort((a, b) => canonical([a._entity, a._id]) < canonical([b._entity, b._id]) ? -1 : 1);
        const raw = hash({ _run_id: owner._manifest._run_id, _manifest: owner._manifest_sha256, _records: refs });
        const id = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20,32)}`;
        const receipt = { _id: id, _run_id: owner._manifest._run_id, _manifest_sha256: owner._manifest_sha256,
            _record_root: hash(refs), _records: refs,
            _unit_sha256: hash({ _records: unit._records, _lease: unit._lease ?? null, _valid_until: unit._valid_until ?? null }) };
        if (expected.has(id)) fail(); expected.set(id, receipt);
        validateLocalUnit({ ...unit, _records: [...unit._records, { _entity: "@xpell/historical-import-receipt", _id: id, _expect: null,
            _create: { ...receipt, _committed_at: "2000-01-01T00:00:00.000Z" } }] }, owner._capacity._limits);
    }
    if (expected.size !== receipts.length) fail();
    for (const row of receipts) {
        const { _committed_at, ...receipt } = JSON.parse(row._json);
        if (!same(receipt, expected.get(row._id)) || _committed_at < owner._manifest._captured_at) fail();
    }
    const originalMeta = bytesHash(Buffer.from(metaRows[0]._json));
    const historyDDL = schema.filter(row => row.tbl_name === restoreTable);
    const history = historyDDL.length ? db.prepare(`SELECT _id,_json FROM ${restoreTable} ORDER BY _id`).all() as any[] : [];
    if (historyDDL.length && (!same(historyDDL, expectedRestoreDDL()) || !history.length)) fail();
    const facts: any[] = [], ids = new Set();
    for (const row of history) {
        const fact = JSON.parse(row._json);
        exact(fact, ["_version", "_restore_id", "_snapshot_sha256", "_backup_id", "_manifest_sha256", "_original_meta_sha256",
            "_original_ddl_sha256", "_prior_restore_root", "_binding", "_restored_at", "_runtime", "_seal"]);
        if (row._id !== facts.length + 1 || fact._version !== 1 || !localUnitGuid(fact._restore_id) || ids.has(fact._restore_id) ||
            !localUnitGuid(fact._backup_id) || !digest(fact._seal) || !digest(fact._snapshot_sha256) || fact._manifest_sha256 !== owner._manifest_sha256 ||
            fact._original_meta_sha256 !== originalMeta || fact._original_ddl_sha256 !== meta._ddl_sha256 ||
            fact._prior_restore_root !== hash(facts) || fact._runtime !== runtime || !historicalImportTimestamp(fact._restored_at)) fail();
        exact(fact._binding, ["_destination", "_database", "_owner", "_marker", "_directory"]);
        if (!digest(fact._binding._destination) || !digest(fact._binding._marker)) fail();
        for (const id of [fact._binding._database, fact._binding._owner, fact._binding._directory]) {
            exact(id, ["_dev", "_ino"]); if (!Number.isSafeInteger(id._dev) || !Number.isSafeInteger(id._ino) || id._ino <= 0) fail();
        }
        facts.push(fact); ids.add(fact._restore_id);
    }
    const physical = baseSchema.filter(row => row.type === "table").map(row => ({ _table: row.name, _rows: rows(db, row.name) }));
    return { _records: progress._records, _receipts: progress._receipts, _record_root: owner._manifest._record_root,
        _receipt_root: progress._receipt_root, _original_meta_sha256: originalMeta, _original_ddl_sha256: meta._ddl_sha256,
        _physical_root: hash(physical), _restore_root: hash(facts), _restores: facts };
}

function unpack(options: EntityHistoricalRestoreOptions, key: Buffer) {
    const bundle = privateDir(options._backup);
    if (!same(fs.readdirSync(bundle).sort(), ["envelope.json", "snapshot.gcm"])) fail();
    const header = JSON.parse(read(path.join(bundle, "envelope.json"), 4096).toString("utf8"));
    exact(header, ["_format", "_version", "_key_id", "_nonce"]);
    if (header._format !== capability._format || header._version !== 1 || header._key_id !== options._key_id ||
        !/^[a-f0-9]{24}$/u.test(header._nonce)) fail();
    const encrypted = read(path.join(bundle, "snapshot.gcm"), maxImage + maxMetadata + 20);
    if (encrypted.length < 20) fail();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header._nonce, "hex"));
    decipher.setAAD(Buffer.from(canonical(header))); decipher.setAuthTag(encrypted.subarray(-16));
    let plain: Buffer | undefined;
    try {
        plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
        const length = plain.readUInt32BE(0);
        if (length > maxMetadata || length + 4 >= plain.length) fail();
        const metadata = JSON.parse(plain.subarray(4, 4 + length).toString("utf8")), image = Buffer.from(plain.subarray(4 + length));
        exact(metadata, ["_version", "_runtime", "_import_runtime", "_backup_id", "_manifest_sha256", "_definitions_sha256", "_capacity",
            "_sqlite_version", "_image_sha256", "_image_bytes", "_proof"]);
        if (metadata._version !== 1 || metadata._runtime !== runtime || metadata._import_runtime !== ENTITY_HISTORICAL_IMPORT_RUNTIME ||
            !localUnitGuid(metadata._backup_id) || metadata._manifest_sha256 !== options._manifest_sha256 ||
            hash(options._manifest) !== options._manifest_sha256 || metadata._definitions_sha256 !== hash(options._entities) ||
            image.length > maxImage || metadata._image_bytes !== image.length || bytesHash(image) !== metadata._image_sha256) { image.fill(0); fail(); }
        return { metadata, image };
    } finally { plain?.fill(0); }
}

/** Trusted host API only. A live owner cannot be reconstructed from an acknowledgement or transport command. */
export async function backupEntityHistoricalImport(options: EntityHistoricalBackupOptions): Promise<any> {
    let key: Buffer | undefined, scratch: string | undefined, connection: Database.Database | undefined;
    try {
        if (Object.keys(options).some(k => !["_owner", "_destination", "_units", "_expected_capability", "_key_id", "_key", "_fault"].includes(k))) fail();
        key = policy(options);
        const owner = requireHistoricalOwner(options._owner), units = JSON.parse(canonical(options._units));
        const destination = newPath(options._destination);
        if (destination === owner._destination || destination.startsWith(owner._destination + path.sep)) fail();
        connection = new Database(owner._file, { readonly: true, fileMustExist: true });
        connection.pragma("synchronous = FULL"); connection.pragma("foreign_keys = ON"); ready(connection);
        const before = connection.transaction(() => inspect(connection!, owner, units))();
        scratch = fs.mkdtempSync(path.join(path.dirname(destination), ".historical-backup-")); fs.chmodSync(scratch, 0o700);
        const imagePath = path.join(scratch, "image.sqlite"); write(imagePath, Buffer.alloc(0));
        options._fault?.("backup_before_native");
        await connection.backup(imagePath, { progress: () => { owner.assertOwned(); options._fault?.("backup_progress"); return 32; } });
        owner.assertOwned(); options._fault?.("backup_after_native");
        const snapshot = new Database(imagePath, { readonly: true, fileMustExist: true });
        let proof: ReturnType<typeof inspect>, sqlite: any;
        try { snapshot.pragma("foreign_keys = ON"); proof = inspect(snapshot, owner, units); sqlite = snapshot.prepare("SELECT sqlite_version() AS version").get(); }
        finally { snapshot.close(); }
        if (!same(before, proof)) fail();
        const image = read(imagePath, maxImage), id = randomUUID();
        try {
            const metadata = { _version: 1, _runtime: runtime, _import_runtime: ENTITY_HISTORICAL_IMPORT_RUNTIME,
                _backup_id: id, _manifest_sha256: owner._manifest_sha256, _definitions_sha256: hash(owner._definitions),
                _capacity: owner._capacity, _sqlite_version: (sqlite as any).version,
                _image_sha256: bytesHash(image), _image_bytes: image.length, _proof: proof };
            const metaBytes = Buffer.from(canonical(metadata)); if (metaBytes.length > maxMetadata) fail();
            const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metaBytes.length);
            const header = { _format: capability._format, _version: 1, _key_id: options._key_id, _nonce: randomBytes(12).toString("hex") };
            const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header._nonce, "hex")); cipher.setAAD(Buffer.from(canonical(header)));
            const encrypted = Buffer.concat([cipher.update(prefix), cipher.update(metaBytes), cipher.update(image), cipher.final(), cipher.getAuthTag()]);
            options._fault?.("backup_before_encrypted_write");
            write(path.join(scratch, "snapshot.gcm"), encrypted); write(path.join(scratch, "envelope.json"), Buffer.from(canonical(header)));
            // Completed publications contain encrypted material only, never SQLite scratch sidecars.
            for (const file of fs.readdirSync(scratch)) if (file !== "snapshot.gcm" && file !== "envelope.json") fs.unlinkSync(path.join(scratch, file));
            syncDir(scratch); owner.assertOwned(); options._fault?.("backup_before_publish");
            // mkdir is an atomic no-replace claim, including across processes. Publish the authenticated envelope last.
            fs.mkdirSync(destination, { mode: 0o700 }); options._fault?.("backup_after_reserve");
            fs.renameSync(path.join(scratch, "snapshot.gcm"), path.join(destination, "snapshot.gcm"));
            syncDir(destination);
            fs.renameSync(path.join(scratch, "envelope.json"), path.join(destination, "envelope.json"));
            syncDir(destination); syncDir(path.dirname(destination));
            options._fault?.("backup_after_publish");
            return freeze({ _backup: capability, _runtime: runtime, _backup_id: id, _snapshot_sha256: metadata._image_sha256,
                _manifest_sha256: owner._manifest_sha256, _record_root: proof._record_root, _receipt_root: proof._receipt_root,
                _records: proof._records, _receipts: proof._receipts, _quarantined: true, _financial_ready: false });
        } finally { image.fill(0); }
    } catch { fail("E_ENTITY_HISTORICAL_BACKUP_REJECTED"); }
    finally { if (connection?.open) connection.close(); key?.fill(0); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** New private destination only. Reopening an acknowledged/ambiguous restore is an explicit separate operation. */
export const restoreEntityHistoricalImport = (options: EntityHistoricalRestoreOptions) => restore(options, false);
export const resumeEntityHistoricalImportRestore = (options: EntityHistoricalRestoreOptions) => restore(options, true);

async function restore(options: EntityHistoricalRestoreOptions, resume: boolean): Promise<BoundEntityHistoricalRestore> {
    let key: Buffer | undefined, image: Buffer | undefined, scratch: string | undefined;
    let verifier: Awaited<ReturnType<typeof openEntityHistoricalImport>> | undefined;
    let db: Database.Database | undefined, lock: Database.Database | undefined;
    try {
        if (Object.keys(options).some(k => !["_backup", "_destination", "_restore_id", "_units", "_expected_capability", "_key_id", "_key", "_fault",
            "_manifest", "_manifest_sha256", "_entities", "_capacity_profile", "_clock"].includes(k)) || !localUnitGuid(options._restore_id)) fail();
        key = policy(options);
        options = { ...options, _manifest: JSON.parse(canonical(options._manifest)), _entities: JSON.parse(canonical(options._entities)),
            _units: JSON.parse(canonical(options._units)) };
        const decoded = unpack(options, key); image = decoded.image;
        // Independent approval is checked by the unchanged v1 factory in an empty private verifier store.
        const parent = privateDir(path.dirname(options._destination));
        scratch = fs.mkdtempSync(path.join(parent, ".historical-verifier-")); fs.chmodSync(scratch, 0o700);
        verifier = await openEntityHistoricalImport({ _destination: path.join(scratch, "schema"), _manifest: options._manifest,
            _manifest_sha256: options._manifest_sha256, _entities: options._entities, _capacity_profile: options._capacity_profile,
            _expected_capability: ENTITY_HISTORICAL_IMPORT_CAPABILITIES });
        const context = requireHistoricalOwner(verifier), units = freeze(JSON.parse(canonical(options._units)));
        if (!same(decoded.metadata._capacity, context._capacity)) fail();
        const verifiedImage = path.join(scratch, "authenticated-image.sqlite"); write(verifiedImage, image);
        const source = new Database(verifiedImage, { readonly: true, fileMustExist: true });
        let original: ReturnType<typeof inspect>;
        try { source.pragma("foreign_keys = ON"); original = inspect(source, context, units); }
        finally { source.close(); }
        if (!same(original, decoded.metadata._proof)) fail();
        options._fault?.("restore_after_authentication");
        const destination = resume ? privateDir(options._destination) : newPath(options._destination);
        const marker = Buffer.from(canonical({ _version: 1, _runtime: runtime, _restore_id: options._restore_id,
            _snapshot_sha256: decoded.metadata._image_sha256, _manifest_sha256: options._manifest_sha256 }));
        if (!resume) {
            fs.mkdirSync(destination, { mode: 0o700 });
            write(path.join(destination, markerName), marker); syncDir(destination); syncDir(parent);
        } else if (!read(path.join(destination, markerName), 4096).equals(marker)) fail();
        const file = path.join(destination, "database.sqlite"), ownerFile = path.join(destination, "owner.sqlite");
        if (!resume) { write(file, Buffer.alloc(0)); write(ownerFile, Buffer.alloc(0)); }
        const binding = { _destination: hash(destination), _database: identity(file), _owner: identity(ownerFile), _marker: bytesHash(marker),
            _directory: { _dev: fs.lstatSync(destination).dev, _ino: fs.lstatSync(destination).ino } };
        lock = new Database(ownerFile, { fileMustExist: true }); lock.pragma("busy_timeout = 0"); lock.exec("BEGIN EXCLUSIVE");
        const owned = lock; let closed = false;
        const assertOwned = () => {
            if (closed || !owned.open || !owned.inTransaction || privateDir(destination) !== destination ||
                !same(identity(file), binding._database) || !same(identity(ownerFile), binding._owner) ||
                !read(path.join(destination, markerName), 4096).equals(marker) ||
                !same({ _dev: fs.lstatSync(destination).dev, _ino: fs.lstatSync(destination).ino }, binding._directory)) fail();
        };
        if (!resume) {
            options._fault?.("restore_before_image_write");
            const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
            try { fs.writeFileSync(fd, image); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            assertOwned(); options._fault?.("restore_after_image_write");
        }
        db = new Database(file, { fileMustExist: true }); const connection = db;
        const durability = configure(connection);
        const restoredAt = new Date((options._clock ?? Date.now)()).toISOString();
        if (!historicalImportTimestamp(restoredAt) || restoredAt < context._manifest._captured_at ||
            (original._restores.length && restoredAt < original._restores.at(-1)._restored_at)) fail();
        if (!resume) {
            connection.transaction(() => {
                assertOwned(); const copied = inspect(connection, context, units);
                if (!same(copied, original) || original._restores.some(fact => fact._restore_id === options._restore_id)) fail();
                if (!original._restores.length) connection.exec(restoreDDL);
                const fact = { _version: 1, _restore_id: options._restore_id, _snapshot_sha256: decoded.metadata._image_sha256,
                    _backup_id: decoded.metadata._backup_id, _manifest_sha256: options._manifest_sha256,
                    _original_meta_sha256: original._original_meta_sha256, _original_ddl_sha256: original._original_ddl_sha256,
                    _prior_restore_root: original._restore_root, _binding: binding, _restored_at: restoredAt, _runtime: runtime };
                connection.prepare(`INSERT INTO ${restoreTable} VALUES(?,?)`).run(original._restores.length + 1, canonical({ ...fact, _seal: seal(key!, fact) }));
                options._fault?.("restore_before_rebind_commit");
            }).immediate();
            options._fault?.("restore_after_rebind_commit"); syncDir(destination);
        }
        const saved = connection.prepare(`SELECT _json FROM ${restoreTable} ORDER BY _id DESC LIMIT 1`).get() as any;
        if (!saved) fail();
        const currentFact = freeze(JSON.parse(saved._json)), { _seal, ...unsigned } = currentFact;
        if (!digest(_seal) || !timingSafeEqual(Buffer.from(_seal, "hex"), Buffer.from(seal(key, unsigned), "hex"))) fail();
        const validate = () => connection.transaction(() => {
            assertOwned(); ready(connection);
            const current = inspect(connection, context, units), fact = current._restores.at(-1);
            const { _restore_root, _restores, ...facts } = current;
            const { _restore_root: oldRoot, _restores: oldFacts, ...old } = original;
            if (!same(facts, old) || !same(_restores.slice(0, -1), oldFacts) || !fact ||
                fact._restore_id !== options._restore_id || fact._snapshot_sha256 !== decoded.metadata._image_sha256 ||
                fact._backup_id !== decoded.metadata._backup_id || !same(fact, currentFact) || !same(fact._binding, binding) || fact._prior_restore_root !== oldRoot) fail();
            return current;
        })();
        const checked = validate();
        const acknowledgement = freeze({ ...capability, _runtime: runtime, _restore_id: options._restore_id,
            _snapshot_sha256: decoded.metadata._image_sha256, _manifest_sha256: options._manifest_sha256,
            _record_root: checked._record_root, _receipt_root: checked._receipt_root, _physical_root: checked._physical_root,
            _restore_root: checked._restore_root, _records: checked._records, _receipts: checked._receipts, _durability: durability });
        const handle = Object.freeze({ _restore: acknowledgement, _import: freeze({ ...context._import }),
            reconcile: async () => { try { validate(); return { _ok: true, _result: acknowledgement }; }
                catch { return { _ok: false, _result: { _code: "E_ENTITY_HISTORICAL_RESTORE_INTEGRITY", _quarantined: true, _financial_ready: false } }; } },
            close: async () => { if (!closed) { closed = true; connection.close(); owned.close(); } } });
        registerHistoricalOwner(handle, { ...context, _file: file, _destination: destination, assertOwned: () => { validate(); } });
        options._fault?.("restore_before_acknowledgement");
        // Successful owners retain only their actual database/lock. Validation closures are data-only after disposal.
        await verifier.close(); verifier = undefined; fs.rmSync(scratch, { recursive: true, force: true }); scratch = undefined;
        db = undefined; lock = undefined;
        return handle;
    } catch { return fail("E_ENTITY_HISTORICAL_RESTORE_REJECTED"); }
    finally {
        if (db?.open) db.close(); if (lock?.open) lock.close(); key?.fill(0); image?.fill(0);
        await verifier?.close(); if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
}
