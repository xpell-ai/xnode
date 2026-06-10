/**
 * XDBEngine — storage-agnostic runtime engine
 * Keeps core filtering + semantic logic in-memory, delegates persistence to IXDBStorage.
 *
 * FIXES vs your pasted version:
 * - Normalizes _last_commit to Date (no `as any`)
 * - Ensures meta exists on first boot by committing once when meta is missing
 * - Adds close()/dispose() to close storage cleanly
 * - Fixes `filterData()` bug: `out = data.filter(...)` should use `out.filter(...)` and guard when data isn't array
 * - Keeps binary vector Buffer conversion correct (byteOffset/byteLength safe)
 * - Removes unused imports/vars (fieldsToDate was unused in this snippet; keep if used elsewhere)
 */

import { _xlog, XResponse } from "@xpell/core";
import _xu from "../XNUtils/XUtils.js";

import type XDBEntity from "./XDBEntity.js";
import type { IXDBStorage, XDBData, XDBEntityPersisted } from "./IXDBStorage.js";

// ---- security modes (kept for compatibility) ----
const _xdb_data_security = {
    PLAIN_TEXT: "plain-text",
    BASE64_ENCODING: "base64",
};

// NOTE: You used scaling for float32 vectors; keep as-is.
const _floating_point_scale = 1;

// ---- filters ----
export type XDBDataFilters = {
    [key: string]: (f: any, v: any) => boolean;
};

const objectSearch = (f: any, v: any) => {
    const vo = v?.o || "=";
    if (!f || !v || !Object.prototype.hasOwnProperty.call(f, v.k)) return false;
    const op = dataFilters[vo];
    return op ? op(f[v.k], v.v) : false;
};

const dataFilters: XDBDataFilters = {
    "_starts_with": (f: any, v: any) => String(f).startsWith(String(v)),
    "_starts": (f: any, v: any) => String(f).startsWith(String(v)),
    "_ends_with": (f: any, v: any) => String(f).endsWith(String(v)),
    "_ends": (f: any, v: any) => String(f).endsWith(String(v)),
    "_contains": (f: any, v: any) => String(f).indexOf(String(v)) > -1,
    "_is_empty": (f: any) => (f?.length ?? 0) === 0,
    "_empty": (f: any) => (f?.length ?? 0) === 0,
    "_equals": (f: any, v: any) => f == v,
    "_eq": (f: any, v: any) => f == v,
    "_in": (f: any, v: any) => (Array.isArray(v) ? v.includes(f) : false),
    "=": (f: any, v: any) => f == v,
    ">": (f: any, v: any) => f > v,
    ">=": (f: any, v: any) => f >= v,
    "_gt": (f: any, v: any) => f > v,
    "_gte": (f: any, v: any) => f >= v,
    "<": (f: any, v: any) => f < v,
    "<=": (f: any, v: any) => f <= v,
    "_lte": (f: any, v: any) => f <= v,
    "_lt": (f: any, v: any) => f < v,
    "_includes": (f: any, v: any) => (Array.isArray(f) ? f.includes(v) : false),
    "_object_search": objectSearch,
    "_object_array_search": (f: any, v: any) => {
        if (!v || !Object.prototype.hasOwnProperty.call(v, "k") || !Object.prototype.hasOwnProperty.call(v, "v")) return false;
        const field = f?.[v.k];
        return Array.isArray(field) ? field.includes(v.v) : false;
    },

    // Date ops
    "_year": (f: any, v: any) => f.getFullYear() == v,
    "_month": (f: any, v: any) => (f.getMonth() + 1) == v,
    "_day": (f: any, v: any) => f.getDate() == v,
    "_second": (f: any, v: any) => f.getSeconds() == v,

    "_date_eq": (f: any, v: any) => f.getTime() == new Date(v).getTime(),
    "_date_gt": (f: any, v: any) => f.getTime() > new Date(v).getTime(),
    "_date_gte": (f: any, v: any) => f.getTime() >= new Date(v).getTime(),
    "_date_lt": (f: any, v: any) => f.getTime() < new Date(v).getTime(),
    "_date_lte": (f: any, v: any) => f.getTime() <= new Date(v).getTime(),

    "_date_ignore_time_eq": (f: any, v: any) => {
        const fdate = new Date(new Date(f).setHours(0, 0, 0, 0));
        const date = new Date(v);
        date.setHours(0, 0, 0, 0);
        return fdate.getTime() == date.getTime();
    },
    "_date_ignore_time_gt": (f: any, v: any) => {
        const fdate = new Date(new Date(f).setHours(0, 0, 0, 0));
        const date = new Date(v);
        date.setHours(0, 0, 0, 0);
        return fdate.getTime() > date.getTime();
    },
    "_date_ignore_time_gte": (f: any, v: any) => {
        const fdate = new Date(new Date(f).setHours(0, 0, 0, 0));
        const date = new Date(v);
        date.setHours(0, 0, 0, 0);
        return fdate.getTime() >= date.getTime();
    },
    "_date_ignore_time_lt": (f: any, v: any) => {
        const fdate = new Date(new Date(f).setHours(0, 0, 0, 0));
        const date = new Date(v);
        date.setHours(0, 0, 0, 0);
        return fdate.getTime() < date.getTime();
    },
    "_date_ignore_time_lte": (f: any, v: any) => {
        const fdate = new Date(new Date(f).setHours(0, 0, 0, 0));
        const date = new Date(v);
        date.setHours(0, 0, 0, 0);
        return fdate.getTime() <= date.getTime();
    },
};

// ---- optional adapters for embeddings + MAT querying (so xpell-node doesn't import aime server modules) ----
export interface IXDBEmbeddingProvider {
    embedArray(input: string[]): Promise<XResponse>;
}

export interface IXDBVectorQueryProvider {
    queryEntity(params: {
        _entity_name: string;
        _matIds: string[];
        _queryVec: any;
        _threshold: number;
        _getTopk?: boolean;
        _k?: number;
    }): Promise<any[]>;
}



export type XDBOptions = {
    _type?: "fs" | "sqlite";
    _root?: string;
    _cache?: boolean;
    _sqlite?: {
        _db_path?: string;
        _wal?: boolean;
        _busy_timeout_ms?: number;
    };
    _embedder?: IXDBEmbeddingProvider;
    _vector_query?: IXDBVectorQueryProvider;
};

export class XDBEngine {
    _initialized = false;
    _xdb_data: XDBData;

    _entities_transmitted = 0;
    _transmit = true;
    _debug = false;

    private _storage: IXDBStorage;
    private _embedder?: IXDBEmbeddingProvider;
    private _vectorQuery?: IXDBVectorQueryProvider;

    private _envName: string;
    private _save_json_vectors = true; // default true for FS backward compatibility


    constructor(opts: {
        storage: IXDBStorage;
        embedder?: IXDBEmbeddingProvider;
        vectorQuery?: IXDBVectorQueryProvider;
        envName?: string;
    }) {
        this._storage = opts.storage;
        this._embedder = opts.embedder;
        this._vectorQuery = opts.vectorQuery;
        this._envName = (opts.envName ?? process.env.ENV_NAME ?? "local").toLowerCase();

        this._xdb_data = {
            _engine: _xu.guid(),
            _security: _xdb_data_security.PLAIN_TEXT,
            _number_of_cached_entities: 0,
            _entities: [],
        };
    }

    get _xdb_data_security() {
        return _xdb_data_security;
    }

    get version(): string {
        return this._xdb_data._engine;
    }

    hasSemantic(): boolean {
        return !!this._embedder && !!this._vectorQuery;
    }

    /**
     * Initialize xdb (storage open + load meta)
     */
    async init() {
        await this._storage.open();
        await this.loadData();
        this._initialized = true;
    }

    /**
     * Close storage
     */
    async close() {
        await this._storage.close();
        this._initialized = false;
    }

    /**
     * Load meta from storage into engine state
     */
    async loadData() {
        const meta = await this._storage.loadXdbMeta();

        if (meta) {
            if (meta._engine) this._xdb_data._engine = meta._engine;
            if (meta._security) this._xdb_data._security = meta._security;
            if (typeof meta._number_of_cached_entities === "number") {
                this._xdb_data._number_of_cached_entities = meta._number_of_cached_entities;
            }
            if (Array.isArray(meta._entities)) this._xdb_data._entities = meta._entities;

            if (meta._last_commit) {
                this._xdb_data._last_commit =
                    meta._last_commit instanceof Date ? meta._last_commit : new Date(meta._last_commit);
            }

            _xlog.log(`xdb-engine: ${this._xdb_data._engine} loaded`);
            _xlog.log(`xdb-engine: ${this._xdb_data._entities.length} entities loaded`);
            return;
        }

        // First boot: persist meta once so storage has a baseline (matches old aime.json behavior)
        _xlog.log(`New XDB (v${this._xdb_data._engine}) is created with _security: ${this._xdb_data._security}`);
        await this.commit();
    }

    /**
     * Add entity name to meta
     */
    addEntity(xdbEntity: XDBEntity, autoCommit = true) {
        const name = (xdbEntity as any)._name as string;
        if (!this._xdb_data._entities.includes(name)) {
            this._xdb_data._entities.push(name);
            if (autoCommit) void this.commit();
        }
    }

    removeEntity(entityName: string, autoCommit = true) {
        const name = String(entityName ?? "");
        if (!name) return false;

        const before = this._xdb_data._entities.length;
        this._xdb_data._entities = this._xdb_data._entities.filter((entity) => entity !== name);
        const removed = this._xdb_data._entities.length !== before;

        if (removed) {
            this._xdb_data._number_of_cached_entities = this._xdb_data._entities.length;
        }

        if (removed && autoCommit) void this.commit();
        return removed;
    }

    /**
     * Commit meta to storage
     */
    async commit() {
        this._xdb_data._number_of_cached_entities = this._xdb_data._entities.length;
        this._xdb_data._last_commit = new Date();
        await this._storage.saveXdbMeta(this._xdb_data);
    }

    /**
     * Load a full entity payload from storage
     */
    async loadEntity(entity: XDBEntity): Promise<XDBEntityPersisted> {
        const name = (entity as any)._name as string;
        const payload = await this._storage.loadEntity(name);

        if (!payload) {
            return {
                _data: (entity as any)._data,
                _vectors: (entity as any)._vectors,
                _indices: (entity as any)._indices,
                _entity_vectors_index: (entity as any)._entity_vectors_index,
                _meta: (entity as any)._meta,
                _entity_matrices_index: (entity as any)._entity_matrices_index,
                _schema: (entity as any)._schema,
            };
        }

        return {
            _data: payload._data ?? (entity as any)._data,
            _vectors: payload._vectors ?? (entity as any)._vectors,
            _indices: payload._indices ?? (entity as any)._indices,
            _entity_vectors_index: payload._entity_vectors_index ?? (entity as any)._entity_vectors_index,
            _meta: payload._meta ?? (entity as any)._meta,
            _entity_matrices_index: payload._entity_matrices_index ?? (entity as any)._entity_matrices_index,
            _schema: payload._schema ?? (entity as any)._schema,
        };
    }

    /**
     * Persist entity payload to storage
     */
    async saveEntity(entity: XDBEntity, saveSchema = true) {
        const name = (entity as any)._name as string;
        const payload: XDBEntityPersisted = {
            _meta: (entity as any)._meta,
            _schema: (entity as any)._schema,
            _data: (entity as any)._data,
            _vectors: (entity as any)._vectors,
            _entity_vectors_index: (entity as any)._entity_vectors_index,
            _entity_matrices_index: (entity as any)._entity_matrices_index,
            _indices: (entity as any)._indices,
        };

        await this._storage.saveEntity(name, payload, saveSchema);
    }

    // ---- vectors (delegated) ----
    async saveVector(entityName: string, vectorId: string, vector: number[]) {
        // optional JSON vector storage (if FS impl supports it)
        if (this._save_json_vectors) await this._storage.saveVector(entityName, vectorId, vector);

        // recommended binary vector storage
        const buffer = this.vectorToFloat32Buffer(vector);
        await this._storage.saveVectorBinary(entityName, vectorId, buffer);
    }

    async deleteVector(entityName: string, vectorId: string) {
        await this._storage.deleteVector(entityName, vectorId);
    }

    async loadVector(entityName: string, vectorId: string): Promise<number[]> {
        const v = await this._storage.loadVector(entityName, vectorId);
        if (v) return v;

        const bin = await this._storage.loadVectorBinary(entityName, vectorId);
        if (!bin) return [];
        return this.float32BufferToVector(bin);
    }

    async loadVectorAsBase64(entityName: string, vectorId: string): Promise<string> {
        return await this.loadVectorBinaryOrJsonAsBase64(entityName, vectorId);
    }

    async saveVectorIndex(entityName: string, data: any) {
        await this._storage.saveVectorIndex(entityName, data);
    }

    async loadVectorIndex(entityName: string): Promise<any | undefined> {
        const idx = await this._storage.loadVectorIndex(entityName);
        return idx ?? undefined;
    }

    // ---- files (delegated) ----
    async saveFile(entityName: string, fileId: string, data: any) {
        await this._storage.saveFile(entityName, fileId, data);
    }
    async deleteFile(entityName: string, fileId: string) {
        await this._storage.deleteFile(entityName, fileId);
    }
    async loadFile(entityName: string, fileId: string): Promise<string> {
        return (await this._storage.loadFile(entityName, fileId)) ?? "";
    }

    // ---- object store (delegated) ----
    async saveObject(objectName: string, object: any) {
        await this._storage.saveObject(objectName, object);
        return true;
    }

    async getObject(objectName: string, format: "string" | "json" = "json"): Promise<any> {
        const raw = await this._storage.loadObject(objectName);
        if (raw == null) return false;
        try {
            return format === "json" ? JSON.parse(raw) : raw;
        } catch (e: any) {
            _xlog.error("XDBEngine.getObject() error: " + e.message);
            return false;
        }
    }

    async hasObject(objectName: string): Promise<boolean> {
        return await this._storage.hasObject(objectName);
    }

    // ---- temp (delegated) ----
    async loadTempCsv(entityName: string, copy = false) {
        return (await this._storage.loadTempCsv(entityName, copy)) ?? "";
    }
    async appendCsv(entityName: string, data: string) {
        await this._storage.appendCsv(entityName, data);
        return true;
    }
    async saveTempFile(entityName: string, fid: string, data: any) {
        await this._storage.saveTempFile(entityName, fid, data);
        return true;
    }
    async loadTempFile(entityName: string, fid: string) {
        return (await this._storage.loadTempFile(entityName, fid)) ?? "";
    }
    async deleteTempFile(entityName: string, fid: string) {
        await this._storage.deleteTempFile(entityName, fid);
        return true;
    }
    async clearTempCsv(entityName: string) {
        await this._storage.clearTempCsv(entityName);
        return true;
    }
    async getAllTempFileNames(entityName: string) {
        return await this._storage.getAllTempFileNames(entityName);
    }
    async copyTempCsv(entityName: string) {
        await this._storage.copyTempCsv(entityName);
        return true;
    }

    // ---- maintenance utilities (optional) ----
    private get _mnt() {
        // storage may or may not support maintenance
        return this._storage as unknown as Partial<import("./IXDBMaintenance.js").IXDBMaintenance>;
    }

    async zipFolder(folder: string) {
        if (!this._mnt.zipFolder) {
            throw new Error("XDBEngine.zipFolder(): storage does not support zipFolder()");
        }
        await this._mnt.zipFolder(folder);
        return true;
    }

    async unzip(zipFilePath: string, destination = "") {
        if (!this._mnt.unzip) {
            throw new Error("XDBEngine.unzip(): storage does not support unzip()");
        }
        await this._mnt.unzip(zipFilePath, destination);
        return true;
    }

    async deleteFolder(folderPath: string) {
        if (!this._mnt.deleteFolder) {
            throw new Error("XDBEngine.deleteFolder(): storage does not support deleteFolder()");
        }
        await this._mnt.deleteFolder(folderPath);
    }

    async copyFolder(source: string, destination: string) {
        if (!this._mnt.copyFolder) {
            throw new Error("XDBEngine.copyFolder(): storage does not support copyFolder()");
        }
        await this._mnt.copyFolder(source, destination);
    }

    async createFolder(folderPath: string) {
        if (!this._mnt.ensureFolder) {
            throw new Error("XDBEngine.createFolder(): storage does not support ensureFolder()");
        }
        await this._mnt.ensureFolder(folderPath);
    }
    // =============================================================================//

    /**
     * Set data security
     */
    setDataSecurity(security: string) {
        this._xdb_data._security = security;
        _xlog.log("setting _security to: " + security);
    }

    // =============================================================================
    // Core filtering logic (kept in-engine)
    // =============================================================================

    filterData(data: any, queryCriteria: any, schema: any) {
        const keys = Object.keys(queryCriteria || {});
        if (!Array.isArray(data)) return data; // ✅ guard

        let out = data;

        if (keys.length > 0) {
            const filter = (rec: any) => {
                let bout = true;
                let logicalExp = false;

                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    let vl = queryCriteria[k];

                    if (!schema?.[k]) continue;

                    const stype = String(schema[k]._type ?? "").toLowerCase();

                    // skip embed fields in normal filter
                    if (schema[k]._embed) {
                        logicalExp = true;
                        continue;
                    }

                    if (Object.prototype.hasOwnProperty.call(rec, k) || typeof vl === "object") {
                        if (typeof vl !== "object") {
                            if (stype === "date") {
                                const recDate = new Date(rec[k]);
                                const qDate = new Date(vl);
                                logicalExp = recDate.getTime() === qDate.getTime();
                            } else {
                                logicalExp = rec[k] === vl;
                            }
                            bout = bout && logicalExp;
                        } else {
                            const o_keys = Object.keys(vl);
                            for (let j = 0; j < o_keys.length; j++) {
                                let op = o_keys[j];
                                let not = false;

                                if (op.startsWith("!")) {
                                    not = true;
                                    op = op.substring(1);
                                }

                                if (Object.prototype.hasOwnProperty.call(dataFilters, op)) {
                                    if (rec[k] == null) {
                                        logicalExp = true;
                                    } else {
                                        let param1 = rec[k];
                                        let value1 = vl[o_keys[j]];

                                        if (stype === "date") {
                                            param1 = new Date(rec[k]);
                                            if (!op.startsWith("_")) value1 = new Date(value1);
                                        }

                                        logicalExp = dataFilters[op](param1, value1);
                                        if (!logicalExp) bout = false;
                                    }
                                }

                                // preserve your original "not / falsy" behavior
                                if (not || !vl[op]) logicalExp = !logicalExp;
                            }
                        }
                    } else {
                        bout = false;
                    }
                }

                return bout && logicalExp;
            };

            // ✅ FIX: filter on current `out`
            out = out.filter(filter);
        }

        return out;
    }

    checkValueFormat(queryCriteriaVal: any) {
        if (queryCriteriaVal?._query) return queryCriteriaVal._query;
        if (typeof queryCriteriaVal !== "object") return queryCriteriaVal;

        const innerKeys = Object.keys(queryCriteriaVal);
        let finalVal = "";
        innerKeys.forEach((k) => (finalVal += queryCriteriaVal[k]));
        return finalVal;
    }

    async semanticFilterData(data: any, queryCriteria: any, schema: any) {
        const keys = Object.keys(queryCriteria || {});
        let fullout = data;
        let out = data;

        if (keys.length > 0 && data?._data) {
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (k.startsWith("$")) continue;

                if (schema?.[k]?._embed) {
                    const query = this.checkValueFormat(queryCriteria[k]);
                    const threshold = queryCriteria[k]?._threshold ?? 0.9;
                    const topkSearch = queryCriteria[k]?._topk_search ?? false;
                    const kk = queryCriteria[k]?._k ?? 3;

                    if (query) {
                        if (!this.hasSemantic()) {
                            throw new Error("XDBEngine.semanticFilterData(): no embedder or vectorQuery configured");
                        }
                        out = await this.semanticSearchEngine(query, threshold, kk, k, fullout, topkSearch);
                    }
                }
            }
        }

        return out._data;
    }

    /**
     * Default embed uses xpell runtime azure-manager.
     * You can inject a custom embedder via constructor.
     */
    async embedArray(input: string[]): Promise<XResponse> {
        if (!this._embedder) {
            throw new Error("XDBEngine.embedArray(): no embedder configured");
        }
        return await this._embedder.embedArray(input);
    }

    /**
     * Semantic search calls MAT via injected vectorQuery provider (recommended).
     * Keeps xpell-node clean from aime server imports.
     */
    async semanticSearchEngine(
        query: string[],
        threshold = 0.9,
        k = 3,
        field: string,
        data: any,
        topkSearch: any
    ): Promise<any> {
        const res: any = { _data: [] };

        if (!this._embedder) {
            throw new Error("XDBEngine.semanticSearchEngine: no embedder configured");
        }
        if (!this._vectorQuery) {
            throw new Error("XDBEngine.semanticSearchEngine: no vectorQuery provider injected");
        }

        const entities = data;
        const searchMatrixIds: string[] = [];
        const entitiesVecIds: Record<string, string[]> = {};
        const filterIds: Record<string, number> = {};

        for (let i = 0; i < entities._data.length; i++) {
            const entityId = entities._data[i]._id;

            if (!entities._vectors_ids?.[entityId]?.[field]) continue;
            if (!entities._data[i][field]) continue;

            if (!entitiesVecIds[entityId]) entitiesVecIds[entityId] = [];
            const idsForField: string[] = entities._vectors_ids[entityId][field];
            idsForField.forEach((vid: string) => entitiesVecIds[entityId].push(vid));

            const mid = entities._matrices?.[entityId]?.[field];
            if (mid) searchMatrixIds.push(mid);
        }

        const embeddedInput = await this.embedArray(query);

        const relVecs = await this._vectorQuery.queryEntity({
            _entity_name: this._envName,
            _matIds: searchMatrixIds,
            _queryVec: embeddedInput._result,
            _threshold: threshold,
            _getTopk: !!topkSearch,
            _k: k,
        });

        relVecs.forEach((relRes: any) => {
            Object.keys(entitiesVecIds).forEach((entityId) => {
                if (entitiesVecIds[entityId].includes(relRes._id)) {
                    filterIds[entityId] = (filterIds[entityId] ?? 0) + 1;
                }
            });
        });

        const finalIds = Object.keys(filterIds)
            .sort((a, b) => (filterIds[b] ?? 0) - (filterIds[a] ?? 0))
            .slice(0, k);

        const unique = [...new Set(finalIds)];
        unique.forEach((id) => {
            entities._data.forEach((entity: any) => {
                if (entity._id == id) res._data.push(entity);
            });
        });

        return res;
    }

    // =============================================================================
    // Vector binary helpers (byteOffset-safe)
    // =============================================================================

    private vectorToFloat32Buffer(data: number[]) {
        const scaledArray = data.map((value) => value * _floating_point_scale);
        const buffer = Buffer.alloc(scaledArray.length * Float32Array.BYTES_PER_ELEMENT);
        const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, scaledArray.length);
        scaledArray.forEach((value, index) => (float32Array[index] = value));
        return buffer;
    }

    private float32BufferToVector(buf: Buffer): number[] {
        const float32Array = new Float32Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength / Float32Array.BYTES_PER_ELEMENT
        );
        return Array.from(float32Array, (v) => v / _floating_point_scale);
    }
    async loadVectorBinaryOrJsonAsBase64(entityName: string, vectorId: string): Promise<string> {
        const bin = await this._storage.loadVectorBinary(entityName, vectorId);
        if (bin) return bin.toString("base64");

        const v = await this._storage.loadVector(entityName, vectorId);
        if (!v) return "";
        return this.vectorToFloat32Buffer(v).toString("base64");
    }

}

export default XDBEngine;
