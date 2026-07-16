import bcrypt from "bcryptjs";
import _xu from "../XNUtils/XUtils.js";
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

const BCRYPT_SALT_OR_ROUNDS = 10;
const BCRYPT_HASH_PREFIXES = ["$2a$", "$2b$", "$2y$"];

type MemoryIndex = {
    _id: string;
    _unique: boolean;
    _primary: boolean;
    _data: Record<string, any>;
};

export type MemoryEntityProviderOptions = {
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
};

export class MemoryEntityProvider implements EntityProvider {
    readonly _provider: EntityProviderType = "memory";
    readonly _provider_type: string = "memory-entity";
    readonly _physical_entity_name: string;

    private _definition: any;
    private _schema: Record<string, any> = {};
    private readonly _physical_identity: EntityPhysicalIdentity;
    private _data: any[] = [];
    private _indices: Record<string, MemoryIndex> = {};
    private _indexable: string[] = [];

    constructor(opts: MemoryEntityProviderOptions) {
        this._definition = opts._definition;
        this._physical_identity = opts._physical_identity;
        this._physical_entity_name =
            this._physical_identity._physical_entity_name;
    }

    async init() {
        await this.syncSchema(this._definition);
    }

    async syncSchema(definition: any) {
        this._definition = definition;
        this._schema =
            this.normalizeRuntimeSchema(definition?._schema ?? {});
        this.initFields();
        this.indexAll();
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

        normalized._created_at = {
            _type: "Date",
            _required: false,
            _immutable: true
        };

        normalized._updated_at = {
            _type: "Date",
            _required: false
        };

        return normalized;
    }

    private initFields() {
        this._indices = {
            _id: {
                _id: "_id",
                _unique: true,
                _primary: true,
                _data: {}
            }
        };
        this._indexable = ["_id"];

        for (const key of Object.keys(this._schema)) {
            const field =
                this._schema[key];

            if (!field?._index) {
                continue;
            }

            const index_schema =
                typeof field._index === "object"
                    ? field._index
                    : {};

            this._indices[key] = {
                _id: key,
                _unique: index_schema?._unique === true,
                _primary: index_schema?._primary === true,
                _data: {}
            };
            this._indexable.push(key);
        }
    }

    private normalizeIndexValue(value: any): string {
        if (value === undefined || value === null) {
            return "__null__";
        }

        if (typeof value === "object") {
            return JSON.stringify(value);
        }

        return String(value);
    }

    private isBcryptHash(value: any): boolean {
        return (
            typeof value === "string" &&
            BCRYPT_HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
        );
    }

    private async hashFieldValue(value: any): Promise<string> {
        const salt =
            await bcrypt.genSalt(BCRYPT_SALT_OR_ROUNDS);

        return await bcrypt.hash(
            String(value ?? ""),
            salt
        );
    }

    private async prepareHashFieldValue(value: any): Promise<string> {
        if (this.isBcryptHash(value)) {
            return value;
        }

        return await this.hashFieldValue(value);
    }

    private async prepareFields(input: Record<string, any>): Promise<Record<string, any>> {
        const out: Record<string, any> = {};
        const errors: string[] = [];

        for (const key of Object.keys(this._schema)) {
            const field =
                this._schema[key];

            const ftype =
                String(field?._type ?? "")
                    .toLowerCase();

            if (!Object.prototype.hasOwnProperty.call(input, key)) {
                if (
                    ftype === "number" &&
                    field?._auto_increment
                ) {
                    const value =
                        field._auto_increment._value ??
                        field._auto_increment._start;
                    out[key] = value;
                    field._auto_increment._value =
                        value + field._auto_increment._step;
                } else if (Object.prototype.hasOwnProperty.call(field, "_default")) {
                    out[key] = field._default;
                } else if (field?._required) {
                    errors.push(`missing required field: ${key}`);
                }

                continue;
            }

            const value =
                input[key];

            if (ftype === "string") {
                let string_value =
                    String(value ?? "");

                if (
                    field?._max_length &&
                    string_value.length > field._max_length
                ) {
                    string_value =
                        string_value.substring(0, field._max_length);
                }

                if (
                    field?._min_length &&
                    string_value.length < field._min_length
                ) {
                    errors.push(`field ${key} too short`);
                }

                if (
                    field?._enum &&
                    !field._enum.includes(string_value)
                ) {
                    errors.push(`field ${key} not in enum`);
                }

                if (field?._pattern) {
                    const re =
                        new RegExp(field._pattern);

                    if (!re.test(string_value)) {
                        errors.push(`field ${key} pattern mismatch`);
                    }
                }

                out[key] = string_value;
                continue;
            }

            if (ftype === "number") {
                if (field?._auto_increment) {
                    const current =
                        field._auto_increment._value ??
                        field._auto_increment._start;
                    out[key] = current;
                    field._auto_increment._value =
                        current + field._auto_increment._step;
                } else {
                    const numeric_value =
                        Number(value);

                    if (Number.isNaN(numeric_value)) {
                        errors.push(`field ${key} is not a number`);
                    }

                    out[key] = numeric_value;
                }

                if (
                    field?._min != null &&
                    out[key] < field._min
                ) {
                    errors.push(`field ${key} below min`);
                }

                if (
                    field?._max != null &&
                    out[key] > field._max
                ) {
                    errors.push(`field ${key} above max`);
                }

                if (
                    field?._enum &&
                    !field._enum.includes(out[key])
                ) {
                    errors.push(`field ${key} not in enum`);
                }

                continue;
            }

            if (ftype === "date") {
                out[key] = new Date(value);
                continue;
            }

            if (ftype === "hash") {
                out[key] =
                    await this.prepareHashFieldValue(value);
                continue;
            }

            out[key] = value;
        }

        if (errors.length > 0) {
            throw new Error(errors.join("\n"));
        }

        return out;
    }

    private checkUpdateField(fieldName: string, updateValue: any) {
        const field =
            this._schema[fieldName];

        if (!field) {
            throw new Error(`Field ${fieldName} not in schema`);
        }

        if (field._immutable) {
            throw new Error(`Field ${fieldName} is immutable`);
        }

        if (
            updateValue === undefined ||
            updateValue === null
        ) {
            throw new Error(`Field ${fieldName} value is undefined/null`);
        }

        if (
            field._enum &&
            field._enum.length > 0 &&
            !field._enum.includes(updateValue)
        ) {
            throw new Error(`Field ${fieldName} value not in enum`);
        }
    }

    private indexAll() {
        for (const index of Object.values(this._indices)) {
            index._data = {};
        }

        for (let position = 0; position < this._data.length; position += 1) {
            this.indexAdd(this._data[position], position);
        }
    }

    private indexAdd(record: any, position: number) {
        for (const fieldName of Object.keys(this._indices)) {
            if (!Object.prototype.hasOwnProperty.call(record, fieldName)) {
                continue;
            }

            const index =
                this._indices[fieldName];

            const value =
                record[fieldName];

            const key =
                this.normalizeIndexValue(value);

            if (index._primary) {
                index._data[key] = position;
                continue;
            }

            if (index._unique) {
                index._data[key] = record._id;
                continue;
            }

            if (!Array.isArray(index._data[key])) {
                index._data[key] = [];
            }

            index._data[key].push(record._id);
        }
    }

    private findDataIndex(recordId: string): number {
        const pos =
            this._indices._id?._data?.[recordId];

        return typeof pos === "number"
            ? pos
            : this._data.findIndex((record) => record?._id === recordId);
    }

    private assertUniqueFields(record: any, currentId?: string) {
        for (const fieldName of Object.keys(this._indices)) {
            const index =
                this._indices[fieldName];

            if (!index._unique || index._primary) {
                continue;
            }

            const value =
                record[fieldName];

            if (value === undefined || value === null) {
                continue;
            }

            const key =
                this.normalizeIndexValue(value);

            const existingId =
                index._data[key];

            if (
                existingId !== undefined &&
                String(existingId) !== String(currentId ?? "")
            ) {
                throw new Error(
                    `duplicate value for unique field '${fieldName}'`
                );
            }
        }
    }

    private cloneRecord(record: any) {
        if (record === undefined || record === null) {
            return record;
        }

        return JSON.parse(JSON.stringify(record));
    }

    private compareValue(recordValue: any, queryValue: any, stype: string) {
        if (stype === "date") {
            return new Date(recordValue).getTime() === new Date(queryValue).getTime();
        }

        return recordValue === queryValue;
    }

    private objectSearch(fieldValue: any, queryValue: any): boolean {
        const op =
            queryValue?.o ?? "=";

        if (
            !fieldValue ||
            !queryValue ||
            !Object.prototype.hasOwnProperty.call(fieldValue, queryValue.k)
        ) {
            return false;
        }

        return this.applyOperator(
            fieldValue[queryValue.k],
            op,
            queryValue.v,
            ""
        );
    }

    private applyOperator(
        fieldValue: any,
        op: string,
        queryValue: any,
        stype: string
    ): boolean {
        const normalizedFieldValue =
            stype === "date"
                ? new Date(fieldValue)
                : fieldValue;

        switch (op) {
            case "_starts_with":
            case "_starts":
                return String(normalizedFieldValue).startsWith(String(queryValue));
            case "_ends_with":
            case "_ends":
                return String(normalizedFieldValue).endsWith(String(queryValue));
            case "_contains":
                return String(normalizedFieldValue).indexOf(String(queryValue)) > -1;
            case "_is_empty":
            case "_empty":
                return (normalizedFieldValue?.length ?? 0) === 0;
            case "_equals":
            case "_eq":
            case "=":
                return normalizedFieldValue == queryValue;
            case "_in":
                return Array.isArray(queryValue)
                    ? queryValue.includes(normalizedFieldValue)
                    : false;
            case ">":
            case "_gt":
                return normalizedFieldValue > queryValue;
            case ">=":
            case "_gte":
                return normalizedFieldValue >= queryValue;
            case "<":
            case "_lt":
                return normalizedFieldValue < queryValue;
            case "<=":
            case "_lte":
                return normalizedFieldValue <= queryValue;
            case "_includes":
                return Array.isArray(normalizedFieldValue)
                    ? normalizedFieldValue.includes(queryValue)
                    : false;
            case "_object_search":
                return this.objectSearch(normalizedFieldValue, queryValue);
            case "_object_array_search": {
                if (
                    !queryValue ||
                    !Object.prototype.hasOwnProperty.call(queryValue, "k") ||
                    !Object.prototype.hasOwnProperty.call(queryValue, "v")
                ) {
                    return false;
                }

                const nested =
                    normalizedFieldValue?.[queryValue.k];

                return Array.isArray(nested)
                    ? nested.includes(queryValue.v)
                    : false;
            }
            case "_year":
                return new Date(normalizedFieldValue).getFullYear() == queryValue;
            case "_month":
                return new Date(normalizedFieldValue).getMonth() + 1 == queryValue;
            case "_day":
                return new Date(normalizedFieldValue).getDate() == queryValue;
            case "_second":
                return new Date(normalizedFieldValue).getSeconds() == queryValue;
            case "_date_eq":
                return new Date(normalizedFieldValue).getTime() == new Date(queryValue).getTime();
            case "_date_gt":
                return new Date(normalizedFieldValue).getTime() > new Date(queryValue).getTime();
            case "_date_gte":
                return new Date(normalizedFieldValue).getTime() >= new Date(queryValue).getTime();
            case "_date_lt":
                return new Date(normalizedFieldValue).getTime() < new Date(queryValue).getTime();
            case "_date_lte":
                return new Date(normalizedFieldValue).getTime() <= new Date(queryValue).getTime();
            default:
                return false;
        }
    }

    private recordMatches(record: any, query: any) {
        const keys =
            Object.keys(query || {});

        if (keys.length === 0) {
            return true;
        }

        let evaluated =
            false;

        for (const key of keys) {
            const field =
                this._schema[key];

            if (!field) {
                continue;
            }

            evaluated = true;

            if (field._embed) {
                continue;
            }

            const queryValue =
                query[key];

            const stype =
                String(field?._type ?? "")
                    .toLowerCase();

            if (
                queryValue &&
                typeof queryValue === "object" &&
                !Array.isArray(queryValue)
            ) {
                for (const rawOp of Object.keys(queryValue)) {
                    let op =
                        rawOp;

                    let negate =
                        false;

                    if (op.startsWith("!")) {
                        negate = true;
                        op = op.substring(1);
                    }

                    let ok =
                        this.applyOperator(
                            record[key],
                            op,
                            queryValue[rawOp],
                            stype
                        );

                    if (
                        negate ||
                        !queryValue[op]
                    ) {
                        ok = !ok;
                    }

                    if (!ok) {
                        return false;
                    }
                }

                continue;
            }

            if (
                !Object.prototype.hasOwnProperty.call(record, key) ||
                !this.compareValue(record[key], queryValue, stype)
            ) {
                return false;
            }
        }

        return evaluated;
    }

    async add(data: any) {
        const fixedData =
            await this.prepareFields(data);

        if (!fixedData._id) {
            fixedData._id = _xu.guid();
        }

        if (this.findDataIndex(fixedData._id) >= 0) {
            throw new Error(
                `record with _id ${fixedData._id} already exists`
            );
        }

        const now =
            new Date();

        const entityData: Record<string, any> = {
            _id:
                fixedData._id,
            _created_at:
                now,
            _updated_at:
                now
        };

        for (const fieldName of Object.keys(this._schema)) {
            const value =
                fixedData[fieldName];

            if (value !== undefined && value !== null) {
                entityData[fieldName] = value;
            }
        }

        this.assertUniqueFields(entityData);

        this._data.push(entityData);
        this.indexAdd(entityData, this._data.length - 1);

        return this.cloneRecord(entityData);
    }

    async get(id: string) {
        const index =
            this.findDataIndex(id);

        if (index < 0) {
            return null;
        }

        return this.cloneRecord(this._data[index]);
    }

    async find(query: any = {}, options: EntityProviderFindOptions = {}) {
        let outData =
            this._data.filter((record) => this.recordMatches(record, query));

        const sortInput =
            options._sort;

        if (sortInput) {
            const fieldName =
                sortInput._sort_by;

            const order =
                sortInput._sort_order ?? "asc";

            if (this._schema[fieldName]) {
                outData =
                    [...outData].sort((a: any, b: any) => {
                        const av =
                            a[fieldName];

                        const bv =
                            b[fieldName];

                        const dir =
                            order === "asc"
                                ? 1
                                : -1;

                        if (
                            av == null &&
                            bv == null
                        ) {
                            return 0;
                        }

                        if (av == null) {
                            return -1 * dir;
                        }

                        if (bv == null) {
                            return 1 * dir;
                        }

                        if (
                            typeof av === "number" &&
                            typeof bv === "number"
                        ) {
                            return (av - bv) * dir;
                        }

                        if (
                            String(this._schema[fieldName]?._type ?? "")
                                .toLowerCase() === "date"
                        ) {
                            return (
                                new Date(av).getTime() -
                                new Date(bv).getTime()
                            ) * dir;
                        }

                        return String(av).localeCompare(String(bv)) * dir;
                    });
            }
        }

        const total =
            outData.length;

        const skip =
            options._skip ?? 0;

        const limit =
            options._limit ?? 100000;

        outData =
            outData.slice(skip, skip + limit);

        if (options._reverse_order) {
            outData = [...outData].reverse();
        }

        return {
            _meta: {
                _name:
                    this._physical_identity._logical_entity_id,
                _skip:
                    skip,
                _limit:
                    limit,
                _total_records:
                    total,
                _records:
                    outData.length,
                ...(options._include_schema
                    ? {
                        _schema:
                            this._schema
                    }
                    : {})
            },
            _data:
                outData.map((record) => this.cloneRecord(record)),
            _vectors_ids:
                {},
            _matrices:
                {}
        };
    }

    async count(query: any = {}) {
        return this._data
            .filter((record) => this.recordMatches(record, query))
            .length;
    }

    async update(filter: any, updates: any) {
        if (
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).length === 0
        ) {
            throw new Error("Empty filter");
        }

        if (
            !updates ||
            typeof updates !== "object" ||
            Object.keys(updates).length === 0
        ) {
            throw new Error("Empty updates");
        }

        const selected =
            this._data.filter((record) => this.recordMatches(record, filter));

        let updatedCount =
            0;

        const preparedUpdates: Record<string, any> = {};

        for (const key of Object.keys(updates)) {
            this.checkUpdateField(key, updates[key]);

            const fieldType =
                String(this._schema[key]?._type ?? "")
                    .toLowerCase();

            preparedUpdates[key] =
                fieldType === "hash"
                    ? await this.prepareHashFieldValue(updates[key])
                    : updates[key];
        }

        for (const row of selected) {
            const idx =
                this.findDataIndex(row._id);

            if (idx < 0) {
                continue;
            }

            const nextRecord = {
                ...this._data[idx],
                ...preparedUpdates,
                _updated_at:
                    new Date()
            };

            this.assertUniqueFields(nextRecord, nextRecord._id);

            this._data[idx] = nextRecord;
            updatedCount += 1;
        }

        if (updatedCount > 0) {
            this.indexAll();
        }

        return {
            _updated:
                updatedCount
        };
    }

    async delete(filter: any) {
        if (
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).length === 0
        ) {
            throw new Error("Empty filter");
        }

        const selectedIds =
            new Set(
                this._data
                    .filter((record) => this.recordMatches(record, filter))
                    .map((record) => record._id)
            );

        if (selectedIds.size === 0) {
            return {
                _deleted: 0
            };
        }

        this._data =
            this._data.filter((record) => !selectedIds.has(record._id));

        this.indexAll();

        return {
            _deleted:
                selectedIds.size
        };
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

        const entries =
            Object.entries(hash_filter);

        if (entries.length === 0) {
            return result;
        }

        const filtered_data = [];

        for (const record of this.getRecords(result)) {
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
                _description: "Verify in-memory Hash fields against plain text values."
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
                _reason: "Memory entity storage does not expose transaction boundaries."
            },
            {
                _name: "persistent-storage",
                _supported: false,
                _reason: "Memory entity storage is process-local and intentionally volatile."
            },
            {
                _name: "query-operators",
                _supported: true,
                _description: "Supports common XDB logical query operators in process memory."
            },
            {
                _name: "runtime-entity-handle",
                _supported: true,
                _description: "Expose the memory provider instance for internal diagnostics."
            },
            {
                _name: "physical-unregister",
                _supported: false,
                _reason: "Memory provider has no physical XDB registration to remove."
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

        return this;
    }

    async dispose(): Promise<EntityProviderDisposeResult> {
        this._data = [];
        this.initFields();

        return {
            _disposed: true,
            _physical_unregistered: false,
            _xdb_unregistered: false
        };
    }
}
