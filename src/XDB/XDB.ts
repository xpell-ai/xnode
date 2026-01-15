// XDB.ts — XDB Module (xpell-node)
// - storage-agnostic engine (IXDBStorage injected)
// - XDB-owned XObjects are module-managed (XDB.create)
// - cache remains optional

import { XModule, type XCommand, _xlog } from "xpell-core";
import { _xem } from "../XEM/XEventManager.js";

import { XDBEngine, type IXDBEmbeddingProvider, type IXDBVectorQueryProvider } from "./XDBEngine.js";
import type { IXDBStorage } from "./IXDBStorage.js";

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
};

export class XDBModule extends XModule {
    _engine!: XDBEngine;
    _cache?: XDBCache;

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

    async load() {
        if (!this._initOpts?.storage) {
            throw new Error(
                "XDB.load() called without init options. Call XDB.init({ storage, ... }) before _x.loadModule(XDB)."
            );
        }

        // init engine with injected providers
        this._engine = new XDBEngine({
            storage: this._initOpts.storage,
            embedder: this._initOpts.embedder,
            vectorQuery: this._initOpts.vectorQuery,
            envName: this._initOpts.envName,
        });

        await this._engine.init();
        _xlog.log("XDB Engine initialized");

        // init cache (optional)
        if (this._initOpts.enableCache !== false) {
            this._cache = new XDBCache();
            await this._cache.init();
            _xlog.log("XDB Cache initialized");
        } else {
            this._cache = undefined;
            _xlog.log("XDB Cache disabled");
        }

        // register types (for object manager compatibility)
        this.importObject(XDBEntity._xtype, XDBEntity as any);
        this.importObject(XDBVector._xtype, XDBVector as any);
        this.importObject(XDBFile._xtype, XDBFile as any);
        this.importObject(XDBTemp._xtype, XDBTemp as any);

        // only now announce ready
        this._ready = true;
        _xem.fire("xdb-ready", { version: VERSION });

        await super.load();
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

    async hasObject(objectName: string): Promise<boolean> {
        return await this._engine.hasObject(objectName);
    }

    // ---------------------------------------------------------------------------
    // Frame hook
    // ---------------------------------------------------------------------------

    async onFrame(frameNumber: number): Promise<void> {
        await this._cache?.onFrame(frameNumber);

        if (frameNumber % ZIP_EVERY_N_FRAMES === 0) {
            try {
                await this._engine.zipFolder(ENTITIES_FOLDER);
            } catch (e: any) {
                _xlog.debug(`XDB zip skipped: ${e?.message ?? e}`);
            }
        }

        await super.onFrame(frameNumber);
    }

}

export const XDB = new XDBModule();
export default XDB;
