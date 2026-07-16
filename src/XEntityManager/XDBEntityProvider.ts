import XDB from "../XDB/XDB.js";
import XDBEntity from "../XDB/XDBEntity.js";
import type {
    EntityAggregationRequest,
    EntityAggregationResult,
    EntityProviderCapability,
    EntityProviderCapabilityName,
    EntityProviderDisposeResult,
    EntityPhysicalIdentity,
    EntityProvider,
    EntityProviderFindOptions,
    EntityProviderType
} from "./EntityProvider.js";
import {
    aggregateEntityRecords,
    unsupportedEntityProviderCapabilityError
} from "./EntityProvider.js";

export type XDBEntityProviderOptions = {
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
};

export class XDBEntityProvider implements EntityProvider {
    readonly _provider: EntityProviderType = "xdb";
    readonly _provider_type: string = XDBEntity._xtype;
    readonly _physical_entity_name: string;

    private _definition: any;
    private readonly _physical_identity: EntityPhysicalIdentity;
    private _xdb_entity: XDBEntity;

    constructor(opts: XDBEntityProviderOptions) {
        this._definition = opts._definition;
        this._physical_identity = opts._physical_identity;

        const logical_entity_id =
            String(
                this._physical_identity._logical_entity_id
            );

        this._xdb_entity = XDB.create({
            _type:
                XDBEntity._xtype,

            _id:
                logical_entity_id,

            _name:
                this._physical_identity._physical_entity_name,

            _schema:
                this._definition?._schema ?? {},

            _meta:
                this._definition?._meta ?? {},

            _description:
                this._definition?._description
        }) as XDBEntity;

        this._physical_entity_name =
            this._xdb_entity._name;
    }

    async init() {
        await this.syncSchema(this._definition);
    }

    async syncSchema(definition: any) {
        this._definition = definition;

        await this._xdb_entity.syncSchema(
            definition?._schema ?? {},
            definition?._meta ?? {}
        );
    }

    private async refreshPhysicalData() {
        await this._xdb_entity.waitUntilLoaded?.();

        const persisted =
            await XDB._engine.loadEntity(this._xdb_entity);

        this._xdb_entity._data =
            Array.isArray(persisted?._data)
                ? persisted._data as any
                : [];

        this._xdb_entity._entity_vectors_index =
            persisted?._entity_vectors_index ?? {};

        this._xdb_entity._entity_matrices_index =
            persisted?._entity_matrices_index ?? {};

        this._xdb_entity._meta = {
            ...this._xdb_entity._meta,
            ...(persisted?._meta ?? {}),
            _name:
                this._physical_entity_name,
            _records:
                this._xdb_entity._data.length
        };

        this._xdb_entity.indexAll();
    }

    async add(data: any) {
        await this.refreshPhysicalData();

        return await this._xdb_entity.add(data);
    }

    async get(id: string) {
        await this.refreshPhysicalData();

        const native_get =
            (this._xdb_entity as any).get;

        if (typeof native_get === "function") {
            return await native_get.call(this._xdb_entity, id);
        }

        return this._xdb_entity.findById(id);
    }

    async find(query: any = {}, options: EntityProviderFindOptions = {}) {
        await this.refreshPhysicalData();

        const result =
            this._xdb_entity.find(
            query,
            options._skip,
            options._limit,
            options._include_schema,
            options._reverse_order,
            options._sort
        );

        if (result?._meta) {
            result._meta._name =
                this._physical_identity._logical_entity_id;
        }

        return result;
    }

    async count(query: any = {}) {
        const result =
            await this.find(
                query,
                {
                    _skip: 0,
                    _limit: 100000
                }
            );

        return this.getRecordCount(result);
    }

    async update(filter: any, updates: any) {
        await this.refreshPhysicalData();

        return await this._xdb_entity.update(filter, updates);
    }

    async delete(filter: any) {
        await this.refreshPhysicalData();

        return await this._xdb_entity.delete(filter);
    }

    getSchema() {
        return this._definition;
    }

    getRecords(result: any): any[] {
        return Array.isArray(result?._data)
            ? result._data
            : [];
    }

    getRecordCount(result: any): number {
        return this.getRecords(result).length;
    }

    async applyHashFilter(
        result: any,
        hash_filter: any
    ) {
        if (
            hash_filter === undefined ||
            hash_filter === null
        ) {
            return result;
        }

        this.assertCapability("hash-verification");

        if (
            typeof hash_filter !== "object" ||
            Array.isArray(hash_filter)
        ) {
            throw new Error(
                "_hash_filter must be an object"
            );
        }

        const entries =
            Object.entries(hash_filter);

        if (entries.length === 0) {
            return result;
        }

        const filtered_data = [];

        for (const record of this.getRecords(result)) {
            let matches =
                true;

            for (const [field_name, plain_text] of entries) {
                if (typeof plain_text !== "string") {
                    throw new Error(
                        `_hash_filter.${field_name} must be a string`
                    );
                }

                const ok =
                    await this._xdb_entity.verifyHashField(
                        record,
                        field_name,
                        plain_text
                    );

                if (!ok) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                filtered_data.push(record);
            }
        }

        result._data =
            filtered_data;

        if (result._meta) {
            result._meta._records =
                filtered_data.length;
            result._meta._total_records =
                filtered_data.length;
        }

        return result;
    }

    async aggregate(
        request: EntityAggregationRequest
    ): Promise<EntityAggregationResult> {
        this.assertCapability("aggregation");

        return aggregateEntityRecords(request);
    }

    getCapabilities(): EntityProviderCapability[] {
        return [
            {
                _name: "hash-verification",
                _supported: true,
                _description: "Verify XDB Hash fields against plain text values."
            },
            {
                _name: "aggregation",
                _supported: true,
                _description: "Aggregate record arrays using EntityManager-compatible operators.",
                _operators: ["sum"]
            },
            {
                _name: "transactions",
                _supported: false,
                _reason: "XDBEntity does not expose transaction boundaries."
            },
            {
                _name: "persistent-storage",
                _supported: true,
                _description: "Persist records through the configured XDB storage adapter."
            },
            {
                _name: "query-operators",
                _supported: true,
                _description: "Delegate query filtering to XDBEntity/XDBEngine filter behavior."
            },
            {
                _name: "runtime-entity-handle",
                _supported: true,
                _description: "Expose the current runtime entity handle for legacy diagnostics."
            },
            {
                _name: "physical-unregister",
                _supported: true,
                _description: "Unregister the physical XDB entity name from the XDB engine metadata."
            }
        ];
    }

    getCapability(
        name: EntityProviderCapabilityName
    ): EntityProviderCapability {
        return this.getCapabilities().find(
            (capability) =>
                capability._name === name
        ) ?? {
            _name: name,
            _supported: false,
            _reason: "Unknown entity provider capability."
        };
    }

    assertCapability(
        name: EntityProviderCapabilityName
    ): EntityProviderCapability {
        const capability =
            this.getCapability(name);

        if (!capability._supported) {
            throw unsupportedEntityProviderCapabilityError(
                this,
                name
            );
        }

        return capability;
    }

    getPhysicalIdentity(): EntityPhysicalIdentity {
        return {
            ...this._physical_identity,
            _logical_entity_id:
                String(
                    this._physical_identity._logical_entity_id ??
                    ""
                ),
            _physical_entity_name:
                this._physical_entity_name,
            _provider:
                this._provider,
            _provider_type:
                this._provider_type
        };
    }

    getRuntimeEntityHandle() {
        this.assertCapability("runtime-entity-handle");

        return this._xdb_entity;
    }

    async dispose(): Promise<EntityProviderDisposeResult> {
        const physical_entity_name =
            this._physical_entity_name;

        const xdb_unregistered =
            XDB._engine?.removeEntity?.(physical_entity_name) === true;

        await this._xdb_entity.dispose?.();

        return {
            _disposed: true,
            _physical_unregistered: xdb_unregistered,
            _xdb_unregistered: xdb_unregistered
        };
    }
}
