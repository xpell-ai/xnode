/**
 * XDBEntity — portable runtime entity (xpell-node friendly)
 * - No python-manager / WormholesClient imports
 * - No UtilsManager
 * - All persistence goes via XDBEngine -> IXDBStorage
 */

import bcrypt from "bcryptjs";
import { XObject, type XObjectData, _xlog } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import { _xem } from "@xpell/node-core";

import XDB from "./XDB.js";
import XDBVector from "./XDBVector.js";
import XDBFile from "./XDBFile.js";
import XDBTemp from "./XDBTemp.js";
import { assertXdbReady, getXdbEngine } from "./xdbReady.js";

// ---------------- Types ----------------

const BCRYPT_SALT_OR_ROUNDS = 10;
const BCRYPT_HASH_PREFIXES = ["$2a$", "$2b$", "$2y$"];

export type XDBIndexSchema = {
    _unique?: boolean;
    _sort?: boolean;
    _primary?: boolean;
};

export type SortInput = {
    _sort_by: string;
    _sort_order?: "asc" | "desc";
};

export type XDBIndexData = {
    /*
    PRIMARY INDEX:
    value -> numeric position
    */
    [idx: string]:
    | number
    /*UNIQUE INDEX:value -> recordId*/
    | string
    /* NON UNIQUE INDEX: value -> recordIds[]*/
    | string[];
};

export type XDBEntityData = {
    _id: string;
    _created_at: Date;
    _updated_at: Date;
    [k: string]: any;
};

export type XDBVectorIndex = {
    [entityId: string]: {
        [field: string]: string[]; // vector ids
    };
};

export type XDBMatrixIndex = {
    [entityId: string]: {
        [field: string]: any; // matrix id(s) (provider dependent)
    };
};

export type XDBIndex = {
    _id: string;
    _unique: boolean;
    _data: XDBIndexData;
    _primary?: boolean;
};

export type XDBEntitySchemaItem = {
    _type:
    | "String"
    | "Number"
    | "ObjectId"
    | "Boolean"
    | "Array"
    | "Object"
    | "Date"
    | "Vector"
    | "Matrix"
    | "Hash"
    | "File";
    _pattern?: string;
    _required?: boolean;
    _default?: any;
    _max_length?: number;
    _min_length?: number;
    _min?: number;
    _max?: number;
    _immutable?: boolean;
    _enum?: any[];
    _embed?: boolean;
    _toFile?: boolean;
    _index?: XDBIndexSchema | boolean;
    _auto_increment?: {
        _start: number;
        _step: number;
        _value?: number;
    };
};

export type XDBEntitySchema = {
    [k: string]: XDBEntitySchemaItem;
};

export type XDBEntityMeta = {
    _records: number;
    _vectors: number;
    _name?: string;
    _version: number;
    _creator?: string;
    _created_at?: Date;
    _updated_at?: Date;
    _description?: string;
    _title?: string;
    _type?: string;
};

export type XDBEntityFieldsLists = {
    _dates: string[];
    _indexable: string[];
    _embedable: string[];
    _toFile: string[];
};

export const _scheme_id_default: XDBEntitySchemaItem = {
    _type: "ObjectId",
    _required: false,
    _index: { _unique: true, _primary: true },
    _immutable: true,
};

// ---------------- Entity ----------------

export class XDBEntity extends XObject {
    static _xtype = "xdb-entity";
    static _object_manager: any;

    declare _id: string;
    declare _name: string;

    // runtime state
    _data: XDBEntityData[] = [];

    // persisted indices
    _entity_vectors_index: XDBVectorIndex = {};
    _entity_matrices_index: XDBMatrixIndex = {};
    _indices: Record<string, XDBIndex> = {};

    _schema!: XDBEntitySchema;
    _meta: XDBEntityMeta = { _version: 1.2, _records: 0, _vectors: 0 };

    // flags
    _loaded = false;
    _need_save = false;
    _schema_need_save = true;
    private _load_promise?: Promise<void>;

    // helpers
    _fields_lists: XDBEntityFieldsLists = {
        _dates: [],
        _indexable: [],
        _embedable: [],
        _toFile: [],
    };

    private _xdb_vector: XDBVector;
    private _xdb_file: XDBFile;
    private _xdb_temp: XDBTemp;

    constructor(data: XObjectData) {
        data["_type"] = XDBEntity._xtype;
        super(data, {}, true);

        this.parse(data);

        if (!this._schema) throw new Error(`XDBEntity "${this._name}" missing schema`);

        assertXdbReady();

        this._xdb_vector = XDB.create({
            _xdb_entity_id: this._id,
            _xdb_entity_name: this._name,
            _type: XDBVector._xtype,
        } as any) as XDBVector;

        this._xdb_file = XDB.create({
            _xdb_entity_id: this._id,
            _xdb_entity_name: this._name,
            _type: XDBFile._xtype,
        } as any) as XDBFile;

        this._xdb_temp = XDB.create({
            _xdb_entity_id: this._id,
            _xdb_entity_name: this._name,
            _type: XDBTemp._xtype,
        } as any) as XDBTemp;

        this.setScheme();
    }

    // ---------------- init / load / save ----------------

    setScheme() {
        this.normalizeRuntimeSchema();

        // load async
        this._load_promise = this.loadData().then(() => _xem.fire("xentity-loaded", this._name));
    }

    private normalizeRuntimeSchema() {
        if (!this._schema.hasOwnProperty("_id")) this._schema["_id"] = _scheme_id_default;

        this._schema["_created_at"] = { _type: "Date", _required: false, _immutable: true };
        this._schema["_updated_at"] = { _type: "Date", _required: false };

        this._meta._name = this._name;

        this.initFields();

        // register entity inside engine (engine decides what to do)
        const engine = getXdbEngine();
        engine.addEntity(this);
    }

    private cloneSchema(schema: XDBEntitySchema): XDBEntitySchema {
        return JSON.parse(JSON.stringify(schema ?? {}));
    }

    async waitUntilLoaded() {
        if (this._load_promise) {
            await this._load_promise;
        }
    }

    async syncSchema(schema: XDBEntitySchema, meta: Partial<XDBEntityMeta> = {}) {
        await this.waitUntilLoaded();

        const safeMeta =
            meta && typeof meta === "object" && !Array.isArray(meta)
                ? meta
                : {};

        this._schema = this.cloneSchema(schema);
        this._meta = {
            ...this._meta,
            ...safeMeta,
            _records: this._data.length,
            _name: this._name
        };

        this.normalizeRuntimeSchema();
        this.indexAll();

        const engine = getXdbEngine();
        await engine.saveEntity(this, true);

        this._schema_need_save = false;
        this._need_save = false;
        this._loaded = true;
    }


    private initFields() {
        this._fields_lists = { _dates: [], _indexable: [], _embedable: [], _toFile: [] };
        this._indices = {};

        Object.keys(this._schema).forEach((key) => {
            const item = this._schema[key];
            const stype = String(item?._type ?? "").toLowerCase();

            if (!stype) {
                _xlog.error(`XDBEntity "${this._name}" missing _type for field "${key}"`);
                return;
            }

            if (stype === "date") this._fields_lists._dates.push(key);
            if (stype === "file") this._fields_lists._toFile.push(key);
            if (item._embed) this._fields_lists._embedable.push(key);

            const index = item._index;
            if (index) {
                const schema = (typeof index === "boolean" ? {} : (index as XDBIndexSchema)) ?? {};
                this._indices[key] = {
                    _id: key,
                    _unique: !!schema._unique,
                    _primary: !!schema._primary,
                    _data: {},
                };
                this._fields_lists._indexable.push(key);
            }
        });
    }

    async loadData(sendMatrices = false) {
        const engine = getXdbEngine();
        const persisted = await engine.loadEntity(this);

        // apply
        this._schema = persisted._schema ?? this._schema;
        this._data = (persisted._data ?? []) as any;
        this._entity_vectors_index = persisted._entity_vectors_index ?? {};
        this._entity_matrices_index = persisted._entity_matrices_index ?? {};
        this._indices = persisted._indices ?? this._indices;
        this._meta = persisted._meta ?? this._meta;

        this._meta._records = this._data.length;

        // rebuild indices in memory (safe)
        this.indexAll();

        // optional: (re)build matrices if your node runtime has a provider
        if (sendMatrices) {
            // in portable mode: either no-op or call engine provider (we’ll add later)
            // await this.loadMatrices();
        }

        // ensure helper stores are in sync (their own commit logic)
        await this._xdb_vector.commit?.();
        await this._xdb_file.commit?.();

        // persist entity once to normalize format / version, like you did before
        await engine.saveEntity(this, this._schema_need_save);
        this._schema_need_save = false;

        this._loaded = true;
    }

    async commit() {
        if (!this._need_save) return;
        const engine = getXdbEngine();

        // persist helper stores first (vectors/files)
        await this._xdb_vector.commit?.();
        await this._xdb_file.commit?.();

        await engine.saveEntity(this, this._schema_need_save);
        this._schema_need_save = false;
        this._need_save = false;
    }

    // ---------------- validation / field prep ----------------

    async compareHashField(hash: string, plainText: string) {
        return await bcrypt.compare(plainText, hash);
    }

    async verifyHashField(
        record: any,
        fieldName: string,
        plainText: string
    ): Promise<boolean> {
        const field =
            this._schema?.[fieldName];

        if (!field) {
            throw new Error(
                `Field ${fieldName} not in schema`
            );
        }

        if (field._type !== "Hash") {
            throw new Error(
                `Field ${fieldName} is not a Hash field`
            );
        }

        const hash =
            record?.[fieldName];

        if (typeof hash !== "string") {
            return false;
        }

        return await this.compareHashField(
            hash,
            plainText
        );
    }

    private isBcryptHash(value: any): boolean {
        return (
            typeof value === "string" &&
            BCRYPT_HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
        );
    }

    private async hashFieldValue(value: any): Promise<string> {
        const salt =
            await bcrypt.genSalt(
                BCRYPT_SALT_OR_ROUNDS
            );

        return await bcrypt.hash(
            String(value ?? ""),
            salt
        );
    }

    private logHashUpdate(
        fieldName: string,
        action: "hash-update" | "hash-skip-already-hashed"
    ) {
        _xlog.log("[xdb/hash]", {
            _entity: this._name ?? this._id,
            _field: fieldName,
            _action: action
        });
    }

    private async prepareHashUpdateField(
        fieldName: string,
        value: any
    ): Promise<any> {
        if (this.isBcryptHash(value)) {
            this.logHashUpdate(
                fieldName,
                "hash-skip-already-hashed"
            );
            return value;
        }

        this.logHashUpdate(
            fieldName,
            "hash-update"
        );
        return await this.hashFieldValue(value);
    }

    private async prepareFields(input: Record<string, any>): Promise<Record<string, any>> {
        const out: Record<string, any> = {};
        const errors: string[] = [];
        for (const key of Object.keys(this._schema)) {
            const skey =this._schema[key];

            const ftype =String(skey._type ?? "").toLowerCase();

            /*
            missing value
            */

            if (!Object.prototype.hasOwnProperty.call(input, key)) {
                if (ftype === "number" && skey._auto_increment) {
                    const v =skey._auto_increment._value ??skey._auto_increment._start;
                    out[key] = v;
                    skey._auto_increment._value = v + skey._auto_increment._step;

                } else if (
                    Object.prototype.hasOwnProperty.call(skey, "_default")
                ) {
                    out[key] =skey._default;

                } else if (
                    skey._required
                ) {
                    errors.push(`missing required field: ${key}`);
                }

                continue;
            }

            /*
            present value
            */

            const v =input[key];

            /*
            STRING
            */
            if (ftype === "string") {
                let sv =String(v ?? "");

                if (skey._max_length &&sv.length > skey._max_length) {
                    sv =sv.substring(0,skey._max_length);
                }

                if (skey._min_length && sv.length < skey._min_length) {
                    errors.push(`field ${key} too short`);
                }

                if (skey._enum && !skey._enum.includes(sv)) {
                    errors.push(`field ${key} not in enum`);
                }

                if (skey._pattern) {
                    const re =
                        new RegExp(
                            skey._pattern
                        );

                    if (!re.test(sv)) {
                        errors.push(`field ${key} pattern mismatch`);
                    }
                }
                out[key] = sv;
                continue;
            }

            /*
            NUMBER
            */
            if (ftype === "number") {
                if (skey._auto_increment) {
                    const cur = skey._auto_increment._value ?? skey._auto_increment._start;
                    out[key] = cur;
                    skey._auto_increment._value = cur + skey._auto_increment._step;
                } else {
                    const nv = Number(v);
                    if (Number.isNaN(nv)) {
                        errors.push(`field ${key} is not a number`);
                    }
                    out[key] = nv;
                }
                if (skey._min != null && out[key] < skey._min) {
                    errors.push(`field ${key} below min`);
                }

                if (skey._max != null && out[key] > skey._max) {
                    errors.push(`field ${key} above max`);
                }

                if (skey._enum && !skey._enum.includes(out[key])) {
                    errors.push(`field ${key} not in enum`);
                }
                continue;
            }
            /*DATE*/
            if (ftype === "date") {
                out[key] = new Date(v);
                continue;
            }

            /*HASH*/

            if (ftype === "hash") {

                if (this.isBcryptHash(v)) {
                    this.logHashUpdate(
                        key,
                        "hash-skip-already-hashed"
                    );

                    out[key] = v;
                } else {
                    this.logHashUpdate(
                        key,
                        "hash-update"
                    );

                    out[key] =
                        await this.hashFieldValue(v);
                }
                continue;
            }
            /*FILE*/
            if (ftype === "file") {
                const fid = this._xdb_file.addFile(v);
                out[key] = fid;
                continue;
            }
            /*array/object/bool/vector/matrix*/
            out[key] = v;
        }
        if (errors.length > 0) {
            throw new Error(
                errors.join("\n")
            );
        }
        return out;
    }

    // ---------------- indexing ----------------


    private normalizeIndexValue(value: any): string {
        if (value === undefined || value === null) {
            return "__null__";
        }
        if (typeof value === "object") {
            return JSON.stringify(value);
        }
        return String(value);
    }

    private getPrimaryIndex(): XDBIndex {
        const idx =
            this._indices["_id"];
        if (!idx) {
            throw new Error(
                "missing primary _id index"
            );
        }
        return idx;
    }

    private getDataPositionById(
        recordId: string
    ): number {
        const primary =
            this.getPrimaryIndex();
        const pos =
            primary._data[recordId];
        if (typeof pos !== "number") {
            return -1;
        }
        return pos;
    }

    private getRecordById(recordId: string): XDBEntityData | null {
        const pos = this.getDataPositionById(recordId);
        if (pos < 0 || pos >= this._data.length) {
            return null;
        }
        return this._data[pos];
    }


    indexAll() {
        const indexKeys = Object.keys(this._indices);
        this.indexFields(indexKeys);
    }

    indexFields(fields: string[], data?: any) {
        for (const f of fields) this.index(f, data);
    }

    index(indexId: string, data?: any) {
        const arr =
            data
                ? (
                    Array.isArray(data)
                        ? data
                        : [data]
                )
                : this._data;
        const index = this._indices[indexId];
        if (!index) {
            return;
        }
        index._data = {};
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i];
            if (
                !d ||
                !Object.prototype
                    .hasOwnProperty
                    .call(d, indexId)
            ) {
                continue;
            }
            const rawValue =
                d[indexId];
            const key =
                this.normalizeIndexValue(
                    rawValue
                );
            /*
            PRIMARY INDEX
            _id -> array position
            */
            if (index._primary) {
                index._data[key] = i;
                continue;
            }
            /*
            UNIQUE INDEX
            email -> recordId
            */
            if (index._unique) {
                index._data[key] =
                    d["_id"];
                continue;
            }
            /*
            ARRAY INDEX
            roles -> [recordIds]
            */
            const stype =
                String(
                    this._schema[indexId]?._type ??
                    ""
                ).toLowerCase();
            if (
                stype === "array" &&
                Array.isArray(rawValue)
            ) {
                for (const item of rawValue) {
                    const ikey =
                        this.normalizeIndexValue(
                            item
                        );
                    if (
                        !Array.isArray(
                            index._data[ikey]
                        )
                    ) {
                        index._data[ikey] = [];
                    }
                    (index._data[ikey] as string[]).push(d["_id"]);
                }
                continue;
            }

            /*
            NORMAL NON UNIQUE
            */
            if (
                !Array.isArray(
                    index._data[key]
                )
            ) {
                index._data[key] = [];
            }
            (index._data[key] as string[]).push(d["_id"]);
        }
    }


    /* ========================================================== */

    indexAdd(entityData: any) {
        for (const indexField of Object.keys(this._indices)) {
            const idx = this._indices[indexField];
            if (!idx) {
                continue;
            }
            const rawValue =
                entityData[indexField];
            if (
                rawValue === undefined ||
                rawValue === null
            ) {
                continue;
            }

            const key =
                this.normalizeIndexValue(
                    rawValue
                );
            /*
            PRIMARY
            */
            if (idx._primary) {
                idx._data[key] =
                    this._data.length - 1;
                continue;
            }
            /*
            UNIQUE
            */
            if (idx._unique) {
                idx._data[key] =
                    entityData._id;
                continue;
            }

            /*
            ARRAY FIELD
            */
            const stype =
                String(
                    this._schema[indexField]?._type ??
                    ""
                ).toLowerCase();
            if (
                stype === "array" &&
                Array.isArray(rawValue)
            ) {
                for (const item of rawValue) {
                    const ikey =
                        this.normalizeIndexValue(
                            item
                        );
                    if (
                        !Array.isArray(
                            idx._data[ikey]
                        )
                    ) {
                        idx._data[ikey] = [];
                    }
                    (idx._data[ikey] as string[]).push(entityData._id);
                }
                continue;
            }
            /*
            NORMAL NON UNIQUE
            */
            if (
                !Array.isArray(
                    idx._data[key]
                )
            ) {
                idx._data[key] = [];
            }

            (idx._data[key] as string[]).push(entityData._id);

        }

    }

    indexDelete(deletedEntity: any) {
        // simplest safe approach: re-index all (correctness > micro perf for now)
        this.indexAll();
    }

    protected findDataIndex(id: string) {
        return this._data.findIndex((r: any) => r["_id"] == id);
    }

    protected findDataIndexByField(field: string, value: any) {
        return this._data.findIndex((r: any) => r[field] == value);
    }

    findById(id: string): XDBEntityData | null {
        return this.getRecordById(id);
    }



    findOneByIndex(
        fieldName: string,
        value: any
    ): XDBEntityData | null {
        const idx = this._indices[fieldName];
        if (!idx) {
            return null;
        }
        const key = this.normalizeIndexValue(value);
        const result = idx._data[key];
        /*
        UNIQUE INDEX
        */
        if (typeof result === "string") {
            return this.getRecordById(result);
        }
        /*
        PRIMARY INDEX
        */
        if (typeof result === "number") {
            return this._data[result] ?? null;
        }
        /*
        NON UNIQUE
        */
        if (
            Array.isArray(result) &&
            result.length > 0
        ) {
            return this.getRecordById(
                result[0]
            );
        }
        return null;
    }

    // ---------------- embedding ----------------

    async embedFields(fields: string[], data?: any) {
        const arr = data ? (Array.isArray(data) ? data : [data]) : this._data;
        for (const rec of arr) {
            for (const f of fields) await this.embedField(f, rec);
        }
    }

    async embedField(fieldName: string, rec: any) {
        if (!rec || rec[fieldName] == null) return;
        if (!this._schema[fieldName]?._embed) return;

        const sourceFieldData = Array.isArray(rec[fieldName]) ? rec[fieldName] : [rec[fieldName]];
        const engine = getXdbEngine();
        const embedRes = await engine.embedArray(sourceFieldData);
        if (!embedRes?._ok) return;

        if (!this._entity_vectors_index[rec._id]) this._entity_vectors_index[rec._id] = {};

        // IMPORTANT: XDBVector should return vector ids
        const vectorIds = this._xdb_vector.addVectorMatrix(embedRes._result);
        this._entity_vectors_index[rec._id][fieldName] = vectorIds;

        this._meta._vectors = (this._meta._vectors ?? 0) + (vectorIds?.length ?? 0);
        this._need_save = true;
    }

    // ---------------- CRUD ----------------

    async add(
        data: any,
        autoCommit = true,
        indexAll = true
    ): Promise<XDBEntityData> {

        const fixedData = await this.prepareFields(data);
        if (!fixedData._id) {
            fixedData._id = _xu.guid();
        }
        if (
            this._data.find(
                (x: any) =>
                    x._id === fixedData._id
            )
        ) {
            throw new Error(
                `record with _id ${fixedData._id} already exists`
            );
        }
        const now = new Date();
        const entityData: XDBEntityData = {
            _id:
                fixedData._id,
            _created_at:
                now,
            _updated_at:
                now
        };
        for (const fieldName of Object.keys(this._schema)) {
            const v = fixedData[fieldName];
            if (v !== undefined && v !== null) {
                entityData[fieldName] = v;
            }
        }

        for (const fieldName of Object.keys(this._schema)) {
            const field = this._schema[fieldName];
            const indexDef = field?._index;
            const isUnique = typeof indexDef === "object" && indexDef?._unique === true;
            if (!isUnique) {
                continue;
            }

            const value = entityData[fieldName];
            if (value === undefined || value === null) {
                continue;
            }
            const idx = this._indices[fieldName];
            const key = this.normalizeIndexValue(value);
            if (idx && idx._data[key] !== undefined) {
                throw new Error(
                    `duplicate value for unique field '${fieldName}'`
                );
            }
        }

        this._data.push(entityData);
        this._meta._records =
            this._data.length;
        if (indexAll) {
            this.indexAdd(entityData);
        }
        // embed after push (needs _id)
        await this.embedFields(
            this._fields_lists._embedable,
            entityData
        );
        this._need_save = true;
        if (autoCommit) {
            await this.commit();
        }
        return entityData;
    }

    private checkUpdateField(
        fieldName: string,
        updateValue: any
    ): any {
        const field = this._schema[fieldName];

        if (!field) {
            throw new Error(
                `Field ${fieldName} not in schema`
            );
        }

        if (field._immutable) {
            throw new Error(
                `Field ${fieldName} is immutable`
            );
        }

        if (
            updateValue === undefined ||
            updateValue === null
        ) {
            throw new Error(
                `Field ${fieldName} value is undefined/null`
            );
        }

        const enums = field._enum;

        if (
            enums &&
            enums.length > 0 &&
            !enums.includes(updateValue)
        ) {
            throw new Error(`Field ${fieldName} value not in enum`);
        }
    }

    async update(
        filter: any,
        updates: any,
        autoCommit = true
    ) {
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

        // select data
        const engine = getXdbEngine();
        let selected = this._data;
        selected = engine.filterData(selected, filter, this._schema);
        let updatedCount = 0;
        let requiredIndexRebuild = false;
        const preparedUpdates: Record<string, any> = {};
        const preparedUpdateFields = new Set<string>();

        for (const row of selected) {
            const idx = this.findDataIndex(row._id);

            if (idx < 0) {
                continue;
            }

            this._data[idx]._updated_at = new Date();

            for (const key of Object.keys(updates)) {
                this.checkUpdateField(key, updates[key]);
                let updateValue = updates[key];
                const fieldType =
                    String(this._schema[key]?._type ?? "")
                        .toLowerCase();

                if (fieldType === "hash") {
                    if (!preparedUpdateFields.has(key)) {
                        preparedUpdates[key] =
                            await this.prepareHashUpdateField(
                                key,
                                updateValue
                            );
                        preparedUpdateFields.add(key);
                    }

                    updateValue =
                        preparedUpdates[key];
                }

                // file type
                if (
                    this._fields_lists
                        ._toFile
                        .includes(key)
                ) {

                    const oldFid =
                        this._data[idx][key];

                    if (oldFid) {
                        this._xdb_file
                            .deleteFile(oldFid);
                    }

                    const newFid =
                        this._xdb_file
                            .addFile(
                                updateValue
                            );
                    this._data[idx][key] =
                        newFid;
                } else {
                    this._data[idx][key] = updateValue;
                }

                if (
                    this._fields_lists
                        ._indexable
                        .includes(key)
                ) {
                    requiredIndexRebuild = true;
                }

                // embedding refresh
                if (
                    this._fields_lists
                        ._embedable
                        .includes(key)
                ) {

                    const oldIds =
                        this._entity_vectors_index
                        [row._id]?.[key];

                    if (oldIds?.length) {

                        this._xdb_vector
                            .deleteVectors(oldIds);
                    }

                    await this.embedField(
                        key,
                        this._data[idx]
                    );
                }

                updatedCount++;
            }
        }

        if (requiredIndexRebuild) {
            this.indexAll();
        }

        if (updatedCount > 0) {

            this._need_save = true;

            if (autoCommit) {
                await this.commit();
            }
        }

        return {
            _updated: updatedCount
        };
    }

    async delete(filter: any, autoCommit = true): Promise<{ _deleted: number }> {
        if (
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).length === 0
        ) {
            throw new Error("Empty filter");
        }

        const engine = getXdbEngine();

        const selected =
            engine.filterData(
                this._data,
                filter,
                this._schema
            );

        let deleted = 0;

        for (const row of selected) {
            const idx = this.getDataPositionById(row._id);

            if (idx < 0) {
                continue;
            }

            /*
            delete vectors
            */

            const vecFields =
                Object.keys(this._entity_vectors_index[row._id] ?? {});

            for (const f of vecFields) {
                const vids = this._entity_vectors_index[row._id][f];

                if (vids?.length) {
                    this._xdb_vector.deleteVectors(vids);
                }
            }

            delete this._entity_vectors_index[row._id];
            delete this._entity_matrices_index[row._id];

            /*
            delete files
            */

            for (const f of this._fields_lists._toFile) {
                const fid = this._data[idx][f];

                if (fid) {
                    this._xdb_file.deleteFile(fid);
                }
            }

            /*
            remove row
            */

            this._data.splice(idx, 1);

            deleted++;
        }

        /*
        IMPORTANT:
        primary indexes store array positions.
        splice() changes positions.
        must rebuild indexes.
        */

        if (deleted > 0) {
            this._meta._records = this._data.length;
            this.indexAll();
            this._need_save = true;
            if (autoCommit) {
                await this.commit();
            }
        }
        return {
            _deleted: deleted
        };
    }

    // ---------------- find (simple / portable) ----------------

    find(
        filter: any = {},
        skip = 0,
        limit = 100000,
        includeScheme = false,
        reverseOrder = false,
        sortInput?: SortInput
    ) {

        let outData = this._data;

        if (
            filter &&
            typeof filter === "object" &&
            Object.keys(filter).length > 0
        ) {

            const engine =
                getXdbEngine();

            outData =
                engine.filterData(
                    outData,
                    filter,
                    this._schema
                );
        }

        if (sortInput) {

            const f =
                sortInput._sort_by;

            const order =
                sortInput._sort_order ?? "asc";

            if (this._schema[f]) {

                outData =
                    [...outData].sort(
                        (a: any, b: any) => {

                            const av = a[f];
                            const bv = b[f];

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
                                this._schema[f]._type === "Date"
                            ) {
                                return (
                                    new Date(av).getTime() -
                                    new Date(bv).getTime()
                                ) * dir;
                            }

                            return String(av)
                                .localeCompare(
                                    String(bv)
                                ) * dir;
                        }
                    );
            }
        }

        const total =
            outData.length;

        outData =
            outData.slice(
                skip,
                skip + limit
            );

        if (reverseOrder) {
            outData = [...outData].reverse();
        }

        return {
            _meta: {
                _name:
                    this._name,
                _skip:
                    skip,
                _limit:
                    limit,
                _total_records:
                    total,
                _records:
                    outData.length,
                ...(includeScheme
                    ? {
                        _schema:
                            this._schema
                    }
                    : {})
            },
            _data:
                outData,
            _vectors_ids:
                this._entity_vectors_index,
            _matrices:
                this._entity_matrices_index
        };
    }
}

export default XDBEntity;
