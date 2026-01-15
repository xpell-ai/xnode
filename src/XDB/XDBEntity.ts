/**
 * XDBEntity — portable runtime entity (xpell-node friendly)
 * - No python-manager / WormholesClient imports
 * - No UtilsManager
 * - All persistence goes via XDBEngine -> IXDBStorage
 */

import bcrypt from "bcryptjs";
import { XObject, type XObjectData, _xlog, XResponseData, XResponse } from "xpell-core";
import _xu from "../XNUtils/XUtils.js";
import { _xem } from "../XEM/XEventManager.js";

import XDB from "./XDB.js";
import XDBVector from "./XDBVector.js";
import XDBFile from "./XDBFile.js";
import XDBTemp from "./XDBTemp.js";
import { assertXdbReady, getXdbEngine } from "./xdbReady.js";

// ---------------- Types ----------------

const BCRYPT_SALT_OR_ROUNDS = 10;

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
    [idx: string]: string[] | number;
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
        if (!this._schema.hasOwnProperty("_id")) this._schema["_id"] = _scheme_id_default;

        this._schema["_created_at"] = { _type: "Date", _required: false, _immutable: true };
        this._schema["_updated_at"] = { _type: "Date", _required: false };

        this._meta._name = this._name;

        this.initFields();

        // register entity inside engine (engine decides what to do)
        const engine = getXdbEngine();
        engine.addEntity(this);

        // load async
        void this.loadData().then(() => _xem.fire("xentity-loaded", this._name));
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

    private async prepareFields(input: Record<string, any>): Promise<XResponse> {
        const res = new XResponse();
        const out: Record<string, any> = {};

        res._ok = true;
        res._result = "Errors in fields: ";

        for (const key of Object.keys(this._schema)) {
            const skey = this._schema[key];
            const ftype = String(skey._type ?? "").toLowerCase();

            // missing value
            if (!Object.prototype.hasOwnProperty.call(input, key)) {
                if (ftype === "number" && skey._auto_increment) {
                    const v = skey._auto_increment._value ?? skey._auto_increment._start;
                    out[key] = v;
                    skey._auto_increment._value = v + skey._auto_increment._step;
                } else if (Object.prototype.hasOwnProperty.call(skey, "_default")) {
                    out[key] = skey._default;
                } else if (skey._required) {
                    res._ok = false;
                    res._result += `missing required field: ${key}\n`;
                }
                continue;
            }

            // present value
            const v = input[key];

            if (ftype === "string") {
                let sv = String(v ?? "");
                if (skey._max_length && sv.length > skey._max_length) sv = sv.substring(0, skey._max_length);
                if (skey._min_length && sv.length < skey._min_length) {
                    res._ok = false;
                    res._result += `field ${key} too short\n`;
                }
                if (skey._enum && !skey._enum.includes(sv)) {
                    res._ok = false;
                    res._result += `field ${key} not in enum\n`;
                }
                if (skey._pattern) {
                    const re = new RegExp(skey._pattern);
                    if (!re.test(sv)) {
                        res._ok = false;
                        res._result += `field ${key} pattern mismatch\n`;
                    }
                }
                out[key] = sv;
            } else if (ftype === "number") {
                if (skey._auto_increment) {
                    const cur = skey._auto_increment._value ?? skey._auto_increment._start;
                    out[key] = cur;
                    skey._auto_increment._value = cur + skey._auto_increment._step;
                } else {
                    const nv = Number(v);
                    if (Number.isNaN(nv)) {
                        res._ok = false;
                        res._result += `field ${key} is not a number\n`;
                    }
                    out[key] = nv;
                }
                if (skey._min != null && out[key] < skey._min) {
                    res._ok = false;
                    res._result += `field ${key} below min\n`;
                }
                if (skey._max != null && out[key] > skey._max) {
                    res._ok = false;
                    res._result += `field ${key} above max\n`;
                }
                if (skey._enum && !skey._enum.includes(out[key])) {
                    res._ok = false;
                    res._result += `field ${key} not in enum\n`;
                }
            } else if (ftype === "date") {
                out[key] = new Date(v);
            } else if (ftype === "hash") {
                const salt = await bcrypt.genSalt(BCRYPT_SALT_OR_ROUNDS);
                out[key] = await bcrypt.hash(String(v ?? ""), salt);
            } else if (ftype === "file") {
                // store file via helper -> returns fid
                const fid = this._xdb_file.addFile(v);
                out[key] = fid;
            } else {
                // array/object/bool/vector/matrix etc — keep raw
                out[key] = v;
            }
        }

        if (res._ok) res._result = out;
        return res;
    }

    // ---------------- indexing ----------------

    indexAll() {
        const indexKeys = Object.keys(this._indices);
        this.indexFields(indexKeys);
    }

    indexFields(fields: string[], data?: any) {
        for (const f of fields) this.index(f, data);
    }

    index(indexId: string, data?: any) {
        const arr = data ? (Array.isArray(data) ? data : [data]) : this._data;
        const index = this._indices[indexId];
        if (!index) return;

        index._data = {};

        for (const d of arr) {
            if (!d || !Object.prototype.hasOwnProperty.call(d, indexId)) continue;

            if (index._primary) {
                index._data[d[indexId]] = this.findDataIndex(d["_id"]);
                continue;
            }

            if (index._unique) {
                index._data[d[indexId]] = this.findDataIndexByField(indexId, d[indexId]);
                continue;
            }

            const stype = String(this._schema[indexId]?._type ?? "").toLowerCase();
            if (stype === "array" && Array.isArray(d[indexId])) {
                for (const item of d[indexId]) {
                    index._data[item] = index._data[item] || [];
                    (index._data[item] as string[]).push(d["_id"]);
                }
            } else {
                index._data[d[indexId]] = index._data[d[indexId]] || [];
                (index._data[d[indexId]] as string[]).push(d["_id"]);
            }
        }
    }

    indexAdd(entityData: any) {
        for (const indexField of Object.keys(this._indices)) {
            const idx = this._indices[indexField];
            if (!idx) continue;
            if (entityData && entityData[indexField] != null) {
                idx._data[entityData[indexField]] = this.findDataIndexByField(indexField, entityData[indexField]);
            }
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
        const cacheIdx = this._indices["_id"]?._data?.[id] as any;
        const idx = typeof cacheIdx === "number" ? cacheIdx : this.findDataIndex(id);
        return idx >= 0 ? this._data[idx] : null;
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

    async add(data: any, autoCommit = true, indexAll = true): Promise<XResponseData> {
        const res = new XResponse();

        try {
            const fixed = await this.prepareFields(data);
            if (!fixed._ok) {
                res._ok = false;
                res._result = fixed._result;
                return res.toXData();
            }

            const fixedData = fixed._result as any;

            if (!fixedData._id) fixedData._id = _xu.guid();
            if (this._data.find((x: any) => x._id === fixedData._id)) {
                throw new Error(`record with _id ${fixedData._id} already exists`);
            }

            const now = new Date();
            const entityData: XDBEntityData = { _id: fixedData._id, _created_at: now, _updated_at: now };

            for (const fieldName of Object.keys(this._schema)) {
                const v = fixedData[fieldName];
                if (v !== undefined && v !== null) entityData[fieldName] = v;
            }

            this._data.push(entityData);
            this._meta._records = this._data.length;

            if (indexAll) this.indexAdd(entityData);

            // embed after push (needs _id)
            await this.embedFields(this._fields_lists._embedable, entityData);

            this._need_save = true;

            if (autoCommit) await this.commit();

            res._ok = true;
            res._result = entityData;
            return res.toXData();
        } catch (e: any) {
            res._ok = false;
            res._result = e?.message ?? String(e);
            return res.toXData();
        }
    }

    private checkUpdateField(fieldName: string, updateValue: any) {
        const res = new XResponse();
        res._ok = true;
        res._result = "";

        if (!this._schema[fieldName]) {
            res._ok = false;
            res._result = `Field ${fieldName} not in schema`;
            return res;
        }
        if (this._schema[fieldName]._immutable) {
            res._ok = false;
            res._result = `Field ${fieldName} is immutable`;
            return res;
        }
        if (updateValue === undefined || updateValue === null) {
            res._ok = false;
            res._result = `Field ${fieldName} value is undefined/null`;
            return res;
        }
        const enums = this._schema[fieldName]._enum;
        if (enums && enums.length > 0 && !enums.includes(updateValue)) {
            res._ok = false;
            res._result = `Field ${fieldName} value not in enum`;
        }
        return res;
    }

    async update(filter: any, updates: any, autoCommit = true): Promise<XResponseData> {
        const res = new XResponse();

        if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) {
            res._ok = false;
            res._result = "Empty filter";
            return res.toXData();
        }
        if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) {
            res._ok = false;
            res._result = "Empty updates";
            return res.toXData();
        }

        // select data (supports semantic filtering via engine like your legacy)
        const engine = getXdbEngine();
        let selected = this._data;
        selected = engine.filterData(selected, filter, this._schema);

        let updatedCount = 0;
        let requiredIndexRebuild = false;

        for (const row of selected) {
            const idx = this.findDataIndex(row._id);
            if (idx < 0) continue;

            this._data[idx]._updated_at = new Date();

            for (const key of Object.keys(updates)) {
                const valid = this.checkUpdateField(key, updates[key]);
                if (!valid._ok) continue;

                // file type
                if (this._fields_lists._toFile.includes(key)) {
                    const oldFid = this._data[idx][key];
                    if (oldFid) this._xdb_file.deleteFile(oldFid);
                    const newFid = this._xdb_file.addFile(updates[key]);
                    this._data[idx][key] = newFid;
                } else {
                    this._data[idx][key] = updates[key];
                }

                if (this._fields_lists._indexable.includes(key)) requiredIndexRebuild = true;

                // if embed field changed: re-embed
                if (this._fields_lists._embedable.includes(key)) {
                    // delete old vectors for this field if exist
                    const oldIds = this._entity_vectors_index[row._id]?.[key];
                    if (oldIds?.length) this._xdb_vector.deleteVectors(oldIds);

                    await this.embedField(key, this._data[idx]);
                }

                updatedCount++;
            }
        }

        if (requiredIndexRebuild) this.indexAll();

        if (updatedCount > 0) {
            this._need_save = true;
            if (autoCommit) await this.commit();
        }

        res._ok = true;
        res._result = { _meta: { _updated: updatedCount } };
        return res.toXData();
    }

    async delete(filter: any, autoCommit = true): Promise<XResponseData> {
        const res = new XResponse();

        if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) {
            res._ok = false;
            res._result = "Empty filter";
            return res.toXData();
        }

        const engine = getXdbEngine();
        const selected = engine.filterData(this._data, filter, this._schema);
        let deleted = 0;

        for (const row of selected) {
            const idx = this.findDataIndex(row._id);
            if (idx < 0) continue;

            // delete vectors
            const vecFields = Object.keys(this._entity_vectors_index[row._id] ?? {});
            for (const f of vecFields) {
                const vids = this._entity_vectors_index[row._id][f];
                if (vids?.length) this._xdb_vector.deleteVectors(vids);
            }
            delete this._entity_vectors_index[row._id];
            delete this._entity_matrices_index[row._id];

            // delete files
            for (const f of this._fields_lists._toFile) {
                const fid = this._data[idx][f];
                if (fid) this._xdb_file.deleteFile(fid);
            }

            this._data.splice(idx, 1);
            deleted++;
        }

        if (deleted > 0) {
            this._meta._records = this._data.length;
            this.indexAll();
            this._need_save = true;
            if (autoCommit) await this.commit();
        }

        res._ok = true;
        res._result = `${deleted} records deleted`;
        return res.toXData();
    }

    // ---------------- find (simple / portable) ----------------

    find(
        filter: any,
        skip = 0,
        limit = 100000,
        includeScheme = false,
        reverseOrder = false,
        sortInput?: SortInput
    ): XResponseData {
        const res = new XResponse();

        let outData = this._data;

        if (filter && typeof filter === "object" && Object.keys(filter).length > 0) {
            const engine = getXdbEngine();
            outData = engine.filterData(outData, filter, this._schema);
        }

        if (sortInput) {
            const f = sortInput._sort_by;
            const order = sortInput._sort_order ?? "asc";
            if (this._schema[f]) {
                outData = [...outData].sort((a: any, b: any) => {
                    const av = a[f];
                    const bv = b[f];
                    const dir = order === "asc" ? 1 : -1;
                    if (av == null && bv == null) return 0;
                    if (av == null) return -1 * dir;
                    if (bv == null) return 1 * dir;
                    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
                    if (this._schema[f]._type === "Date") return (new Date(av).getTime() - new Date(bv).getTime()) * dir;
                    return String(av).localeCompare(String(bv)) * dir;
                });
            }
        }

        const total = outData.length;
        outData = outData.slice(skip, skip + limit);
        if (reverseOrder) outData = [...outData].reverse();

        res._ok = true;
        res._result = {
            _meta: {
                _name: this._name,
                _skip: skip,
                _limit: limit,
                _total_records: total,
                _records: outData.length,
                ...(includeScheme ? { _schema: this._schema } : {}),
            },
            _data: outData,
            _vectors_ids: this._entity_vectors_index,
            _matrices: this._entity_matrices_index,
        };

        return res.toXData();
    }
}

export default XDBEntity;
