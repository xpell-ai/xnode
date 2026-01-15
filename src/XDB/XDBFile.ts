import { XUtils, XObject, _xlog, type XObjectData } from "xpell-core";
import { getXdbEngine } from "./xdbReady.js";

export type XDBNewFileIndex = {
    [fid: string]: any;
};

export class XDBFile extends XObject {
    static _xtype = "xdb-file";

    _new_file_index: XDBNewFileIndex = {};
    _need_commit = false;

    _need_save_ids: string[] = [];
    _need_delete_ids: string[] = [];

    _non_committed_ids: string[] = [];
    _non_deleted_ids: string[] = [];

    _xdb_entity_id!: string;
    _xdb_entity_name!: string;

    constructor(data: XObjectData) {
        data["_type"] = XDBFile._xtype;
        super(data, {}, true);

        this.parse(data);

        this.addXporterDataIgnoreFields([]);
    }

    // ---------- reads ----------
    async getFile(fid: string): Promise<string> {
        const engine = getXdbEngine();
        return await engine.loadFile(this._xdb_entity_name, fid);
    }

    async getFiles(fids: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const fid of fids) out.push(await this.getFile(fid));
        return out;
    }

    // ---------- writes ----------
    addFile(file: any): string {
        const fid = XUtils.guid();
        this._new_file_index[fid] = file;
        this._need_commit = true;
        this._need_save_ids.push(fid);
        return fid;
    }

    deleteFile(fid: string) {
        if (!fid) return;
        this._need_commit = true;
        this._need_delete_ids.push(fid);
    }

    deleteFiles(fids: string[]) {
        for (const fid of fids) this.deleteFile(fid);
    }

    async commit(): Promise<void> {
        if (!this._need_commit) return;
        const engine = getXdbEngine();
        this._non_committed_ids = [];
        this._non_deleted_ids = [];
        // ---- save queued files ----
        if (this._need_save_ids.length > 0) {
            const saveIds = this._need_save_ids;
            this._need_save_ids = [];

            let committed = 0;

            for (const fid of saveIds) {
                const payload = this._new_file_index[fid];
                if (payload === undefined) continue;

                try {
                    await engine.saveFile(this._xdb_entity_name, fid, payload);
                    delete this._new_file_index[fid];
                    committed++;
                } catch (e: any) {
                    this._non_committed_ids.push(fid);
                    _xlog.error(
                        `XDBFile commit save failed entity=${this._xdb_entity_name} fid=${fid}: ${e?.message ?? e}`
                    );
                }
            }

            if (committed > 0) _xlog.log(`XDBFile committed ${committed} files (entity=${this._xdb_entity_name})`);
            if (this._non_committed_ids.length > 0) {
                _xlog.error(
                    `XDBFile failed to commit ${this._non_committed_ids.length} files (entity=${this._xdb_entity_name})`
                );
            }
        }

        // ---- delete queued files ----
        if (this._need_delete_ids.length > 0) {
            const delIds = this._need_delete_ids;
            this._need_delete_ids = [];

            let deleted = 0;

            for (const fid of delIds) {
                try {
                    await engine.deleteFile(this._xdb_entity_name, fid);
                    deleted++;
                } catch (e: any) {
                    this._non_deleted_ids.push(fid);
                    _xlog.error(
                        `XDBFile delete failed entity=${this._xdb_entity_name} fid=${fid}: ${e?.message ?? e}`
                    );
                }
            }

            if (deleted > 0) _xlog.log(`XDBFile deleted ${deleted} files (entity=${this._xdb_entity_name})`);
            if (this._non_deleted_ids.length > 0) {
                _xlog.error(
                    `XDBFile failed to delete ${this._non_deleted_ids.length} files (entity=${this._xdb_entity_name})`
                );
            }
        }

        this._need_commit = false;
    }
}

export default XDBFile;
