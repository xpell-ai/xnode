import { XObject, _xlog, type XObjectData } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import { getXdbEngine } from "./xdbReady.js";

export type XDBNewFileIndex = {
  [fid: string]: any;
};

/**
 * XDBTemp — per-entity temporary store
 * - Maintains a temp CSV log (_temp_csv)
 * - Maintains temp JSON blobs in _temp folder
 * - Uses engine delegates (storage-agnostic)
 */
export class XDBTemp extends XObject {
  static _xtype = "xdb-temp";

  _new_file_index: XDBNewFileIndex = {};
  _need_commit = false;

  _need_save_ids: string[] = [];
  _need_delete_ids: string[] = [];

  _non_committed_ids: string[] = [];
  _non_deleted_ids: string[] = [];

  _xdb_entity_id!: string;
  _xdb_entity_name!: string;

  constructor(data: XObjectData) {
    data["_type"] = XDBTemp._xtype;
    super(data, {}, true);

    this.parse(data);

    this.addXporterDataIgnoreFields([]);
  }

  // -------------------- reads --------------------

  async getTempCsv(copy = false): Promise<string> {
    const engine = getXdbEngine();
    return await engine.loadTempCsv(this._xdb_entity_name, copy);
  }

  async getTempFile(fid: string): Promise<string> {
    const engine = getXdbEngine();
    return await engine.loadTempFile(this._xdb_entity_name, fid);
  }

  async getTempFiles(fids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const fid of fids) out.push(await this.getTempFile(fid));
    return out;
  }

  // -------------------- staging ops --------------------

  addTempFile(data: any, tid?: string): string {
    const id = tid ?? _xu.guid();
    this._new_file_index[id] = data;
    this._need_commit = true;
    this._need_save_ids.push(id);
    return id;
  }

  deleteTempFile(fid: string) {
    this._need_commit = true;
    this._need_delete_ids.push(fid);
  }

  deleteTempFiles(fids: string[]) {
    for (const fid of fids) this.deleteTempFile(fid);
  }

  // -------------------- csv utils --------------------

  /**
   * Copies temp csv to _temp_copy and clears _temp_csv
   */
  async copyTempCsv(): Promise<void> {
    const engine = getXdbEngine();
    await engine.copyTempCsv(this._xdb_entity_name);
    await engine.clearTempCsv(this._xdb_entity_name);
  }

  // -------------------- commit --------------------

  async commit(): Promise<void> {
    if (!this._need_commit) return;
    const engine = getXdbEngine();

    // save new staged temp files
    if (this._need_save_ids.length > 0) {
      const saveIds = this._need_save_ids;
      this._need_save_ids = [];

      let committed = 0;

      for (const fid of saveIds) {
        const payload = this._new_file_index[fid];
        if (payload === undefined) continue;

        try {
          await engine.saveTempFile(this._xdb_entity_name, fid, payload);
          delete this._new_file_index[fid];
          committed++;
        } catch (e: any) {
          this._non_committed_ids.push(fid);
          _xlog.error(`XDBTemp commit save failed fid=${fid} entity=${this._xdb_entity_name}: ${e?.message ?? e}`);
        }
      }

      // keep your old “quiet” behavior (don’t spam logs)
      if (this._non_committed_ids.length > 0) {
        _xlog.error(`XDBTemp failed to commit ${this._non_committed_ids.length} temp files (entity=${this._xdb_entity_name})`);
      }
    }

    // delete queued temp files
    if (this._need_delete_ids.length > 0) {
      const delIds = this._need_delete_ids;
      this._need_delete_ids = [];

      let deleted = 0;

      for (const fid of delIds) {
        try {
          await engine.deleteTempFile(this._xdb_entity_name, fid);
          deleted++;
        } catch (e: any) {
          this._non_deleted_ids.push(fid);
          _xlog.error(`XDBTemp delete failed fid=${fid} entity=${this._xdb_entity_name}: ${e?.message ?? e}`);
        }
      }

      if (this._non_deleted_ids.length > 0) {
        _xlog.error(`XDBTemp failed to delete ${this._non_deleted_ids.length} temp files (entity=${this._xdb_entity_name})`);
      }
    }

    this._need_commit = false;
  }

  // -------------------- append flow --------------------

  /**
   * Handles _temp_csv append operations AND stages/saves the corresponding temp file.
   * CSV format: "\n<timestamp>,<action>,<id>"
   */
  async appendTemp(action: "add" | "delete" | "update", id: string, data: any = {}): Promise<void> {
    const timestamp = Date.now();
    const engine = getXdbEngine();

    // keep your original behavior: stage the temp file for all operations
    switch (action) {
      case "add":
      case "delete":
      case "update":
        this.addTempFile(data, id);
        break;
      default:
        _xlog.error("XDBTemp.appendTemp(): Invalid action: " + action);
        return;
    }

    // commit staged temp file first (so csv doesn't reference a missing file)
    await this.commit();

    const line = `\n${timestamp},${action},${id}`;
    await engine.appendCsv(this._xdb_entity_name, line);
  }
}

export default XDBTemp;
