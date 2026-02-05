// XDBStorageSqlite.ts — SQLite storage adapter for XDB (production persistence)
// - Uses better-sqlite3 (sync, in-process, fast)
// - Stores meta/entities/docs/objects in SQLite
// - Delegates vectors/files/temp to a blob storage (default: XDBStorageFS)

import path from "path";
import fs from "fs";

import Database from "better-sqlite3";
import {  _xlog } from "@xpell/core";
import _xu from "../XNUtils/XUtils.js";
import type { IXDBStorage, XDBData, XDBEntityPersisted } from "./IXDBStorage.js";
import { XDBStorageFS } from "./XDBStorageFS.js";
import { IXDBBackup } from "./IXDBMaintenance.js";

export type XDBStorageSqliteOptions = {
  dbPath?: string;              // e.g. ./data/xdb/xdb.sqlite
  wal?: boolean;                // default true
  busyTimeoutMs?: number;       // default 5000

  // optional: keep blobs in filesystem via another storage adapter
  blobStorage?: IXDBStorage;    // default: new XDBStorageFS()
};

type Stmts = {
  // meta
  metaGet: Database.Statement;
  metaSet: Database.Statement;

  // entities
  entityUpsert: Database.Statement;
  entityList: Database.Statement;

  // entity docs
  docGet: Database.Statement;
  docUpsert: Database.Statement;

  // objects
  objUpsert: Database.Statement;
  objGet: Database.Statement;
  objHas: Database.Statement;
};

const DOC_TYPES: Array<keyof XDBEntityPersisted> = [
  "_meta",
  "_schema",
  "_data",
  "_vectors",
  "_entity_vectors_index",
  "_entity_matrices_index",
  "_indices",
];

// Helpers
const nowIso = () => new Date().toISOString();

export class XDBStorageSqlite implements IXDBStorage,IXDBBackup {
  private _dbPath: string;
  private _db!: Database.Database;
  private _stmts!: Stmts;

  // delegate for blob-y things (vectors/files/temp)
  private _blob: IXDBStorage;

  private _wal: boolean;
  private _busyTimeoutMs: number;

  constructor(opts: XDBStorageSqliteOptions = {}) {
    this._dbPath = opts.dbPath ?? "./data/xdb/xdb.sqlite";
    this._wal = opts.wal ?? true;
    this._busyTimeoutMs = opts.busyTimeoutMs ?? 5000;

    this._blob = opts.blobStorage ?? new XDBStorageFS();
  }

  // -------------------- lifecycle --------------------
  async open(): Promise<void> {
    // ensure parent folder exists
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this._db = new Database(this._dbPath);

    // pragmas (production defaults)
    this._db.pragma("foreign_keys = ON");
    this._db.pragma(`busy_timeout = ${this._busyTimeoutMs}`);
    if (this._wal) {
      this._db.pragma("journal_mode = WAL");
      // NORMAL is common for WAL: good perf, still safe (committed txns durable)
      this._db.pragma("synchronous = NORMAL");
    } else {
      // classic journal mode fallback
      this._db.pragma("journal_mode = DELETE");
      this._db.pragma("synchronous = FULL");
    }

    this._initSchema();
    this._prepareStatements();

    this._ensureEngineInitialized();

    // open blob delegate too (FS folders, etc.)
    await this._blob.open();
  }

  async close(): Promise<void> {
    try {
      await this._blob.close();
    } finally {
      if (this._db) this._db.close();
    }
  }

  private _ensureEngineInitialized(): void {
    const engine = this._metaGet("engine_id");
    if (engine) return; // already initialized

    const engineId = _xu.guid();
    const ts = new Date().toISOString();

    this._metaSet("engine_id", engineId);
    this._metaSet("security", "plain-text");
    this._metaSet("number_of_cached_entities", "0");
    this._metaSet("entities", "[]");
    this._metaSet("last_commit", ts);

    _xlog.log("XDBStorageSqlite: initialized new XDB meta", engineId);
  }

  // -------------------- schema --------------------
  private _initSchema(): void {
    // minimal schema:
    // - xdb_meta: key/value
    // - xdb_entities: entity list
    // - xdb_entity_docs: per-entity docs like _meta/_schema/_data/...
    // - xdb_objects: object store

    const sql = `
      CREATE TABLE IF NOT EXISTS xdb_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xdb_entities (
        name       TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xdb_entity_docs (
        entity     TEXT NOT NULL,
        doc_type   TEXT NOT NULL,
        doc_json   TEXT NOT NULL,
        updated_at TEXT NOT NULL,

        PRIMARY KEY (entity, doc_type),
        FOREIGN KEY (entity) REFERENCES xdb_entities(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS xdb_objects (
        name       TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;
    this._db.exec(sql);
  }

  private _prepareStatements(): void {
    this._stmts = {
      // meta
      metaGet: this._db.prepare(`SELECT value FROM xdb_meta WHERE key = ?`),
      metaSet: this._db.prepare(`INSERT INTO xdb_meta(key, value) VALUES(?, ?)
                                 ON CONFLICT(key) DO UPDATE SET value=excluded.value`),

      // entities
      entityUpsert: this._db.prepare(`INSERT INTO xdb_entities(name, updated_at) VALUES(?, ?)
                                      ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at`),
      entityList: this._db.prepare(`SELECT name FROM xdb_entities ORDER BY name ASC`),

      // docs
      docGet: this._db.prepare(`SELECT doc_json FROM xdb_entity_docs WHERE entity = ? AND doc_type = ?`),
      docUpsert: this._db.prepare(`INSERT INTO xdb_entity_docs(entity, doc_type, doc_json, updated_at)
                                   VALUES(?, ?, ?, ?)
                                   ON CONFLICT(entity, doc_type) DO UPDATE
                                   SET doc_json=excluded.doc_json, updated_at=excluded.updated_at`),

      // objects
      objUpsert: this._db.prepare(`INSERT INTO xdb_objects(name, value, updated_at) VALUES(?, ?, ?)
                                   ON CONFLICT(name) DO UPDATE
                                   SET value=excluded.value, updated_at=excluded.updated_at`),
      objGet: this._db.prepare(`SELECT value FROM xdb_objects WHERE name = ?`),
      objHas: this._db.prepare(`SELECT 1 as one FROM xdb_objects WHERE name = ?`),
    };
  }

  // -------------------- meta helpers --------------------
  private _metaGet(key: string): string | null {
    const row = this._stmts.metaGet.get(key) as any;
    return row?.value ?? null;
  }

  private _metaSet(key: string, value: any): void {
    this._stmts.metaSet.run(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  // -------------------- IXDBStorage: meta --------------------
  async loadXdbMeta(): Promise<Partial<XDBData> | null> {
    // store meta keys individually (easier evolution)
    const engine = this._metaGet("engine_id");
    if (!engine) return null;

    const security = this._metaGet("security") ?? "plain-text";
    const nceStr = this._metaGet("number_of_cached_entities") ?? "0";
    const entitiesJson = this._metaGet("entities") ?? "[]";
    const lastCommit = this._metaGet("last_commit") ?? undefined;

    let entities: string[] = [];
    try {
      entities = JSON.parse(entitiesJson);
    } catch {
      entities = [];
    }

    return {
      _engine: engine,
      _security: security,
      _number_of_cached_entities: Number(nceStr) || 0,
      _entities: entities,
      _last_commit: lastCommit,
    };
  }

  async saveXdbMeta(meta: XDBData): Promise<void> {
    // ensure engine id exists
    const engineId = meta._engine || _xu.guid();

    // keep entities in sync with xdb_entities table (optional but nice)
    const entities = Array.isArray(meta._entities) ? meta._entities : [];

    // write meta
    this._metaSet("engine_id", engineId);
    this._metaSet("security", meta._security ?? "plain-text");
    this._metaSet("number_of_cached_entities", String(meta._number_of_cached_entities ?? entities.length));
    this._metaSet("entities", JSON.stringify(entities));
    this._metaSet(
      "last_commit",
      meta._last_commit instanceof Date ? meta._last_commit.toISOString() : meta._last_commit ?? nowIso()
    );

    // update entities table too (best effort)
    const ts = nowIso();
    const tx = this._db.transaction(() => {
      for (const e of entities) this._stmts.entityUpsert.run(e, ts);
    });
    tx();
  }

  // -------------------- IXDBStorage: entities --------------------
  async listEntities(): Promise<string[]> {
    const rows = this._stmts.entityList.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async loadEntity(entityName: string): Promise<XDBEntityPersisted | null> {
    // if entity doesn't exist, return null
    // (we check xdb_entities table)
    // cheap check: just attempt to load _meta doc
    const metaJson = this._stmts.docGet.get(entityName, "_meta") as any;
    if (!metaJson?.doc_json) return null;

    const out: XDBEntityPersisted = {};
    for (const docType of DOC_TYPES) {
      const row = this._stmts.docGet.get(entityName, docType) as any;
      if (row?.doc_json) {
        try {
          (out as any)[docType] = JSON.parse(row.doc_json);
        } catch {
          (out as any)[docType] = null;
        }
      }
    }
    return out;
  }

  async saveEntity(entityName: string, payload: XDBEntityPersisted, saveSchema: boolean): Promise<void> {
    const ts = nowIso();

    const tx = this._db.transaction(() => {
      // upsert entity header
      this._stmts.entityUpsert.run(entityName, ts);

      // upsert docs
      for (const docType of DOC_TYPES) {
        if (docType === "_schema" && !saveSchema) continue;

        const val = (payload as any)[docType];
        if (val === undefined) continue;

        this._stmts.docUpsert.run(entityName, docType, JSON.stringify(val), ts);
      }
    });

    tx();
  }

  // -------------------- IXDBStorage: objects --------------------
  async saveObject(objectName: string, value: string | object): Promise<void> {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    this._stmts.objUpsert.run(objectName, v, nowIso());
  }

  async loadObject(objectName: string): Promise<string | null> {
    const row = this._stmts.objGet.get(objectName) as any;
    return row?.value ?? null;
  }

  async hasObject(objectName: string): Promise<boolean> {
    const row = this._stmts.objHas.get(objectName) as any;
    return !!row;
  }

  // -------------------- Delegated blob methods (vectors/files/temp) --------------------
  // v1: keep these on filesystem via XDBStorageFS (or any other blob adapter)

  async saveVector(entityName: string, vectorId: string, vector: number[]): Promise<void> {
    return this._blob.saveVector(entityName, vectorId, vector);
  }
  async deleteVector(entityName: string, vectorId: string): Promise<void> {
    return this._blob.deleteVector(entityName, vectorId);
  }
  async loadVector(entityName: string, vectorId: string): Promise<number[] | null> {
    return this._blob.loadVector(entityName, vectorId);
  }

  async saveVectorBinary(entityName: string, vectorId: string, buffer: Buffer): Promise<void> {
    return this._blob.saveVectorBinary(entityName, vectorId, buffer);
  }
  async loadVectorBinary(entityName: string, vectorId: string): Promise<Buffer | null> {
    return this._blob.loadVectorBinary(entityName, vectorId);
  }
  async loadVectorAsBase64(entityName: string, vectorId: string): Promise<string> {
    return this._blob.loadVectorAsBase64(entityName, vectorId);
  }

  async saveVectorIndex(entityName: string, index: any): Promise<void> {
    return this._blob.saveVectorIndex(entityName, index);
  }
  async loadVectorIndex(entityName: string): Promise<any | null> {
    return this._blob.loadVectorIndex(entityName);
  }

  async saveFile(entityName: string, fileId: string, data: any): Promise<void> {
    return this._blob.saveFile(entityName, fileId, data);
  }
  async deleteFile(entityName: string, fileId: string): Promise<void> {
    return this._blob.deleteFile(entityName, fileId);
  }
  async loadFile(entityName: string, fileId: string): Promise<string | null> {
    return this._blob.loadFile(entityName, fileId);
  }

  async loadTempCsv(entityName: string, copy?: boolean): Promise<string | null> {
    return this._blob.loadTempCsv(entityName, copy);
  }
  async appendCsv(entityName: string, data: string): Promise<void> {
    return this._blob.appendCsv(entityName, data);
  }
  async clearTempCsv(entityName: string): Promise<void> {
    return this._blob.clearTempCsv(entityName);
  }
  async copyTempCsv(entityName: string): Promise<void> {
    return this._blob.copyTempCsv(entityName);
  }

  async saveTempFile(entityName: string, fid: string, data: any): Promise<void> {
    return this._blob.saveTempFile(entityName, fid, data);
  }
  async loadTempFile(entityName: string, fid: string): Promise<string | null> {
    return this._blob.loadTempFile(entityName, fid);
  }
  async deleteTempFile(entityName: string, fid: string): Promise<void> {
    return this._blob.deleteTempFile(entityName, fid);
  }
  async getAllTempFileNames(entityName: string): Promise<string[]> {
    return this._blob.getAllTempFileNames(entityName);
  }

  async backup(destinationPath: string): Promise<void> {
    // ensure folder exists
    const dir = path.dirname(destinationPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // VACUUM INTO writes a consistent snapshot to a new db file
    // NOTE: destinationPath must be quoted safely; simplest is to use parameter binding
    // but VACUUM INTO doesn't support bind params in many wrappers, so escape single quotes:
    const safe = destinationPath.replace(/'/g, "''");
    this._db.exec(`VACUUM INTO '${safe}'`);
    _xlog.log("XDBStorageSqlite: backup created", destinationPath);
  }

  async restore(sourcePath: string): Promise<void> {
    // restore is: close -> replace db file -> reopen
    // (keep it simple & reliable)
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`restore source does not exist: ${sourcePath}`);
    }

    await this.close();

    // replace db file
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourcePath, this._dbPath);

    // also remove WAL/SHM to avoid mismatched state
    const wal = this._dbPath + "-wal";
    const shm = this._dbPath + "-shm";
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);

    await this.open();
    _xlog.log("XDBStorageSqlite: restored from", sourcePath);
  }

}

export default XDBStorageSqlite;
