import { XObject, _xlog, type XObjectData } from "xpell-core";
import _xu from "../XNUtils/XUtils.js";
import { getXdbEngine } from "./xdbReady.js";

export type XDBVectorsMatrix = Array<number[]>;

export type XDBVectorsIndex = {
  [vid: string]: { _s: number; _c: number; _u: number; _l: number; _h?: number };
};

export type XDBNewVectorsIndex = { [vid: string]: number[] };

export class XDBVector extends XObject {
  static _xtype = "xdb-vector";

  _vectors_index: XDBVectorsIndex = {};
  _new_vector_index: XDBNewVectorsIndex = {};

  _need_commit = false;
  private _index_dirty = false;
  private _committing = false;

  _need_save_ids: string[] = [];
  _need_delete_ids: string[] = [];

  _non_committed_ids: string[] = [];
  _non_deleted_ids: string[] = [];

  _xdb_entity_id!: string;
  _xdb_entity_name!: string;

  constructor(data: XObjectData) {
    data["_type"] = XDBVector._xtype;
    super(data, {}, true);

    this.parse(data);

    this.addXporterDataIgnoreFields([]);
  }

  private touchLoad(vid: string) {
    const v = this._vectors_index[vid];
    if (!v) return;

    v._l = (v._l ?? 0) + 1;
    v._u = Date.now();

    this._need_commit = true;
    this._index_dirty = true;
  }

  async loadVectorsIndex(): Promise<number> {
    const engine = getXdbEngine();
    const idx = await engine.loadVectorIndex(this._xdb_entity_name);
    if (idx && typeof idx === "object") {
      this._vectors_index = idx as XDBVectorsIndex;
    } else {
      this._vectors_index = {};
      this._need_commit = true;
      this._index_dirty = true;
      await this.commit();
    }
    return Object.keys(this._vectors_index).length;
  }

  async getVector(vid: string): Promise<number[] | null> {
    const engine = getXdbEngine();
    const vec = await engine.loadVector(this._xdb_entity_name, vid);

    // treat as missing only if it’s empty AND not present in index
    if (!vec || (vec.length === 0 && !this._vectors_index[vid])) {
      _xlog.error(`XDBVector.getVector() missing vid=${vid} entity=${this._xdb_entity_name}`);
      return null;
    }

    this.touchLoad(vid);
    return vec;
  }

  async getBase64Vector(vid: string): Promise<string> {
    const engine = getXdbEngine();
    const b64 = await engine.loadVectorAsBase64(this._xdb_entity_name, vid);
    if (!b64) {
      _xlog.error(`XDBVector.getBase64Vector() failed vid=${vid} entity=${this._xdb_entity_name}`);
      return "";
    }
    this.touchLoad(vid);
    return b64;
  }

  async getVectors(vids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const vid of vids) {
      const b64 = await this.getBase64Vector(vid);
      if (b64 !== "") out.push(b64);
    }
    return out;
  }

  addVector(vector: number[]): string {
    const vid = _xu.guid();

    this._new_vector_index[vid] = vector;
    this._vectors_index[vid] = { _s: vector.length, _c: Date.now(), _u: Date.now(), _l: 0 };

    this._need_commit = true;
    this._index_dirty = true;
    this._need_save_ids.push(vid);

    return vid;
  }

  deleteVector(vid: string) {
    if (!vid) return;

    if (this._vectors_index[vid]) {
      delete this._vectors_index[vid];
      this._need_commit = true;
      this._index_dirty = true;
      this._need_delete_ids.push(vid);
    }

    // if it was queued for save, remove it from staged new vectors too
    if (this._new_vector_index[vid]) {
      delete this._new_vector_index[vid];
    }
  }

  deleteVectors(vids: string[]) {
    if (!Array.isArray(vids)) vids = [vids];
    for (const vid of vids) this.deleteVector(vid);
  }

  addVectorMatrix(matrix: XDBVectorsMatrix): string[] {
    const vids: string[] = [];
    for (const vector of matrix) vids.push(this.addVector(vector));
    return vids;
  }

  async commit(): Promise<void> {
    if (!this._need_commit) return;
    if (this._committing) return;

    this._committing = true;
    const engine = getXdbEngine();

    // reset per-commit error lists (prevents unbounded growth)
    this._non_committed_ids = [];
    this._non_deleted_ids = [];

    try {
      // ---- save pending vectors ----
      if (this._need_save_ids.length > 0) {
        const saveIds = this._need_save_ids;
        this._need_save_ids = [];

        let committed = 0;

        for (const vid of saveIds) {
          const vec = this._new_vector_index[vid];
          if (!vec) continue;

          try {
            await engine.saveVector(this._xdb_entity_name, vid, vec);
            delete this._new_vector_index[vid];
            committed++;
          } catch (e: any) {
            this._non_committed_ids.push(vid);
            _xlog.error(`XDBVector commit save failed entity=${this._xdb_entity_name} vid=${vid}: ${e?.message ?? e}`);
          }
        }

        if (committed) _xlog.log(`XDBVector committed ${committed} vectors (entity=${this._xdb_entity_name})`);
        if (this._non_committed_ids.length) {
          _xlog.error(`XDBVector failed to commit ${this._non_committed_ids.length} vectors (entity=${this._xdb_entity_name})`);
        }
      }

      // ---- delete queued vectors ----
      if (this._need_delete_ids.length > 0) {
        const delIds = this._need_delete_ids;
        this._need_delete_ids = [];

        let deleted = 0;

        for (const vid of delIds) {
          try {
            await engine.deleteVector(this._xdb_entity_name, vid);
            deleted++;
          } catch (e: any) {
            this._non_deleted_ids.push(vid);
            _xlog.error(`XDBVector delete failed entity=${this._xdb_entity_name} vid=${vid}: ${e?.message ?? e}`);
          }
        }

        if (deleted) _xlog.log(`XDBVector deleted ${deleted} vectors (entity=${this._xdb_entity_name})`);
        if (this._non_deleted_ids.length) {
          _xlog.error(`XDBVector failed to delete ${this._non_deleted_ids.length} vectors (entity=${this._xdb_entity_name})`);
        }
      }

      // ---- persist index only if changed ----
      if (this._index_dirty) {
        await engine.saveVectorIndex(this._xdb_entity_name, this._vectors_index);
        this._index_dirty = false;
      }

      this._need_commit = false;
    } finally {
      this._committing = false;
    }
  }
}

export default XDBVector;
