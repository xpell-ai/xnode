import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { assertEntityLocalUnitHashCreateInput, localUnitCanonical, localUnitError, resolveLocalUnitHashPolicy,
    validateLocalUnit, type EntityLocalUnit } from "./EntityLocalUnit.js";
import type { LocalUnitExecution, LocalUnitResult } from "./EntityLocalUnitBackend.js";
import { normalizeScalar, projected, quote, sqliteStringKey, type PGLayout } from "./PostgreSQLValues.js";
import { whereSQL } from "./PostgreSQLQuery.js";
import { verifyEntitySchema, verifyPostgreSQLFence } from "./PostgreSQLSchema.js";

/** Provider-internal fixed storage protocol, not an application transaction API. */
export type PostgreSQLUnitEntity = { _layout: PGLayout; _namespace: (name: string) => string };
/** Already trusted transaction-side frame; production issuance belongs to P3. */
export type PostgreSQLUnitFence = { _store_id: string; _owner_id: string; _epoch: string; _revoked: boolean };
export type PreparedPostgreSQLUnit = { _unit: EntityLocalUnit; _values: (Record<string, any> | undefined)[] };

export async function preparePostgreSQLUnit(entities: ReadonlyMap<string, PostgreSQLUnitEntity>, raw: EntityLocalUnit, o: LocalUnitExecution): Promise<PreparedPostgreSQLUnit> {
    const unit = validateLocalUnit(raw, o._limits), hash = resolveLocalUnitHashPolicy(o._hash_policy);
    const values: PreparedPostgreSQLUnit["_values"] = [];
    for (const op of unit._records) {
        const layout = entities.get(op._entity)?._layout;
        if (!layout) throw localUnitError("E_ENTITY_LOCAL_UNIT_UNAUTHORIZED");
        const input = op._create ?? op._update;
        if (!input) { values.push(undefined); continue; }
        if (op._update && layout._append_only) throw localUnitError("E_ENTITY_APPEND_ONLY");
        if (op._update && !Object.keys(input).length) throw localUnitError();
        const hashes = layout._fields.filter(f => f._type === "hash");
        if (hashes.length && !hash) throw localUnitError("E_ENTITY_LOCAL_UNIT_SCHEMA");
        for (const field of hashes) {
            const explicit = Object.hasOwn(input, field._name);
            if (op._update && explicit) throw localUnitError("E_ENTITY_LOCAL_UNIT_HASH_MUTATION");
            if (op._create && explicit) assertEntityLocalUnitHashCreateInput(hash!._policy, input[field._name]);
            else if (op._create && (field._required || Object.hasOwn(layout._schema[field._name], "_default"))) throw localUnitError("E_ENTITY_LOCAL_UNIT_HASH_INPUT");
        }
        for (const key of Object.keys(input)) {
            const f = layout._fields.find(f => f._name === key);
            if (!f || ["_created_at", "_updated_at"].includes(key) || op._update && (f._immutable || input[key] == null)) throw localUnitError();
        }
        const out: Record<string, any> = {};
        try {
            for (const field of layout._fields) {
                const key = field._name, spec = layout._schema[key], supplied = Object.hasOwn(input, key);
                if (["_created_at", "_updated_at"].includes(key)) continue;
                if (!supplied && (op._update || !Object.hasOwn(spec, "_default"))) {
                    if (op._create && field._required) throw localUnitError("E_ENTITY_LOCAL_UNIT_SCHEMA");
                    continue;
                }
                const v = supplied ? input[key] : spec._default;
                out[key] = field._type === "hash" ? await bcrypt.hash(v, 10) : normalizeScalar(layout, key, v);
                if (supplied && field._type !== "hash" && localUnitCanonical(out[key]) !== localUnitCanonical(v)) throw localUnitError();
            }
        } catch { throw localUnitError("E_ENTITY_LOCAL_UNIT_SCHEMA"); }
        values.push(out);
    }
    // No fast fingerprint of a credential-bearing proposal. Only bounded canonical validation.
    validateLocalUnit({ ...unit, _records: unit._records.map((op, i) => values[i]
        ? { ...op, ...(op._create ? { _create: values[i] } : { _update: values[i] }) } : op) }, o._limits);
    return { _unit: unit, _values: values };
}

function validNow(clock: () => number) {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw localUnitError();
    return now;
}

/** Internal fixed-unit SQL kernel. No caller SQL/callback, checkout, or public raw handle. */
export async function executePostgreSQLUnit(client: PoolClient, entities: ReadonlyMap<string, PostgreSQLUnitEntity>,
    prepared: PreparedPostgreSQLUnit, store: { _id: string; _schema_version: number; _inventory_sha256: string }, o: LocalUnitExecution,
    fence?: PostgreSQLUnitFence): Promise<LocalUnitResult & { _finalize: () => void }> {
    const { _unit: unit, _values: values } = prepared;
    o._revalidate();
    const first = entities.values().next().value!;
    const actual = (await client.query(`SELECT store_id,schema_version,inventory_sha256 FROM ${first._namespace("ep_store")} WHERE singleton=TRUE`)).rows;
    if (actual.length !== 1 || actual[0].store_id !== store._id || actual[0].schema_version !== store._schema_version ||
        actual[0].inventory_sha256 !== store._inventory_sha256) throw localUnitError("E_ENTITY_LOCAL_UNIT_STORAGE");
    const ownership = store._schema_version === 3
        ? await verifyPostgreSQLFence(client, first._namespace, store._id, fence)
        : { _mode: "unfenced" as const };
    if (fence && store._schema_version !== 3) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
    for (const e of entities.values()) await verifyEntitySchema(client, e._namespace, e._layout);
    const policy = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('synchronous_commit') AS synchronous,current_setting('fsync') AS fsync,current_setting('full_page_writes') AS pages")).rows[0];
    if (policy.isolation !== "serializable" || policy.synchronous !== "on" || policy.fsync !== "on" || policy.pages !== "on") throw localUnitError("E_ENTITY_LOCAL_UNIT_DURABILITY");
    const now = validNow(o._clock), rows: any[] = new Array(unit._records.length);
    const ordered = unit._records.map((op, i) => ({ op, i, e: entities.get(op._entity)! }))
        .sort((a, b) => a.e._layout._identity < b.e._layout._identity ? -1 : a.e._layout._identity > b.e._layout._identity ? 1
            : Buffer.compare(sqliteStringKey(a.op._id), sqliteStringKey(b.op._id)));
    let locked = 0;
    for (const { op, i, e } of ordered) {
        const where = whereSQL(e._layout, { _id: op._id });
        // Accepted append-only roles deliberately have SELECT/INSERT but no UPDATE.
        // Those records cannot change under qualified writers; SSI covers absence.
        // Mutable targets/guards take row locks in the same deterministic order.
        const result = (await client.query(`SELECT _row_key,_json FROM ${e._namespace(e._layout._table)}${where._sql}${e._layout._append_only ? "" : " FOR UPDATE"}`, where._values)).rows;
        if (result.length > 1) throw localUnitError("E_ENTITY_LOCAL_UNIT_CONFLICT");
        rows[i] = result.length ? { _row_key: result[0]._row_key, _record: JSON.parse(result[0]._json) } : { _record: null };
        if (rows[i]._record !== null && rows[i]._record._id !== op._id) throw localUnitError("E_ENTITY_LOCAL_UNIT_SCHEMA");
        if (Object.hasOwn(op, "_expect") && localUnitCanonical(op._expect) !== localUnitCanonical(rows[i]._record)) throw localUnitError("E_ENTITY_LOCAL_UNIT_CONFLICT");
        o._fault?.(`after_lock_${++locked}`);
    }
    const check = () => {
        o._revalidate();
        const clock = validNow(o._clock);
        if (unit._valid_until !== undefined && clock >= unit._valid_until) throw localUnitError("E_ENTITY_LOCAL_UNIT_EXPIRED");
        if (fence?._revoked) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
        if (unit._lease) {
            const lease = unit._lease, row = rows[unit._records.findIndex(op => op._entity === lease._entity && op._id === lease._id)]._record;
            if (!row || row._state !== "claimed" || row._owner_id !== lease._owner_id || row._owner_epoch !== lease._owner_epoch ||
                row._version !== lease._version || !Number.isSafeInteger(row._lease_expires_at) || row._lease_expires_at <= clock) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
        }
    };
    check(); o._fault?.("after_guards");
    const changed: LocalUnitResult["_changed"] = [];
    const records: LocalUnitResult["_records"] = [];
    let count = 0;
    for (const [i, op] of unit._records.entries()) {
        const e = entities.get(op._entity)!, value = values[i];
        if (!value) { records.push({ _entity: op._entity, _record: rows[i]._record }); continue; }
        const stamp = new Date(now).toISOString();
        const record = op._create ? { ...value, _created_at: stamp, _updated_at: stamp }
            : { ...rows[i]._record, ...value, _updated_at: stamp };
        const columns = ["_json", ...e._layout._fields.map(f => f._column)];
        const params = [JSON.stringify(record), ...e._layout._fields.map(f => projected(f, record[f._name]))];
        const result = op._create
            ? await client.query(`INSERT INTO ${e._namespace(e._layout._table)} (${["_row_key", ...columns].map(quote).join(",")}) VALUES (${Array.from({ length: params.length + 1 }, (_, j) => `$${j + 1}`).join(",")})`, [randomUUID(), ...params])
            : await client.query(`UPDATE ${e._namespace(e._layout._table)} SET ${columns.map((c, j) => `${quote(c)}=$${j + 1}`).join(",")} WHERE _row_key=$${params.length + 1}`, [...params, rows[i]._row_key]);
        if (result.rowCount !== 1) throw localUnitError("E_ENTITY_LOCAL_UNIT_CONFLICT");
        records.push({ _entity: op._entity, _record: record });
        changed.push({ _entity: op._entity, _record: record, _event: op._create ? "xdb:create" : "xdb:update" });
        o._fault?.(`after_write_${++count}`);
    }
    if (Buffer.byteLength(localUnitCanonical(records)) > o._limits._bytes) throw localUnitError();
    // Final database checks precede the synchronous native COMMIT guard.
    const finalPolicy = (await client.query("SELECT current_setting('synchronous_commit') AS synchronous,current_setting('transaction_isolation') AS isolation")).rows[0];
    if (finalPolicy.synchronous !== "on" || finalPolicy.isolation !== "serializable") throw localUnitError("E_ENTITY_LOCAL_UNIT_DURABILITY");
    return { _records: records, _changed: changed,
        _durability: { _backend: "postgresql", _profile: "postgresql-local-durable-v1" }, _ownership: ownership,
        _finalize: () => { if (count) o._fault?.("before_commit"); check(); } };
}
