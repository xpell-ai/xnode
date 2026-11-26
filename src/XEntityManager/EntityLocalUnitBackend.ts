import { randomUUID } from "node:crypto";
import type { EntityProvider } from "./EntityProvider.js";
import { SQLiteEntityProvider } from "./SQLiteEntityProvider.js";
import { PostgreSQLEntityProvider } from "./PostgreSQLEntityProvider.js";
import { localUnitError, type EntityLocalUnit, type EntityLocalUnitCapacityLimits, type EntityLocalUnitHashPolicy,
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
    verify(options: LocalUnitExecution): Promise<EntityLocalUnitStoreIdentity>;
    commit(unit: EntityLocalUnit, options: LocalUnitExecution): Promise<LocalUnitResult>;
};

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
        return Object.freeze({ _backend: "sqlite" as const, commit, verify: async (o: LocalUnitExecution) => {
            await commit({ _unit_id: randomUUID(), _records: [{ _entity: providers.keys().next().value!, _id: randomUUID() }] },
                { ...o, _fault: undefined });
            return identity;
        } });
    }
    if (list.every(p => p instanceof PostgreSQLEntityProvider)) {
        const pg = providers as ReadonlyMap<string, PostgreSQLEntityProvider>;
        return Object.freeze({ _backend: "postgresql" as const,
            verify: (o: LocalUnitExecution) => PostgreSQLEntityProvider.verifyLocalUnit(pg, o),
            commit: (unit: EntityLocalUnit, o: LocalUnitExecution) => PostgreSQLEntityProvider.commitLocalUnit(pg, unit, o) });
    }
    throw localUnitError("E_ENTITY_LOCAL_UNIT_STORAGE");
}
