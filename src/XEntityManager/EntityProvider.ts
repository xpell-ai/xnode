import { XError } from "@xpell/core";

export type EntityProviderType = "xdb" | "memory" | "sqlite" | "mongo";

export type EntityStorageScope = "global" | "app" | "server";

export type EntityProviderCapabilityName =
    | "hash-verification"
    | "aggregation"
    | "transactions"
    | "persistent-storage"
    | "query-operators"
    | "runtime-entity-handle"
    | "physical-unregister";

export type EntityProviderFindOptions = {
    _skip?: number;
    _limit?: number;
    _include_schema?: boolean;
    _reverse_order?: boolean;
    _sort?: any;
};

export type EntityPhysicalIdentity = {
    _logical_entity_id: string;
    _physical_identity: string;
    _physical_entity_name: string;
    _physical_entity_encoding: string;
    _provider: EntityProviderType;
    _provider_type: string;
    _storage_scope: EntityStorageScope;
    _is_global_storage: boolean;
    _is_scoped_storage: boolean;
};

export type EntityProviderCapability = {
    _name: EntityProviderCapabilityName;
    _supported: boolean;
    _description?: string;
    _operators?: string[];
    _reason?: string;
};

export type EntityAggregationRequest = {
    _op: string;
    _field: string;
    _records: any[];
};

export type EntityAggregationResult = {
    _op: string;
    _field: string;
    _value: number;
};

export type EntityProviderDisposeResult = {
    _disposed: boolean;
    _physical_unregistered: boolean;
    _xdb_unregistered?: boolean;
};

export interface EntityProvider {
    readonly _provider: EntityProviderType;
    readonly _provider_type: string;
    readonly _physical_entity_name: string;

    init(): Promise<void>;
    syncSchema(definition: any): Promise<void>;
    add(data: any): Promise<any>;
    get(id: string): Promise<any>;
    find(query: any, options?: EntityProviderFindOptions): Promise<any>;
    count(query: any): Promise<number>;
    update(filter: any, updates: any): Promise<any>;
    delete(filter: any): Promise<any>;
    getSchema(): any;
    getRecords(result: any): any[];
    getRecordCount(result: any): number;
    applyHashFilter(result: any, hash_filter: any): Promise<any>;
    aggregate(request: EntityAggregationRequest): Promise<EntityAggregationResult>;
    getCapabilities(): EntityProviderCapability[];
    getCapability(name: EntityProviderCapabilityName): EntityProviderCapability;
    assertCapability(name: EntityProviderCapabilityName): EntityProviderCapability;
    getPhysicalIdentity(): EntityPhysicalIdentity;
    getRuntimeEntityHandle(): any;
    dispose(): Promise<EntityProviderDisposeResult>;
}

export function unsupportedEntityProviderCapabilityError(
    provider: EntityProvider,
    capability: EntityProviderCapabilityName
) {
    return new XError(
        "E_ENTITY_PROVIDER_CAPABILITY_UNSUPPORTED",
        `Entity provider '${provider._provider}' does not support capability '${capability}'`,
        {
            _meta: {
                _provider:
                    provider._provider,
                _provider_type:
                    provider._provider_type,
                _capability:
                    capability
            }
        }
    );
}

export function aggregateEntityRecords(
    request: EntityAggregationRequest
): EntityAggregationResult {
    const op =
        String(request?._op ?? "")
            .trim()
            .toLowerCase();

    const field =
        String(request?._field ?? "")
            .trim();

    if (op !== "sum") {
        throw new Error("Unsupported aggregation op");
    }

    if (!field) {
        throw new Error("Missing aggregation field");
    }

    let value =
        0;

    for (const record of request._records) {
        if (!record || typeof record !== "object") continue;

        const raw =
            record[field];

        if (raw === undefined || raw === null || raw === "") continue;

        const numeric =
            Number(raw);

        if (!Number.isFinite(numeric)) {
            throw new Error(`Field ${field} contains a non-numeric value`);
        }

        value += numeric;
    }

    return {
        _op:
            op,
        _field:
            field,
        _value:
            value
    };
}
