import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { EntityProvider } from "./EntityProvider.js";
import { SQLiteEntityProvider } from "./SQLiteEntityProvider.js";
import { PostgreSQLEntityProvider } from "./PostgreSQLEntityProvider.js";
import { localUnitCanonical, localUnitError, type EntityLocalUnit, type EntityLocalUnitCapacityLimits, type EntityLocalUnitHashPolicy,
    type EntityLocalUnitOwnerContext, type EntityLocalUnitStoreIdentity, type EntityLocalUnitOwnership } from "./EntityLocalUnit.js";

/** Internal native dispatch. Not exported by the package or provisioned by a command. */
export type LocalUnitExecution = {
    _clock: () => number; _fault?: (point: string) => void;
    _hash_policy?: EntityLocalUnitHashPolicy; _limits: EntityLocalUnitCapacityLimits;
    _revalidate: () => void; _strict_final_checks: boolean; _owner_context?: EntityLocalUnitOwnerContext;
};
export type LocalUnitResult = {
    _records: { _entity: string; _record: any }[];
    _changed: { _entity: string; _record: any; _event: string }[];
    _durability: Record<string, unknown>; _ownership?: EntityLocalUnitOwnership;
};
export type NativeLocalUnitBackend = {
    _backend: "sqlite" | "postgresql";
    createDefaults(entity: string, input: Record<string, unknown>): Record<string, unknown>;
    verify(options: LocalUnitExecution): Promise<EntityLocalUnitStoreIdentity>;
    commit(unit: EntityLocalUnit, options: LocalUnitExecution): Promise<LocalUnitResult>;
};

/** Validate a committed response before any notification or confirmed acknowledgement.
 * Failure here says nothing about rollback: the caller must report an uncertain result.
 */
export async function validateCommittedLocalUnitResult(unit: EntityLocalUnit, raw: LocalUnitResult,
    backend: NativeLocalUnitBackend, schemaFor: (entity: string) => Record<string, any>, limits: EntityLocalUnitCapacityLimits): Promise<LocalUnitResult> {
    // Snapshot both lists before asynchronous Hash verification; never broadcast mutable backend data.
    const result: LocalUnitResult = JSON.parse(localUnitCanonical(raw));
    const fail = () => { throw localUnitError("E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN"); };
    const keys = (value: any, expected: string[]) => {
        if (!value || Array.isArray(value) || localUnitCanonical(Object.keys(value).sort()) !== localUnitCanonical([...expected].sort())) fail();
    };
    if (!Array.isArray(result._records) || !Array.isArray(result._changed) || result._records.length !== unit._records.length ||
        Buffer.byteLength(localUnitCanonical(result._records)) > limits._bytes) fail();
    const changes: LocalUnitResult["_changed"] = [];
    let stamp: string | undefined;
    for (const [i, op] of unit._records.entries()) {
        const item = result._records[i]; keys(item, ["_entity", "_record"]);
        if (item._entity !== op._entity) fail();
        const record = item._record, write = op._create !== undefined || op._update !== undefined;
        if (record !== null && (!record || Array.isArray(record) || typeof record !== "object" || record._id !== op._id)) fail();
        if (!write) {
            if (Object.hasOwn(op, "_expect") && localUnitCanonical(record) !== localUnitCanonical(op._expect)) fail();
            continue; // A pure observation or an exact absence guard may legitimately return null.
        }
        if (record === null || typeof record._updated_at !== "string" || !Number.isFinite(Date.parse(record._updated_at)) ||
            new Date(record._updated_at).toISOString() !== record._updated_at) fail();
        if (stamp !== undefined && stamp !== record._updated_at) fail();
        stamp = record._updated_at;
        const expected: Record<string, any> = op._create ? { ...backend.createDefaults(op._entity, op._create), ...op._create,
            _created_at: stamp, _updated_at: stamp } : { ...op._expect, ...op._update, _updated_at: stamp };
        if (op._create) for (const [key, field] of Object.entries(schemaFor(op._entity))) {
            if (String(field?._type).toLowerCase() !== "hash" || !Object.hasOwn(op._create, key)) continue;
            const encoded = record[key];
            if (typeof encoded !== "string" || !/^\$2[aby]\$10\$[./a-z0-9]{53}$/iu.test(encoded) ||
                !await bcrypt.compare(op._create[key], encoded)) fail();
            expected[key] = encoded;
        }
        if (localUnitCanonical(record) !== localUnitCanonical(expected)) fail();
        changes.push({ _entity: op._entity, _record: record, _event: op._create ? "xdb:create" : "xdb:update" });
    }
    // Exact count/order/entity/event/full-record consistency, with no guard notifications.
    if (localUnitCanonical(result._changed) !== localUnitCanonical(changes)) fail();
    return result;
}

export function resolveNativeLocalUnitBackend(providers: ReadonlyMap<string, EntityProvider>): NativeLocalUnitBackend {
    const list = [...providers.values()];
    if (!list.length) throw localUnitError("E_ENTITY_LOCAL_UNIT_STORAGE");
    // A capability string alone cannot grant native execution authority.
    if (list.every(p => p instanceof SQLiteEntityProvider)) {
        const sqlite = providers as ReadonlyMap<string, SQLiteEntityProvider>;
        const identity = Object.freeze({ _kind: "sqlite-binding-v1" as const, _id: randomUUID(), _lifetime: "bound-handle" as const });
        const commit = async (unit: EntityLocalUnit, o: LocalUnitExecution) => {
            if (o._owner_context !== undefined) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
            return SQLiteEntityProvider.commitLocalUnit(sqlite, unit, o._clock, o._fault, o._hash_policy,
                o._limits, o._revalidate, undefined, o._strict_final_checks);
        };
        return Object.freeze({ _backend: "sqlite" as const, commit,
            createDefaults: (name: string, input: Record<string, unknown>) => SQLiteEntityProvider.localUnitCreateDefaults(sqlite.get(name)!, input), verify: async (o: LocalUnitExecution) => {
            await commit({ _unit_id: randomUUID(), _records: [{ _entity: providers.keys().next().value!, _id: randomUUID() }] },
                { ...o, _fault: undefined });
            return identity;
        } });
    }
    if (list.every(p => p instanceof PostgreSQLEntityProvider)) {
        const pg = providers as ReadonlyMap<string, PostgreSQLEntityProvider>;
        return Object.freeze({ _backend: "postgresql" as const,
            createDefaults: (name: string, input: Record<string, unknown>) => PostgreSQLEntityProvider.localUnitCreateDefaults(pg.get(name)!, input),
            verify: (o: LocalUnitExecution) => PostgreSQLEntityProvider.verifyLocalUnit(pg, o),
            commit: (unit: EntityLocalUnit, o: LocalUnitExecution) => PostgreSQLEntityProvider.commitLocalUnit(pg, unit, o) });
    }
    throw localUnitError("E_ENTITY_LOCAL_UNIT_STORAGE");
}
