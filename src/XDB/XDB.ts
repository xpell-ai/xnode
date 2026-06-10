// XDB.ts — XDB Module (xpell-node)
// - storage-agnostic engine (IXDBStorage injected)
// - XDB-owned XObjects are module-managed (XDB.create)
// - cache remains optional

import { XModule, type XCommand, _xlog ,type XpellSkill} from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";

import { XDBEngine, type IXDBEmbeddingProvider, type IXDBVectorQueryProvider } from "./XDBEngine.js";
import type { IXDBStorage } from "./IXDBStorage.js";
import _xu from "../XNUtils/XUtils.js";

import XDBEntity from "./XDBEntity.js";
import XDBVector from "./XDBVector.js";
import XDBCache from "./XDBCache.js";
import XDBFile from "./XDBFile.js";
import XDBTemp from "./XDBTemp.js";

const VERSION = "1.0.0";

// ~1 day in frames if running ~1 fps? (fragile; kept as-is)
const ZIP_EVERY_N_FRAMES = 85714;
const ENTITIES_FOLDER = "./data/xdb/entities";

export type XDBModuleInitOptions = {
    storage: IXDBStorage;
    embedder?: IXDBEmbeddingProvider;
    vectorQuery?: IXDBVectorQueryProvider;
    envName?: string;
    enableCache?: boolean;
    workFolder: string;
};

export const XDB_OPS = {
    info: {
        _name: "info",
        _scope: "module",
        _description: "Return XDB runtime information."
    },

    save_object: {
        _name: "save_object",
        _scope: "module",
        _description: "Persist object to storage."
    },

    get_object: {
        _name: "get_object",
        _scope: "module",
        _description: "Load object from storage."
    },

    cache_data: {
        _name: "cache_data",
        _scope: "module",
        _description: "Store data in XDB cache."
    },

    get_cache_data: {
        _name: "get_cache_data",
        _scope: "module",
        _description: "Read data from XDB cache."
    }
};

export class XDBModule extends XModule {
    _engine!: XDBEngine;
    _cache?: XDBCache;

    static _name = "xdb";

    static _skill: XpellSkill = {
        _id: "xdb",
        _title: "XDB",
        _version: VERSION,
        _active: true,
        _type: "server-module-api",
        _requires: ["xmodule"],

        _description:
            "Storage, caching, vector search, files, and entity persistence.",

        _exports: {
            _modules: [
                {
                    _name: "xdb",
                    _scope: "server",
                    _description:
                        "Core storage engine.",
                    _ops: Object.values(XDB_OPS),
                }
            ],

        },

        _core_rules: [
            "Use xdb for persistence.",
            "Use xdb-entity for structured records.",
            "Use xdb-vector for embeddings and vector search.",
            "Use xdb-file for file storage.",
            "Use cache operations for temporary runtime caching."
        ]
    };

    static _ops = XDB_OPS;

    private _initOpts?: XDBModuleInitOptions;
    private _ready = false;

    constructor() {
        super({ _name: "xdb" });
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Must be called BEFORE load() (or you can call the _init command).
     */
    init(opts: XDBModuleInitOptions) {
        this._initOpts = opts;
    }

    get ready() {
        return this._ready;
    }

    async _info(_xcmd: XCommand) {
        _xlog.log(`XDB module v${VERSION} | ready=${this._ready}`);
    }

    /**
     * Optional runtime init via command:
     * _x.execute({ _module:"xdb", _op:"init", _params:{...} })
     *
     * NOTE: since IXDBStorage is not JSON-serializable, you typically call init()
     * from code, not through Wormholes. This command exists mainly for parity.
     */
    async _init(_xcmd: XCommand) {
        // If you ever add a storage registry, you can resolve storage by name here.
        throw new Error("XDB._init is not supported without a storage registry. Call XDB.init({storage,...}) in code.");
    }

    /**
     * Convenience factory. Keeps your legacy-style usage:
     * XDB.create({ _type:"xdb-entity", _name:"users", _schema:{...} })
     */
    create(data: any) {
        const t = data?._type;

        if (
            t === XDBEntity._xtype ||
            t === XDBVector._xtype ||
            t === XDBFile._xtype ||
            t === XDBTemp._xtype
        ) {
            if (!this._engine || !this._engine._initialized) {
                throw new Error("XDB.create called before engine init");
            }
        }

        return super.create(data);
    }

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    override async onLoad() {
        if (!this._initOpts?.storage) {
            throw new Error(
                "XDB.load() called without init options..."
            );
        }
        this._engine = new XDBEngine({
            storage: this._initOpts.storage,
            embedder: this._initOpts.embedder,
            vectorQuery: this._initOpts.vectorQuery,
            envName: this._initOpts.envName,
        });
        await this._engine.init();
        _xlog.log("XDB Engine initialized");
        if (this._initOpts.enableCache !== false) {
            this._cache = new XDBCache({ cacheFolder: _xu.pathJoin(this._initOpts.workFolder, "cache") });
            await this._cache.init();
            _xlog.log("XDB Cache initialized");
        } else {
            this._cache = undefined;
            _xlog.log(
                "XDB Cache disabled"
            );
        }
        this.importObject(
            XDBEntity._xtype,
            XDBEntity as any
        );
        this.importObject(
            XDBVector._xtype,
            XDBVector as any
        );
        this.importObject(
            XDBFile._xtype,
            XDBFile as any
        );
        this.importObject(
            XDBTemp._xtype,
            XDBTemp as any
        );
        this._ready = true;
        _xem.fire(
            "xdb-ready",
            { version: VERSION }
        );

    }

    // ---------------------------------------------------------------------------
    // Cache passthrough (safe if cache disabled)
    // ---------------------------------------------------------------------------

    saveCache() {
        this._cache?.saveCache();
    }

    cacheData(key: string, data: any, autoSave: boolean = true) {
        this._cache?.cacheData(key, data, autoSave);
    }

    getCacheData(key: string): any {
        return this._cache?.getCacheData(key);
    }

    getVectorsFromCache(key: string) {
        return this._cache?.getVectors(key);
    }

    saveVectorsToCache(key: string, vectors: any) {
        this._cache?.cacheVectors(key, vectors);
    }

    // ---------------------------------------------------------------------------
    // Engine passthrough
    // ---------------------------------------------------------------------------

    async saveObject(name: string, data: any) {
        return await this._engine.saveObject(name, data);
    }

    getObject(objectName: string, format: "string" | "json" = "json"): any {
        return this._engine.getObject(objectName, format);
    }

    // async hasObject(objectName: string): Promise<boolean> {
    //     return await this._engine.hasObject(objectName);
    // }

    // ---------------------------------------------------------------------------
    // Frame hook
    // ---------------------------------------------------------------------------

    async onFrame(frameNumber: number): Promise<void> {
        await this._cache?.onFrame(frameNumber);

        // if (frameNumber % ZIP_EVERY_N_FRAMES === 0) {
        //     try {
        //         await this._engine.zipFolder(ENTITIES_FOLDER);
        //     } catch (e: any) {
        //         _xlog.log(`XDB zip skipped: ${e?.message ?? e}`);
        //     }
        // }

        await super.onFrame(frameNumber);
    }

}

export const XDB = new XDBModule();
export default XDB;
