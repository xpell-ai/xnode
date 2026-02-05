/**
 * XDBCache.ts — XDB Cache Manager (storage-agnostic version)
 *
 * ✅ Removes direct FS coupling from callers (still uses FS internally by default).
 * ✅ Keeps your “Cache 2.0” behavior: each key -> sha256(key).json on disk.
 * ✅ LRU stored in lru.json
 * ✅ No “cache.json” index usage (legacy kept only for optional upgrade path)
 *
 * Notes:
 * - This file is still FS-based. If you want cache to be truly storage-agnostic,
 *   we can add an IXDBCacheStorage later (same pattern as IXDBStorage).
 */

import fs from "fs";
import crypto from "crypto";

import {  _xlog } from "@xpell/core";
import _xu from "../XNUtils/XUtils.js";
const DEFAULT_CACHE_FOLDER = "./data/xdb/cache/";

const JSON_EXT = ".json";
const LRU_FILE = "lru" + JSON_EXT;

// legacy (deprecated)
const LEGACY_CACHE_FILE = "cache" + JSON_EXT;

const CACHE_CLEAN_INTERVAL_MS = 1000 * 60; // 1 minute

export type XDBCacheIndexItem = {
  _d: any; // data
  _c: number; // created
  _l: number; // last used (legacy)
  _h: number; // hits (legacy)
};

export type XDBCacheIndex = {
  [key: string]: XDBCacheIndexItem;
};

export type XDBCacheOptions = {
  cacheFolder?: string;
};

export class XDBCache {
  _cache_folder: string;

  /** legacy (deprecated) */
  _cache_index: XDBCacheIndex = {};

  _initialized = false;
  _last_clean = 0;
  _need_save = false;

  /** LRU in Cache 2.0: hashedKey -> hits */
  _lru: { [hashedKey: string]: number } = {};

  constructor(opts: XDBCacheOptions = {}) {
    this._cache_folder = opts.cacheFolder ?? DEFAULT_CACHE_FOLDER;
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    _xu.checkFolders([this._cache_folder]);
    await this.loadCache();
    this._initialized = true;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** hash cache key to safe filename */
  hashKey(key: string) {
    const hash = crypto.createHash("sha256");
    hash.update(String(key));
    return hash.digest("hex");
  }

  private fileForHashedKey(hashedKey: string) {
    return this._cache_folder + hashedKey + JSON_EXT;
  }

  private fileForKey(key: string) {
    return this.fileForHashedKey(this.hashKey(key));
  }

  private readJsonMaybe(file: string): any | null {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e: any) {
      _xlog.error(`XDBCache.readJsonMaybe() error: ${e?.message ?? e} file=${file}`);
      return null;
    }
  }

  private writeJson(file: string, data: any) {
    try {
      fs.writeFileSync(file, JSON.stringify(data));
      return true;
    } catch (e: any) {
      _xlog.error(`XDBCache.writeJson() error: ${e?.message ?? e} file=${file}`);
      return false;
    }
  }

  private bumpLRU(hashedKey: string) {
    if (!this._lru[hashedKey]) this._lru[hashedKey] = 0;
    this._lru[hashedKey] += 1;
    this._need_save = true;
  }

  // ---------------------------------------------------------------------------
  // Cache 2.0 (recommended)
  // ---------------------------------------------------------------------------

  /**
   * Reads a cached object by key.
   * Stored as: sha256(key).json
   */
  get(key: string) {
    const h = this.hashKey(key);
    const file = this.fileForHashedKey(h);

    const d = this.readJsonMaybe(file);
    if (d === null) return null;

    this.bumpLRU(h);
    return d;
  }

  /**
   * Writes a cached object by key.
   * Stored as: sha256(key).json
   */
  set(key: string, data: any) {
    const h = this.hashKey(key);
    const file = this.fileForHashedKey(h);

    const ok = this.writeJson(file, data);
    if (ok) this.bumpLRU(h);
    return ok;
  }

  /**
   * Deletes a cached object by key (and removes its LRU entry).
   */
  del(key: string) {
    const h = this.hashKey(key);
    const file = this.fileForHashedKey(h);

    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e: any) {
      _xlog.error(`XDBCache.del() unlink error: ${e?.message ?? e}`);
      return false;
    }

    if (this._lru[h] !== undefined) {
      delete this._lru[h];
      this._need_save = true;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Backward compatibility with your existing naming
  // ---------------------------------------------------------------------------

  /** Back-compat: old name */
  getVectors(key: string) {
    return this.get(key);
  }

  /** Back-compat: old name */
  cacheVectors(key: string, data: any) {
    return this.set(key, data);
  }

  // ---------------------------------------------------------------------------
  // legacy cache v1 (deprecated)
  // ---------------------------------------------------------------------------

  /** @deprecated */
  checkCacheInput(data: any) {
    if (typeof data === "string") data = data.trim().toLowerCase();
    return data;
  }

  /** @deprecated */
  getCacheData(key: string) {
    key = this.checkCacheInput(key);
    const item = this._cache_index[key];
    if (item) {
      item._h++;
      item._l = Date.now();
      return item._d;
    }
    return null;
  }

  /** @deprecated */
  cacheData(key: string, data: any, autoSave = true) {
    key = this.checkCacheInput(key);
    this._cache_index[key] = {
      _c: Date.now(),
      _d: data,
      _h: 0,
      _l: 0,
    };
    this._need_save = true;
    if (autoSave) this.saveLRUData();
  }

  /**
   * Optional migration helper:
   * - takes legacy in-memory cache index
   * - dumps each item to Cache 2.0 files
   * - records LRU hits
   * - clears legacy map
   */
  upgradeCache() {
    const keys = Object.keys(this._cache_index);
    for (const key of keys) {
      const item = this._cache_index[key];
      // persist in Cache 2.0
      this.set(key, item._d);
      // record LRU using legacy hits
      const hk = this.hashKey(key);
      this._lru[hk] = (this._lru[hk] ?? 0) + (item._h ?? 0);
      delete this._cache_index[key];
    }

    // keep legacy file compatible (write empty object)
    const legacyFile = this._cache_folder + LEGACY_CACHE_FILE;
    this.writeJson(legacyFile, this._cache_index);

    this._need_save = true;
    this.saveLRUData();

    _xlog.log(`XDB Cache upgraded (${keys.length} items)`);
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  saveLRUData() {
    const file = this._cache_folder + LRU_FILE;
    const ok = this.writeJson(file, this._lru);
    if (ok) this._need_save = false;
  }

  /**
   * Legacy wrapper: now only persists LRU (cache index is deprecated)
   */
  saveCache() {
    this.saveLRUData();
  }

  async loadCache() {
    // legacy cache index (optional)
    const legacyFile = this._cache_folder + LEGACY_CACHE_FILE;
    if (fs.existsSync(legacyFile)) {
      const d = this.readJsonMaybe(legacyFile);
      if (d && typeof d === "object") {
        this._cache_index = d as XDBCacheIndex;
        _xlog.log(`XDB Cache legacy loaded (${Object.keys(this._cache_index).length} items)`);
      }
    } else {
      _xlog.log("No legacy cache file found");
    }

    // LRU
    const lruFile = this._cache_folder + LRU_FILE;
    if (fs.existsSync(lruFile)) {
      const d = this.readJsonMaybe(lruFile);
      if (d && typeof d === "object") {
        this._lru = d as any;
        _xlog.log(`XDB LRU loaded (${Object.keys(this._lru).length} items)`);
      }
    } else {
      _xlog.log("No LRU file found");
    }
  }

  // ---------------------------------------------------------------------------
  // tick
  // ---------------------------------------------------------------------------

  async onFrame(_frameNumber: number) {
    const fromLast = Date.now() - this._last_clean;

    if (fromLast > CACHE_CLEAN_INTERVAL_MS) {
      this._last_clean = Date.now();

      if (this._need_save) {
        this.saveCache();
      }
    }
  }
}

export default XDBCache;
