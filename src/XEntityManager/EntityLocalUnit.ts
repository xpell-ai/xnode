import { createHash } from "node:crypto";
import { XError, _xu } from "@xpell/core";

export type EntityLocalUnitCapacityProfile = "standard-v1" | "expanded-v1";
export type EntityLocalUnitHashPolicy = "create-and-preserve-v1";
export type EntityLocalUnitHashAcknowledgement = Readonly<{
    _version: 1;
    _policy: EntityLocalUnitHashPolicy;
    _create: "provider-bcrypt-10";
    _update: "preserve-existing-hash";
    _prehashed_create: "reject";
}>;

/** Supplemental opt-in contract; independent of the unchanged capacity protocol. */
export const ENTITY_LOCAL_UNIT_HASH_CAPABILITIES = Object.freeze({
    _version: 1 as const,
    _policies: Object.freeze({
        "create-and-preserve-v1": Object.freeze({
            _create: "provider-bcrypt-10" as const,
            _update: "preserve-existing-hash" as const,
            _prehashed_create: "reject" as const
        })
    })
});

/** Supplied create-value admissibility only; grants no storage or Hash authority. */
export const ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES = Object.freeze({
    _version: 1 as const,
    _policies: Object.freeze({
        "create-and-preserve-v1": Object.freeze({
            _create: "strict-plaintext-v1" as const
        })
    })
});

/** Shared by preflight and native preparation. Never normalizes, hashes or stores input. */
export function assertEntityLocalUnitHashCreateInput(policy: EntityLocalUnitHashPolicy, value: unknown): void {
    if (policy !== "create-and-preserve-v1") throw localUnitError("E_ENTITY_LOCAL_UNIT_HASH_POLICY");
    // bcrypt silently truncates beyond 72 UTF-8 bytes. No coercion,
    // null/default credential, or encoded hash import is authorized.
    if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 72 ||
        /^(?:\$[a-z0-9]+\$|\{(?:s?sha\d*|s?md5)\}|[a-f0-9]{32,128}$)/iu.test(value)) {
        throw localUnitError("E_ENTITY_LOCAL_UNIT_HASH_INPUT");
    }
}

const hashAcknowledgement: EntityLocalUnitHashAcknowledgement = Object.freeze({
    _version: 1, _policy: "create-and-preserve-v1",
    ...ENTITY_LOCAL_UNIT_HASH_CAPABILITIES._policies["create-and-preserve-v1"]
});
export function resolveLocalUnitHashPolicy(policy: unknown): EntityLocalUnitHashAcknowledgement | undefined {
    if (policy === undefined) return undefined;
    if (policy !== "create-and-preserve-v1") throw localUnitError("E_ENTITY_LOCAL_UNIT_HASH_POLICY");
    return hashAcknowledgement;
}
export type EntityLocalUnitCapacityLimits = Readonly<{
    _records: number;
    _writes: number;
    _entities: number;
    _bytes: number;
}>;
export type EntityLocalUnitCapacity = Readonly<{
    _version: 2;
    _profile: EntityLocalUnitCapacityProfile;
    _limits: EntityLocalUnitCapacityLimits;
}>;

/** Fixed protocol profiles. Selection is trusted bootstrap authority, never unit data. */
export const ENTITY_LOCAL_UNIT_CAPABILITIES = Object.freeze({
    _version: 2 as const,
    _profiles: Object.freeze({
        "standard-v1": Object.freeze({ _records: 8, _writes: 4, _entities: 8, _bytes: 65536 }),
        "expanded-v1": Object.freeze({ _records: 10, _writes: 5, _entities: 8, _bytes: 65536 })
    })
});

const capacities = Object.freeze({
    "standard-v1": Object.freeze({ _version: 2 as const, _profile: "standard-v1" as const,
        _limits: ENTITY_LOCAL_UNIT_CAPABILITIES._profiles["standard-v1"] }),
    "expanded-v1": Object.freeze({ _version: 2 as const, _profile: "expanded-v1" as const,
        _limits: ENTITY_LOCAL_UNIT_CAPABILITIES._profiles["expanded-v1"] })
});

/** Internal resolution also validates untyped native callers before issuing a binding. */
export function resolveLocalUnitCapacity(profile: unknown = "standard-v1"): EntityLocalUnitCapacity {
    if (profile !== "standard-v1" && profile !== "expanded-v1") throw localUnitError("E_ENTITY_LOCAL_UNIT_CAPACITY");
    return capacities[profile];
}

/** Closed, fixed-record operations. No queries, SQL, callbacks or cross-app selectors. */
export type EntityLocalUnit = Readonly<{
    _unit_id: string;
    _records: readonly Readonly<{
        _entity: string;
        _id: string;
        _expect?: Record<string, any> | null;
        _create?: Record<string, any>;
        _update?: Record<string, any>;
    }>[];
    _lease?: Readonly<{ _entity: string; _id: string; _owner_id: string; _owner_epoch: number; _version: number }>;
    _valid_until?: number;
}>;

export type EntityLocalUnitBinding = Readonly<{
    _env: string;
    _app_id: string;
    _entities: readonly Readonly<{ _entity: string; _write: boolean }>[];
    _capacity_profile?: EntityLocalUnitCapacityProfile;
    /** Trusted bootstrap only. Omission retains rejection of Hash-schema writes. */
    _hash_policy?: EntityLocalUnitHashPolicy;
    _clock?: () => number;
    /** Trusted fault injection only; never accepted from a command. */
    _fault?: (point: string) => void;
}>;

export type BoundEntityLocalUnit = Readonly<{
    _env: string;
    _app_id: string;
    /** Present only when bootstrap explicitly requested a supported profile. */
    _capacity?: EntityLocalUnitCapacity;
    _hash?: EntityLocalUnitHashAcknowledgement;
    commit: (unit: EntityLocalUnit) => Promise<any>;
}>;

export const localUnitError = (code = "E_ENTITY_LOCAL_UNIT_INVALID") => new XError(code, code);
export const localUnitGuid = (value: unknown): value is string => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

/** Canonical data equality, also rejecting lossy/non-JSON command values. */
export function localUnitCanonical(value: any, depth = 0): string {
    if (depth > 24) throw localUnitError();
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(v => localUnitCanonical(v, depth + 1)).join(",") + "]";
    if (!_xu.is_plain_object(value)) throw localUnitError();
    return "{" + Object.keys(value).sort().map(k => {
        if (["__proto__", "constructor", "prototype"].includes(k)) throw localUnitError();
        return JSON.stringify(k) + ":" + localUnitCanonical(value[k], depth + 1);
    }).join(",") + "}";
}
export const localUnitHash = (value: any) => createHash("sha256").update(localUnitCanonical(value)).digest("hex");

export function validateLocalUnit(raw: any, limits: EntityLocalUnitCapacityLimits = ENTITY_LOCAL_UNIT_CAPABILITIES._profiles["standard-v1"]): EntityLocalUnit {
    if (!Object.values(ENTITY_LOCAL_UNIT_CAPABILITIES._profiles).some(profile => profile === limits)) throw localUnitError("E_ENTITY_LOCAL_UNIT_CAPACITY");
    const data = localUnitCanonical(raw);
    if (Buffer.byteLength(data) > limits._bytes) throw localUnitError();
    const unit = JSON.parse(data);
    const keys = (v: any, allowed: string[]) => {
        if (!_xu.is_plain_object(v) || Object.keys(v).some(k => !allowed.includes(k))) throw localUnitError();
    };
    keys(unit, ["_unit_id", "_records", "_lease", "_valid_until"]);
    if (!localUnitGuid(unit._unit_id) || !Array.isArray(unit._records) || unit._records.length < 1 || unit._records.length > limits._records) throw localUnitError();
    const seen = new Set();
    let writes = 0;
    for (const record of unit._records) {
        keys(record, ["_entity", "_id", "_expect", "_create", "_update"]);
        if (typeof record._entity !== "string" || !record._entity || !localUnitGuid(record._id)) throw localUnitError();
        const key = JSON.stringify([record._entity, record._id]);
        if (seen.has(key)) throw localUnitError();
        seen.add(key);
        if (record._expect !== undefined && record._expect !== null && !_xu.is_plain_object(record._expect)) throw localUnitError();
        if (record._create !== undefined || record._update !== undefined) {
            writes++;
            if (record._create !== undefined && record._update !== undefined) throw localUnitError();
            if (!_xu.is_plain_object(record._create ?? record._update)) throw localUnitError();
            if (record._create !== undefined ? record._expect !== null : !_xu.is_plain_object(record._expect)) throw localUnitError();
            if (record._create && record._create._id !== record._id) throw localUnitError();
        }
    }
    if (writes > limits._writes) throw localUnitError();
    if (unit._valid_until !== undefined && (!Number.isSafeInteger(unit._valid_until) || unit._valid_until < 0)) throw localUnitError();
    if (unit._lease) {
        keys(unit._lease, ["_entity", "_id", "_owner_id", "_owner_epoch", "_version"]);
        if (!localUnitGuid(unit._lease._id) || !localUnitGuid(unit._lease._owner_id) ||
            !Number.isSafeInteger(unit._lease._owner_epoch) || unit._lease._owner_epoch < 1 ||
            !Number.isSafeInteger(unit._lease._version) || unit._lease._version < 1 ||
            !seen.has(JSON.stringify([unit._lease._entity, unit._lease._id]))) throw localUnitError();
    }
    return unit;
}
