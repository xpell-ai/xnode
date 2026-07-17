import bcrypt from "bcryptjs";
import { XError } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import XDBObject from "../XDB/XDBObject.js";
import type {
    EntityAggregationRequest,
    EntityAggregationResult,
    EntityProvider,
    EntityProviderCapability,
    EntityProviderCapabilityName,
    EntityProviderDisposeResult,
    EntityProviderFindOptions,
    EntityPhysicalIdentity,
    EntityProviderType
} from "./EntityProvider.js";
import {
    aggregateEntityRecords,
    unsupportedEntityProviderCapabilityError
} from "./EntityProvider.js";
import { MongoConnections } from "./MongoConnectionManager.js";

const MONGO_HASH_FILTER_MAX_RECORDS = 25;

export type MongoEntityProviderOptions = {
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
};

export class MongoEntityProvider implements EntityProvider {
    readonly _provider: EntityProviderType = "mongo";
    readonly _provider_type = "mongo-entity";
    readonly _physical_entity_name: string;

    private _definition: any;
    private readonly _physical_identity: EntityPhysicalIdentity;
    private _schema: Record<string, any> = {};
    private _xdb_object!: XDBObject;
    private _connection_name = "default";
    private _model_name: string;
    private _collection_name: string;

    constructor(opts: MongoEntityProviderOptions) {
        this._definition = opts._definition;
        this._physical_identity = opts._physical_identity;
        this._physical_entity_name =
            this._physical_identity._physical_entity_name;
        this._model_name =
            this.resolveModelName();
        this._collection_name =
            this._physical_entity_name;
    }

    async init() {
        await this.syncSchema(this._definition);
    }

    private resolveConnectionName(definition: any) {
        const configured =
            definition?._storage?._mongo?._connection ??
            definition?._storage?._connection ??
            "default";

        return String(configured || "default")
            .trim()
            .toLowerCase();
    }

    private resolveModelName() {
        return `xpell_mongo_entity_${this._physical_entity_name}`
            .replace(/[^A-Za-z0-9_]/g, "_");
    }

    private normalizeRuntimeSchema(schema: Record<string, any>) {
        const normalized =
            JSON.parse(JSON.stringify(schema ?? {}));

        if (!Object.prototype.hasOwnProperty.call(normalized, "_id")) {
            normalized._id = {
                _type: "ObjectId",
                _required: false,
                _index: {
                    _unique: true,
                    _primary: true
                },
                _immutable: true
            };
        }

        if (!Object.prototype.hasOwnProperty.call(normalized, "_created_at")) {
            normalized._created_at = {
                _type: "Date",
                _required: false,
                _immutable: true
            };
        }

        if (!Object.prototype.hasOwnProperty.call(normalized, "_updated_at")) {
            normalized._updated_at = {
                _type: "Date",
                _required: false
            };
        }

        return normalized;
    }

    private mongoTypeForField(fieldName: string, field: any) {
        const type =
            String(field?._type ?? "")
                .trim()
                .toLowerCase();

        if (fieldName === "_id") {
            return String;
        }

        if (type === "string" || type === "objectid" || type === "hash") {
            return String;
        }

        if (type === "number") {
            return Number;
        }

        if (type === "boolean" || type === "bool") {
            return Boolean;
        }

        if (type === "date") {
            return Date;
        }

        if (type === "array") {
            return Array;
        }

        if (type === "object") {
            return Object;
        }

        throw new XError(
            "E_ENTITY_MONGO_SCHEMA_UNSUPPORTED",
            `Mongo entity provider does not support field type '${field?._type}'`,
            {
                _meta: {
                    _field:
                        fieldName,
                    _type:
                        field?._type
                }
            }
        );
    }

    private translateSchema(schema: Record<string, any>) {
        const mongoSchema: Record<string, any> = {};
        const indexes: Array<{ keys: Record<string, 1 | -1>; options?: any }> = [];

        for (const [fieldName, field] of Object.entries(schema)) {
            const entry: Record<string, any> = {
                type:
                    this.mongoTypeForField(fieldName, field)
            };

            if (field?._required === true) {
                entry.required = true;
            }

            if (Object.prototype.hasOwnProperty.call(field ?? {}, "_default")) {
                entry.default = field._default;
            }

            if (field?._immutable === true) {
                entry.immutable = true;
            }

            if (Array.isArray(field?._enum)) {
                entry.enum = field._enum;
            }

            if (typeof field?._min === "number") {
                entry.min = field._min;
            }

            if (typeof field?._max === "number") {
                entry.max = field._max;
            }

            if (typeof field?._min_length === "number") {
                entry.minlength = field._min_length;
            }

            if (typeof field?._max_length === "number") {
                entry.maxlength = field._max_length;
            }

            if (typeof field?._pattern === "string") {
                entry.match = new RegExp(field._pattern);
            }

            if (String(field?._type ?? "").toLowerCase() === "hash") {
                entry._xhash = true;
            }

            mongoSchema[fieldName] = entry;

            if (field?._index) {
                const indexDef =
                    typeof field._index === "object"
                        ? field._index
                        : {};
                indexes.push({
                    keys: {
                        [fieldName]:
                            1
                    },
                    options: {
                        ...(indexDef?._unique === true
                            ? {
                                unique:
                                    true
                            }
                            : {})
                    }
                });
            }
        }

        return {
            _schema:
                mongoSchema,
            _indexes:
                indexes
        };
    }

    async syncSchema(definition: any) {
        this._definition = definition;
        this._connection_name =
            this.resolveConnectionName(definition);
        this._schema =
            this.normalizeRuntimeSchema(definition?._schema ?? {});

        const connection =
            await MongoConnections.connect(this._connection_name);

        const translated =
            this.translateSchema(this._schema);

        this._xdb_object =
            new XDBObject({
                _name:
                    this._physical_entity_name,
                _schema:
                    translated._schema,
                _indexes:
                    translated._indexes,
                _mongoose_connection:
                    connection,
                _model_name:
                    this._model_name,
                _collection_name:
                    this._collection_name,
                _throw_on_model_error:
                    true
            } as any);
    }

    private normalizeRawRecord(raw: any) {
        if (!raw) {
            return raw;
        }

        const record: Record<string, any> = {};

        for (const fieldName of Object.keys(this._schema)) {
            if (fieldName === "_created_at" || fieldName === "_updated_at") {
                continue;
            }

            const prefixed =
                fieldName.startsWith("_")
                    ? fieldName
                    : `_${fieldName}`;

            const value =
                raw[fieldName] !== undefined
                    ? raw[fieldName]
                    : raw[prefixed];

            if (value !== undefined) {
                record[fieldName] = value;
            }
        }

        record._created_at =
            raw._created_at ??
            raw.createdAt;
        record._updated_at =
            raw._updated_at ??
            raw.updatedAt;

        delete record.__v;
        delete (record as any)._doc;
        delete (record as any).$__;

        return JSON.parse(JSON.stringify(record));
    }

    private normalizeRawRecords(records: any[]) {
        return records.map((record) =>
            this.normalizeRawRecord(record)
        );
    }

    private translateSort(sort: any) {
        if (!sort || typeof sort !== "object") {
            return undefined;
        }

        const fieldName =
            String(sort._sort_by ?? "")
                .trim();

        if (!fieldName) {
            throw new XError(
                "E_ENTITY_MONGO_QUERY_UNSUPPORTED",
                "Mongo entity provider sort requires _sort_by"
            );
        }

        return {
            [fieldName]:
                String(sort._sort_order ?? "asc").toLowerCase() === "desc"
                    ? -1
                    : 1
        };
    }

    private translateFilter(filter: any = {}) {
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
            return {};
        }

        const out: Record<string, any> = {};

        for (const [fieldName, value] of Object.entries(filter)) {
            if (fieldName.startsWith("$")) {
                throw new XError(
                    "E_ENTITY_MONGO_QUERY_UNSUPPORTED",
                    "Raw Mongo query operators are not supported by EntityManager",
                    {
                        _meta: {
                            _field:
                                fieldName
                        }
                    }
                );
            }

            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value)
            ) {
                const translated: Record<string, any> = {};

                for (const [operator, operand] of Object.entries(value)) {
                    if (operator === "_eq" || operator === "_equals" || operator === "=") {
                        out[fieldName] = operand;
                        continue;
                    }

                    const mongoOperator =
                        operator === "_gt" || operator === ">"
                            ? "$gt"
                            : operator === "_gte" || operator === ">="
                                ? "$gte"
                                : operator === "_lt" || operator === "<"
                                    ? "$lt"
                                    : operator === "_lte" || operator === "<="
                                        ? "$lte"
                                        : operator === "_in"
                                            ? "$in"
                                            : "";

                    if (!mongoOperator) {
                        throw new XError(
                            "E_ENTITY_MONGO_QUERY_UNSUPPORTED",
                            `Mongo entity provider does not support query operator '${operator}'`,
                            {
                                _meta: {
                                    _field:
                                        fieldName,
                                    _operator:
                                        operator
                                }
                            }
                        );
                    }

                    translated[mongoOperator] = operand;
                }

                if (Object.keys(translated).length > 0) {
                    out[fieldName] = translated;
                }
                continue;
            }

            out[fieldName] = value;
        }

        return out;
    }

    private providerError(
        code: string,
        message: string,
        meta: Record<string, any> = {}
    ) {
        return new XError(
            code,
            message,
            {
                _meta: {
                    _provider:
                        this._provider,
                    _provider_type:
                        this._provider_type,
                    _physical_entity_name:
                        this._physical_entity_name,
                    ...meta
                }
            }
        );
    }

    private normalizeMongoError(err: any) {
        if (err instanceof XError) {
            return err;
        }

        if (
            err?.code === 11000 ||
            err?.name === "MongoServerError" &&
            String(err?.message ?? "").includes("duplicate key")
        ) {
            return this.providerError(
                "E_ENTITY_MONGO_CONSTRAINT",
                err?.message ?? "Mongo duplicate key constraint failed",
                {
                    _mongo_code:
                        err?.code,
                    _key_pattern:
                        err?.keyPattern,
                    _key_value:
                        err?.keyValue
                }
            );
        }

        if (err?.name === "ValidationError") {
            return this.providerError(
                "E_ENTITY_MONGO_VALIDATION",
                err?.message ?? "Mongo validation failed",
                {
                    _errors:
                        err?.errors
                            ? Object.keys(err.errors)
                            : undefined
                }
            );
        }

        if (err?.name === "CastError") {
            return this.providerError(
                "E_ENTITY_MONGO_CAST",
                err?.message ?? "Mongo cast failed",
                {
                    _path:
                        err?.path,
                    _kind:
                        err?.kind
                }
            );
        }

        return err;
    }

    async add(data: any) {
        const input = {
            ...(data ?? {})
        };

        if (!input._id) {
            input._id = _xu.guid();
        }

        try {
            return this.normalizeRawRecord(
                await this._xdb_object.addRaw(
                    input,
                    {
                        _preserve_id:
                            true,
                        _no_ignore:
                            true
                    }
                )
            );
        } catch (err) {
            throw this.normalizeMongoError(err);
        }
    }

    async get(id: string) {
        return this.normalizeRawRecord(
            await this._xdb_object.findOneRaw(
                {
                    _id:
                        id
                },
                {
                    _no_ignore:
                        true
                }
            )
        );
    }

    async find(query: any = {}, options: EntityProviderFindOptions = {}) {
        const filter =
            this.translateFilter(query);

        const skip =
            options._skip ?? 0;

        const limit =
            options._limit ?? 100000;

        const data =
            this.normalizeRawRecords(
                await this._xdb_object.findRaw(
                    filter,
                    {
                        _skip:
                            skip,
                        _limit:
                            limit,
                        _sort:
                            this.translateSort(options._sort),
                        _no_ignore:
                            true
                    }
                )
            );

        return {
            _meta: {
                _name:
                    this._physical_identity._logical_entity_id,
                _skip:
                    skip,
                _limit:
                    limit,
                _total_records:
                    await this.count(query),
                _records:
                    data.length,
                ...(options._include_schema
                    ? {
                        _schema:
                            this._schema
                    }
                    : {})
            },
            _data:
                data,
            _vectors_ids:
                {},
            _matrices:
                {}
        };
    }

    async count(query: any = {}) {
        return await this._xdb_object.countRaw(
            this.translateFilter(query)
        );
    }

    async update(filter: any, updates: any) {
        try {
            return await this._xdb_object.updateManyRaw(
                this.translateFilter(filter),
                updates,
                {
                    _no_ignore:
                        true
                }
            );
        } catch (err) {
            throw this.normalizeMongoError(err);
        }
    }

    async delete(filter: any) {
        return await this._xdb_object.deleteManyRaw(
            this.translateFilter(filter)
        );
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

    async applyHashFilter(result: any, hash_filter: any) {
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
            throw new Error("_hash_filter must be an object");
        }

        const records =
            this.getRecords(result);

        if (records.length > MONGO_HASH_FILTER_MAX_RECORDS) {
            throw new XError(
                "E_ENTITY_MONGO_HASH_FILTER_UNBOUNDED",
                "Mongo Hash field verification requires a bounded result set",
                {
                    _meta: {
                        _records:
                            records.length,
                        _max_records:
                            MONGO_HASH_FILTER_MAX_RECORDS
                    }
                }
            );
        }

        const entries =
            Object.entries(hash_filter);

        if (entries.length === 0) {
            return result;
        }

        const filtered_data = [];

        for (const record of records) {
            let matches =
                true;

            for (const [fieldName, plainText] of entries) {
                if (typeof plainText !== "string") {
                    throw new Error(`_hash_filter.${fieldName} must be a string`);
                }

                const field =
                    this._schema?.[fieldName];

                if (!field) {
                    throw new Error(`Field ${fieldName} not in schema`);
                }

                if (field._type !== "Hash") {
                    throw new Error(`Field ${fieldName} is not a Hash field`);
                }

                const hash =
                    record?.[fieldName];

                if (
                    typeof hash !== "string" ||
                    !await bcrypt.compare(plainText, hash)
                ) {
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
                _description: "Verify Mongo-backed Hash fields against plain text values after bounded filtering."
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
                _reason: "MongoEntityProvider V1 does not expose transaction boundaries."
            },
            {
                _name: "persistent-storage",
                _supported: true,
                _description: "Persist records through a named Mongoose connection."
            },
            {
                _name: "query-operators",
                _supported: true,
                _description: "Supports a bounded portable filter subset translated to Mongo filters.",
                _operators: [
                    "=",
                    "_eq",
                    "_equals",
                    ">",
                    ">=",
                    "<",
                    "<=",
                    "_gt",
                    "_gte",
                    "_lt",
                    "_lte",
                    "_in"
                ]
            },
            {
                _name: "runtime-entity-handle",
                _supported: true,
                _description: "Expose the wrapped XDBObject for internal diagnostics."
            },
            {
                _name: "physical-unregister",
                _supported: false,
                _reason: "Mongo provider dispose preserves collections and shared connections."
            }
        ];
    }

    getCapability(
        name: EntityProviderCapabilityName
    ): EntityProviderCapability {
        return this.getCapabilities().find(
            (capability) => capability._name === name
        ) ?? {
            _name:
                name,
            _supported:
                false,
            _reason:
                "Unknown entity provider capability."
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
                String(this._physical_identity._logical_entity_id ?? ""),
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

        return this._xdb_object;
    }

    async dispose(): Promise<EntityProviderDisposeResult> {
        return {
            _disposed: true,
            _physical_unregistered: false,
            _xdb_unregistered: false
        };
    }
}
