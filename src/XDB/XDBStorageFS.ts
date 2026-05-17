// XDBStorageFS.ts — Lean filesystem storage adapter for XDB
// - No zip/unzip/progress dependencies (production backup handled by SQLite storage)
// - Keeps legacy XDB folder layout for entities/vectors/files/temp/objects
// - Uses xpell-core imports

import path from "path";
import fs from "fs";

import { _xlog } from "@xpell/core";
import _xu from "../XNUtils/XUtils.js";
import type { IXDBStorage, XDBData, XDBEntityPersisted } from "./IXDBStorage.js";
import type { IXDBMaintenance } from "./IXDBMaintenance.js"; // optional (recommended)

const DEFAULT_XDB_FOLDER = "./data/xdb/";
const DEFAULT_XDB_DATA_FOLDER = "entities/";
const DEFAULT_XDB_CACHE_FOLDER = "cache/";
const DEFAULT_XDB_BACKUP_FOLDER = "backup/";
const DEFAULT_XDB_OBJECTS_FOLDER = "objects/";

const _xdb_file_extension = ".json";
const _xdb_file_bin_extension = ".data";
const _xdb_csv_file_extension = ".csv";
const _xdb_vectors_index_file = "_vindex" + _xdb_file_extension;

const _xdb_main_file = "aime" + _xdb_file_extension;

const _xdb_entity_files = {
    _meta: "_meta" + _xdb_file_extension,
    _schema: "_schema" + _xdb_file_extension,
    _data: "_data" + _xdb_file_extension,
    _vectors: "_vectors" + _xdb_file_extension,
    _entity_vectors_index: "_entity_vectors" + _xdb_file_extension,
    _indices: "_indices" + _xdb_file_extension,
    _entity_matrices_index: "_entity_matrices" + _xdb_file_extension,

    _entity_temp_csv: "_temp_csv" + _xdb_csv_file_extension,
    _entity_temp_copy: "_temp_copy" + _xdb_csv_file_extension,
};

const _xdb_data_security = {
    PLAIN_TEXT: "plain-text",
    BASE64_ENCODING: "base64",
} as const;

export type XDBStorageFSOptions = {
    xdbFolder?: string;      // ./data/xdb/
};

type XDBEntityFolder = {
    _main: string;
    _vectors: string;
    _files: string;
    _temp: string;
};

export class XDBStorageFS implements IXDBStorage, IXDBMaintenance {
    private _xdb_folder: string;
    private _data_folder: string;
    private _cache_folder: string;
    private _backup_folder: string;
    private _objects_folder: string;

    constructor(opts: XDBStorageFSOptions = {}) {

        this._xdb_folder =
            path.join(
                path.resolve(
                    opts.xdbFolder ??
                    DEFAULT_XDB_FOLDER
                ),
                path.sep
            );
        this._data_folder = this._xdb_folder + DEFAULT_XDB_DATA_FOLDER
        this._cache_folder = this._xdb_folder + DEFAULT_XDB_CACHE_FOLDER;
        this._backup_folder = this._xdb_folder + DEFAULT_XDB_BACKUP_FOLDER;
        this._objects_folder = this._xdb_folder + DEFAULT_XDB_OBJECTS_FOLDER;
    }

    // -------------------- lifecycle --------------------
    async open(): Promise<void> {
        _xu.checkFolders([
            this._xdb_folder,
            this._data_folder,
            this._cache_folder,
            this._backup_folder,
            this._objects_folder,
        ]);
    }

    async close(): Promise<void> {
        // no-op for filesystem
    }

    // -------------------- meta --------------------
    async loadXdbMeta(): Promise<Partial<XDBData> | null> {
        const xdbFile = this._xdb_folder + _xdb_main_file;
        if (!fs.existsSync(xdbFile)) return null;

        try {
            const ddata = fs.readFileSync(xdbFile, "utf8");
            const ddbo = JSON.parse(ddata);
            return {
                _engine: ddbo["_engine"],
                _security: ddbo["_security"],
                _number_of_cached_entities: ddbo["_number_of_cached_entities"],
                _entities: ddbo["_entities"],
                _last_commit: ddbo["_last_commit"],
            };
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadXdbMeta() error: " + e.message);
            return null;
        }
    }

    async saveXdbMeta(meta: XDBData): Promise<void> {
        const cdbFile = this._xdb_folder + _xdb_main_file;

        // preserve old behavior: store last_commit as ISO string
        const safe = {
            ...meta,
            _last_commit:
                meta._last_commit instanceof Date
                    ? meta._last_commit.toISOString()
                    : meta._last_commit,
        };

        fs.writeFileSync(cdbFile, JSON.stringify(safe));
    }

    async listEntities(): Promise<string[]> {
        const meta = await this.loadXdbMeta();
        return meta && Array.isArray(meta._entities) ? meta._entities : [];
    }

    private pj(...parts: string[]) {
        const jp = path.join(...parts);
        if (!jp.endsWith(path.sep)) return jp + path.sep;
        return jp;
    }

    // -------------------- entity folders/files --------------------
    private getEntityFolders(entityName: string): XDBEntityFolder {
        const entityFolder = this.pj(this._data_folder, entityName);
        const vectorsFolder = this.pj(entityFolder, "_vectors");
        const filesFolder = this.pj(entityFolder, "_files");
        const tempFolder = this.pj(entityFolder, "_temp");

        _xu.checkFolders([entityFolder, vectorsFolder, filesFolder, tempFolder]);

        return { _main: entityFolder, _vectors: vectorsFolder, _files: filesFolder, _temp: tempFolder };
    }

    private getEntityFiles(entityName: string) {
        const ef = this.getEntityFolders(entityName);
        return {
            _meta: ef._main + _xdb_entity_files._meta,
            _schema: ef._main + _xdb_entity_files._schema,
            _data: ef._main + _xdb_entity_files._data,
            _vectors: ef._main + _xdb_entity_files._vectors,
            _indices: ef._main + _xdb_entity_files._indices,
            _entity_vectors_index: ef._main + _xdb_entity_files._entity_vectors_index,
            _entity_matrices_index: ef._main + _xdb_entity_files._entity_matrices_index,

            _vector_folders: ef._vectors,
            _files_folder: ef._files,
            _temp_folder: ef._temp,
        };
    }

    private readJsonFileMaybe(fileName: string, securityMode: string): any | null {
        if (!fs.existsSync(fileName)) return null;

        try {
            let content = fs.readFileSync(fileName, "utf8");
            if (securityMode === _xdb_data_security.BASE64_ENCODING) {
                content = _xu.decode(content);
            }
            return JSON.parse(content);
        } catch (e: any) {
            _xlog.error(`XDBStorageFS.readJsonFileMaybe() error: ${e.message} file=${fileName}`);
            return null;
        }
    }

    private writeJsonFile(fileName: string, data: any, securityMode: string): void {
        let content = JSON.stringify(data);
        if (securityMode === _xdb_data_security.BASE64_ENCODING) {
            content = _xu.encode(content);
        }
        fs.writeFileSync(fileName, content);
    }

    // -------------------- entities --------------------
    async loadEntity(entityName: string): Promise<XDBEntityPersisted | null> {
        const meta = await this.loadXdbMeta();
        const securityMode = meta?._security ?? _xdb_data_security.PLAIN_TEXT;

        const files = this.getEntityFiles(entityName);
        const metaObj = this.readJsonFileMaybe(files._meta, securityMode);

        if (!metaObj || metaObj["_name"] !== entityName) return null;

        return {
            _meta: metaObj,
            _schema: this.readJsonFileMaybe(files._schema, securityMode),
            _data: this.readJsonFileMaybe(files._data, securityMode),
            _vectors: this.readJsonFileMaybe(files._vectors, securityMode),
            _indices: this.readJsonFileMaybe(files._indices, securityMode),
            _entity_vectors_index: this.readJsonFileMaybe(files._entity_vectors_index, securityMode),
            _entity_matrices_index: this.readJsonFileMaybe(files._entity_matrices_index, securityMode),
        };
    }

    async saveEntity(entityName: string, payload: XDBEntityPersisted, saveSchema: boolean): Promise<void> {
        const meta = await this.loadXdbMeta();
        const securityMode = meta?._security ?? _xdb_data_security.PLAIN_TEXT;

        const files = this.getEntityFiles(entityName);

        if (payload._meta !== undefined) this.writeJsonFile(files._meta, payload._meta, securityMode);
        if (saveSchema && payload._schema !== undefined) this.writeJsonFile(files._schema, payload._schema, securityMode);
        if (payload._data !== undefined) this.writeJsonFile(files._data, payload._data, securityMode);
        if (payload._vectors !== undefined) this.writeJsonFile(files._vectors, payload._vectors, securityMode);
        if (payload._indices !== undefined) this.writeJsonFile(files._indices, payload._indices, securityMode);
        if (payload._entity_vectors_index !== undefined) this.writeJsonFile(files._entity_vectors_index, payload._entity_vectors_index, securityMode);
        if (payload._entity_matrices_index !== undefined) this.writeJsonFile(files._entity_matrices_index, payload._entity_matrices_index, securityMode);
    }

    // -------------------- object store --------------------
    async saveObject(objectName: string, value: string | object): Promise<void> {
        const objectFile = this._objects_folder + objectName + _xdb_file_extension;
        if (typeof value === "string") fs.writeFileSync(objectFile, value);
        else fs.writeFileSync(objectFile, JSON.stringify(value));
    }

    async loadObject(objectName: string): Promise<string | null> {
        const objectFile = this._objects_folder + objectName + _xdb_file_extension;
        if (!fs.existsSync(objectFile)) return null;
        try {
            return fs.readFileSync(objectFile, "utf8");
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadObject() error: " + e.message);
            return null;
        }
    }

    async hasObject(objectName: string): Promise<boolean> {
        const objectFile = this._objects_folder + objectName + _xdb_file_extension;
        return fs.existsSync(objectFile);
    }

    // -------------------- vectors --------------------
    async saveVector(entityName: string, vectorId: string, vector: number[]): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const vectorFile = files._vector_folders + vectorId + _xdb_file_extension;
        fs.writeFileSync(vectorFile, JSON.stringify(vector));
    }

    async deleteVector(entityName: string, vectorId: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const jsonFile = files._vector_folders + vectorId + _xdb_file_extension;
        const binFile = files._vector_folders + vectorId + _xdb_file_bin_extension;

        if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile);
        if (fs.existsSync(binFile)) fs.unlinkSync(binFile);
    }

    async loadVector(entityName: string, vectorId: string): Promise<number[] | null> {
        const files = this.getEntityFiles(entityName);
        const vectorFile = files._vector_folders + vectorId + _xdb_file_extension;
        if (!fs.existsSync(vectorFile)) return null;

        try {
            return JSON.parse(fs.readFileSync(vectorFile, "utf8"));
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadVector() error: " + e.message);
            return null;
        }
    }

    async saveVectorBinary(entityName: string, vectorId: string, buffer: Buffer): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const binFile = files._vector_folders + vectorId + _xdb_file_bin_extension;
        const out = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        fs.writeFileSync(binFile, out);
    }

    async loadVectorBinary(entityName: string, vectorId: string): Promise<Buffer | null> {
        const files = this.getEntityFiles(entityName);
        const binFile = files._vector_folders + vectorId + _xdb_file_bin_extension;
        if (!fs.existsSync(binFile)) return null;

        try {
            return fs.readFileSync(binFile);
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadVectorBinary() error: " + e.message);
            return null;
        }
    }

    async loadVectorAsBase64(entityName: string, vectorId: string): Promise<string> {
        // 1) prefer binary
        const buf = await this.loadVectorBinary(entityName, vectorId);
        if (buf) return buf.toString("base64");

        // 2) fallback to json vector -> float32 buffer -> base64
        const v = await this.loadVector(entityName, vectorId);
        if (!v) return "";

        // replicate engine scaling logic OR (better) add a "vectorToFloat32Buffer" helper in storage
        // simplest: store json as utf8 base64 (not ideal for MAT, but works for transport)
        // If you want MAT-compatible b64, do the float32 conversion here.
        const json = Buffer.from(JSON.stringify(v), "utf8");
        return json.toString("base64");
    }

    async saveVectorIndex(entityName: string, index: any): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const idxFile = files._vector_folders + _xdb_vectors_index_file;
        fs.writeFileSync(idxFile, JSON.stringify(index));
    }

    async loadVectorIndex(entityName: string): Promise<any | null> {
        const files = this.getEntityFiles(entityName);
        const idxFile = files._vector_folders + _xdb_vectors_index_file;
        if (!fs.existsSync(idxFile)) return null;

        try {
            return JSON.parse(fs.readFileSync(idxFile, "utf8"));
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadVectorIndex() error: " + e.message);
            return null;
        }
    }

    // -------------------- entity files (_files) --------------------
    async saveFile(entityName: string, fileId: string, data: any): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._files_folder + fileId + _xdb_file_extension;
        fs.writeFileSync(file, JSON.stringify(data));
    }

    async deleteFile(entityName: string, fileId: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._files_folder + fileId + _xdb_file_extension;
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    async loadFile(entityName: string, fileId: string): Promise<string | null> {
        const files = this.getEntityFiles(entityName);
        const file = files._files_folder + fileId + _xdb_file_extension;
        if (!fs.existsSync(file)) return null;

        try {
            return fs.readFileSync(file, "utf8");
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadFile() error: " + e.message);
            return null;
        }
    }

    // -------------------- temp (_temp) --------------------
    async loadTempCsv(entityName: string, copy: boolean = false): Promise<string | null> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + (copy ? _xdb_entity_files._entity_temp_copy : _xdb_entity_files._entity_temp_csv);
        if (!fs.existsSync(file)) return null;

        try {
            return fs.readFileSync(file, "utf8");
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadTempCsv() error: " + e.message);
            return null;
        }
    }

    async appendCsv(entityName: string, data: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + _xdb_entity_files._entity_temp_csv;

        const line = data.endsWith("\n") ? data : (data + "\n");
        fs.appendFileSync(file, line);
    }


    async clearTempCsv(entityName: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + _xdb_entity_files._entity_temp_csv;
        fs.writeFileSync(file, "");
    }

    async copyTempCsv(entityName: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const src = files._temp_folder + _xdb_entity_files._entity_temp_csv;
        const dst = files._temp_folder + _xdb_entity_files._entity_temp_copy;
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }

    async saveTempFile(entityName: string, fid: string, data: any): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + fid + _xdb_file_extension;
        fs.writeFileSync(file, JSON.stringify(data));
    }

    async loadTempFile(entityName: string, fid: string): Promise<string | null> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + fid + _xdb_file_extension;
        if (!fs.existsSync(file)) return null;

        try {
            return fs.readFileSync(file, "utf8");
        } catch (e: any) {
            _xlog.error("XDBStorageFS.loadTempFile() error: " + e.message);
            return null;
        }
    }

    async deleteTempFile(entityName: string, fid: string): Promise<void> {
        const files = this.getEntityFiles(entityName);
        const file = files._temp_folder + fid + _xdb_file_extension;
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    async getAllTempFileNames(entityName: string): Promise<string[]> {
        const files = this.getEntityFiles(entityName);
        if (!fs.existsSync(files._temp_folder)) return [];
        return fs
            .readdirSync(files._temp_folder)
            .filter((f) => f !== _xdb_entity_files._entity_temp_csv && f !== _xdb_entity_files._entity_temp_copy);
    }


    // -------------------- maintenance (optional) --------------------
    async ensureFolder(folderPath: string): Promise<void> {
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    }

    async deleteFolder(folderPath: string): Promise<void> {
        if (!fs.existsSync(folderPath)) return;
        // ✅ modern + safe
        fs.rmSync(folderPath, { recursive: true, force: true });
    }

    async copyFolder(source: string, destination: string): Promise<void> {
        const copyRecursive = (src: string, dst: string) => {
            if (!fs.existsSync(src)) return;
            const st = fs.statSync(src);

            if (st.isDirectory()) {
                if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
                for (const name of fs.readdirSync(src)) {
                    copyRecursive(path.join(src, name), path.join(dst, name));
                }
            } else {
                // ensure parent exists
                const parent = path.dirname(dst);
                if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
                fs.copyFileSync(src, dst);
            }
        };

        copyRecursive(source, destination);
    }

    /**
     * Minimal zip/unzip impl (no deps) is NOT great.
     * If you truly want zip, use a small dependency like "archiver" / "adm-zip".
     *
     * For now: implement as explicit errors OR wire a dependency.
     */
    async zipFolder(_folderPath: string): Promise<void> {
        throw new Error("XDBStorageFS.zipFolder(): not implemented (use SQLite backup or add an archiver dependency)");
    }

    async unzip(_zipFilePath: string, _destination: string = ""): Promise<void> {
        throw new Error("XDBStorageFS.unzip(): not implemented (use SQLite backup or add an unzip dependency)");
    }

}

export default XDBStorageFS;
