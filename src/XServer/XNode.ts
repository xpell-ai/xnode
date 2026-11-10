
import path from "path";
import fs from "fs";
import { _x, _xlog, type XModule } from "@xpell/core";
import { _xs } from "@xpell/node-core";
import { _xu } from "@xpell/node-core";
import { XWebServer } from "./XWebServer.js";
import type { XWebRouteContributor, XWebSettings } from "./XWebServer.js";
import { PingModule } from "../modules/PingModule.js";
import { ServerXVMModule } from "../XVM/ServerXVMModule.js";
import { setXEventManager, } from "@xpell/core";
import { _xem, XEventManager } from "@xpell/node-core";
import { XAI } from "../XAI/XAI.js";
import FlowManagerModule from "../XFM/FlowManagerModule.js";
import { XEntityManager } from "../XEntityManager/XEntityManager.js";
import {
    XDB, XDBStorageFS, XDBStorageSqlite, type IXDBStorage
} from "../XDB/index.js";
import { XAuthModule } from "../XAuth/index.js";
import {
    MCPModule,
    markXpellMCPRuntimeFailed,
    markXpellMCPRuntimeReady,
    markXpellMCPRuntimeStarting,
} from "@xpell/mcp";

import type { IXDBEmbeddingProvider, IXDBVectorQueryProvider, XDBOptions } from "../XDB/index.js";
import { XModuleCreatorModule } from "../XGenerative/index.js";
import { XMutatorModule } from "../XMutator/XMutatorModule.js";
import { XStudioModule } from "../XStudio/index.js";
import { WormholesModule } from "../Wormholes/wh.index.js";
import { XPlanningModule } from "../XPlanning/index.js";
import { createFileServiceModule, mountFileServiceUploadRoutes } from "@xpell/file-service/server";

export type XNodeOptions = {
    _settings_path?: string;
    _work_folder?: string;
    _web_settings?: Partial<XWebSettings>;
    _system_xapps_path?: string;
    _port?: number;
    /** Listener address; public URL/domain stays in _web_settings.domain. */
    _host?: string;
    _xdb?: XDBOptions;
    /** Server-owned EntityManager SQLite policy, separate from XDB storage. */
    _entity_sqlite?: { _require_full_durability?: boolean };
    _modules?: XModule[];
    _routes?: XWebRouteContributor[];
};

class XNodeStartupError extends Error {
    _ok = false;
    _code: string;
    _details: Record<string, unknown>;

    constructor(
        code: string,
        message: string,
        details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = "XNodeStartupError";
        this._code = code;
        this._details = details;
    }

    toXData() {
        return {
            _ok: false,
            _error: {
                _code: this._code,
                _message: this.message,
                _details: this._details
            }
        };
    }
}

/**
 * Lightweight Xpell Node server bootstrapper.
 * Host applications can simply call XNode.start() to spin up an Express HTTP server
 * using server-settings.json defaults (port/host) or explicit options.
 */
export class XNode {

    _web_server: XWebServer = new XWebServer();
    _work_folder!: string;
    _started: boolean = false;
    _settings_events_bound: boolean = false;
    private static _runtime_owner?: XNode;
    private readonly _core_owner = {};
    private _owns_core = false;
    private _owns_settings = false;
    private _bootstrap_started = false;
    private _stopping = false;
    private _terminal = false;
    private _startup?: Promise<void>;
    private _shutdown?: Promise<void>;
    private _cleanup?: Promise<void>;
    private _xdb_storage?: IXDBStorage;

    constructor() {
    }

    // this method runs only once during first server start
    // the method call all server onSetup methods
    private ensureSetup(work_folder: string) {
        this._work_folder = work_folder;
        const server_folders = [work_folder, path.join(work_folder, "xdb")];
        const initFilePath = path.join(work_folder, ".xpell-initialized");
        if (!fs.existsSync(initFilePath)) {
            _xlog.log("⚙️ Running Xpell Server for first time , performing initial setup");
            _xu.checkFolders(server_folders);
            _xs.onSetup(work_folder);
            _xs.ensure("modules", {});
            this._web_server.onSetup(work_folder);

            //create the file to mark initialization
            fs.writeFileSync(initFilePath, Date.now().toString(), "utf-8");
        } else {
            this.init(work_folder);
        }
    }

    private create_xdb_storage(options: XDBOptions, work_folder: string): IXDBStorage {
        const root =
            path.resolve(
                options._root ??
                path.join(work_folder, "xdb")
            );
        if (options._type === "sqlite") {
            return new XDBStorageSqlite({
                dbPath:
                    options._sqlite?._db_path ??
                    path.join(root, "xdb.sqlite"),
                wal:
                    options._sqlite?._wal ?? true,
                busyTimeoutMs:
                    options._sqlite?._busy_timeout_ms ?? 5000,
                blobStorage:
                    new XDBStorageFS({ xdbFolder: root })
            });
        }

        return new XDBStorageFS({
            xdbFolder: root
        });
    }

    init(work_folder: string) {
        setXEventManager(XEventManager);
        this._work_folder = work_folder;
        _xs.init(work_folder);
        _xlog.log("XSettings xweb after init:", _xs.get("xweb"));
        this._web_server.init(work_folder);
        _xlog.log("Xpell Server initialization check ✅");
    }

    private applyWebSettingsOverrides(options: XNodeOptions) {
        const overrides: Partial<XWebSettings> = { ...(options._web_settings ?? {}) };
        if (options._port !== undefined) overrides["http-port"] = options._port;
        if (options._host !== undefined) overrides["listen-host"] = options._host;
        if (Object.keys(overrides).length === 0) return;

        const current = _xs.get("xweb");
        const merged = { ...(current ?? {}), ...overrides };
        _xs.set("xweb", merged);
    }

    private validateApplicationModules(modules: XModule[] = []) {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const mod of modules) {
            const module_name = mod?._name;
            if (typeof module_name !== "string" || module_name.trim() === "") {
                throw new XNodeStartupError(
                    "E_XNODE_INVALID_MODULE",
                    "XNode.start option '_modules' must contain XModule instances with a non-empty '_name'.",
                    {
                        _module: module_name ?? null
                    }
                );
            }

            if (seen.has(module_name)) {
                duplicates.add(module_name);
            }
            seen.add(module_name);
        }

        if (duplicates.size > 0) {
            throw new XNodeStartupError(
                "E_XNODE_DUPLICATE_MODULES",
                "XNode.start option '_modules' contains duplicate module names.",
                {
                    _duplicates: Array.from(duplicates)
                }
            );
        }

    }

    private validateRouteContributors(routes: unknown): XWebRouteContributor[] {
        if (routes === undefined) return [];

        if (!Array.isArray(routes)) {
            throw new XNodeStartupError(
                "E_XNODE_INVALID_ROUTES",
                "XNode.start option '_routes' must be an array of route contributor functions.",
                {
                    _received_type: typeof routes
                }
            );
        }

        for (let index = 0; index < routes.length; index += 1) {
            if (typeof routes[index] !== "function") {
                throw new XNodeStartupError(
                    "E_XNODE_INVALID_ROUTE_CONTRIBUTOR",
                    "XNode.start option '_routes' must contain only route contributor functions.",
                    {
                        _index: index,
                        _received_type: typeof routes[index]
                    }
                );
            }
        }

        return routes as XWebRouteContributor[];
    }


    /**
     * Start once with exclusive Core ownership. Repeated live starts are idempotent.
     * Shutdown is terminal: the module graph is restarted only in a fresh process.
     */

    async start(options: XNodeOptions = {}): Promise<void> {
        if (this._stopping || this._terminal) {
            throw new XNodeStartupError("E_XNODE_RESTART_REQUIRES_PROCESS", "Restart XNode in a fresh process after shutdown.");
        }
        if (this._started) return;
        if (this._startup) return this._startup;
        if (_x.isRunning()) {
            throw new XNodeStartupError("E_XNODE_CORE_IN_USE", "XNode requires exclusive ownership of a fresh Core run.");
        }
        if (XNode._runtime_owner) {
            throw new XNodeStartupError("E_XNODE_RESTART_REQUIRES_PROCESS", "The previous XNode module graph requires a fresh process.");
        }
        if (this._web_server._web_server?.listening || this._web_server._secured_web_server?.listening) {
            throw new XNodeStartupError("E_XNODE_LISTENER_IN_USE", "XNode cannot acquire an already-running web server.");
        }
        const startup = this.startRuntime(options);
        this._startup = startup;
        try { await startup; }
        finally { this._startup = undefined; }
    }

    private async loadOwnedModule(module: XModule): Promise<void> {
        if (this._stopping) throw new XNodeStartupError("E_XNODE_STOPPING", "XNode is stopping.");
        await _x.loadModuleAsync(module);
        if (this._stopping) throw new XNodeStartupError("E_XNODE_STOPPING", "XNode is stopping.");
    }

    private async startRuntime(options: XNodeOptions): Promise<void> {
        markXpellMCPRuntimeStarting("xnode_module_graph_loading");
        const work_folder = options._work_folder ?? "./work";
        const application_modules = options._modules ?? [];
        try {
            this.validateApplicationModules(application_modules);
            const route_contributors = this.validateRouteContributors(options._routes);
            this._bootstrap_started = true;

            if (!this._settings_events_bound) {
                this.bindSettingsEvents();
                this._settings_events_bound = true;
            }

            this._owns_settings = true;
            this.ensureSetup(work_folder);

            const acquired = _x.start(this._core_owner);
            if (acquired === false) throw new XNodeStartupError("E_XNODE_CORE_IN_USE", "Core is already running.");
            this._owns_core = acquired === true;
            if (this._owns_core) XNode._runtime_owner = this;

            this.applyWebSettingsOverrides(options);

            const file_service = createFileServiceModule({
                _work_folder: this._work_folder
            });

            for (const route_contributor of route_contributors) {
                this._web_server.useRoutes(route_contributor);
            }
            this._web_server.useRoutes((app) => {
                mountFileServiceUploadRoutes(app, file_service);
            });
            this._web_server.load();
            await this._web_server.start();
            if (this._stopping) throw new XNodeStartupError("E_XNODE_STOPPING", "XNode is stopping.");
            /* -------------------------------------------------- */
            /* XDB                                                */
            /* -------------------------------------------------- */

            const xdb_options =
                options._xdb ?? {};

            const xdb_storage =
                this.create_xdb_storage(
                    xdb_options,
                    work_folder
                );
            this._xdb_storage = xdb_storage;

            XDB.init({
                storage: xdb_storage,
                enableCache: xdb_options._cache ?? true,
                workFolder: work_folder,
                embedder: xdb_options._embedder,
                vectorQuery: xdb_options._vector_query
            });
            await this.loadOwnedModule(XDB);
            await this.loadOwnedModule(new PingModule());
            await this.loadOwnedModule(new WormholesModule());
            await this.loadOwnedModule(new XAuthModule());
            await this.loadOwnedModule(new MCPModule());
            await this.loadOwnedModule(XAI);
            await this.loadOwnedModule(file_service);

            await this.loadOwnedModule(new XModuleCreatorModule({
                _work_folder: this._work_folder
            }));

            await this.loadOwnedModule(new XMutatorModule());

            for (const mod of application_modules) {
                await this.loadOwnedModule(mod);
            }

            await this.loadOwnedModule(new FlowManagerModule());
            await this.loadOwnedModule(new XEntityManager({
                _provider_runtime_context: {
                    _work_folder:
                        this._work_folder,
                    _sqlite_require_full_durability: options._entity_sqlite?._require_full_durability === true
                }
            }));
            await this.loadOwnedModule(new XPlanningModule());
            await this.loadOwnedModule(new XStudioModule());
            const server_xvm = new ServerXVMModule({ _work_folder: this._work_folder, _system_xapps_path: options._system_xapps_path });
            await this.loadOwnedModule(server_xvm);


            this._started = true;
            markXpellMCPRuntimeReady("xnode_module_graph_loaded");
            _xem.fire("server:started", { work_folder: this._work_folder });
        } catch (error) {
            markXpellMCPRuntimeFailed("xnode_module_graph_failed", {
                _message: error instanceof Error ? error.message : String(error),
            });
            if (this._bootstrap_started) {
                this._stopping = true;
                try { await this.cleanupOwnedResources(); }
                catch (cleanup_error) { throw new AggregateError([error, cleanup_error], "XNode startup and cleanup failed"); }
            }
            throw error;
        }
    }




    /**
     * Fence new work immediately, close owned resources, and settle an in-progress
     * startup. Application load hooks must settle; arbitrary user code is not cancelled.
     */
    stop(): Promise<void> {
        if (this._shutdown) return this._shutdown;
        this._stopping = true;
        this._terminal = true;
        this._started = false;
        if (this._bootstrap_started) markXpellMCPRuntimeFailed("xnode_stopping");
        // Fence commands and future frames synchronously, before awaiting sockets.
        if (this._owns_core) { _x.stop(this._core_owner); this._owns_core = false; }
        // Stop accepting HTTP/WS work even if an application load hook is still settling.
        const closing = this._bootstrap_started ? this._web_server.stop?.() : undefined;
        this._shutdown = (async () => {
            await Promise.allSettled([this._startup, closing]);
            await this.cleanupOwnedResources();
            if (this._bootstrap_started) markXpellMCPRuntimeFailed("xnode_stopped");
        })();
        return this._shutdown;
    }

    private cleanupOwnedResources(): Promise<void> {
        if (this._cleanup) return this._cleanup;
        this._terminal = true;
        this._started = false;
        if (this._owns_core) { _x.stop(this._core_owner); this._owns_core = false; }
        this._cleanup = (async () => {
            // These are the handles created by this bootstrap. Global provider
            // registries and application-owned stores/adapters are not ours to close.
            const results = await Promise.allSettled([
                this._bootstrap_started ? this._web_server.stop?.() : undefined,
                this._xdb_storage?.close(),
            ]);
            if (this._owns_settings) { _xs.close(); this._owns_settings = false; }
            if (this._settings_events_bound) {
                _xem.removeOwner(this); this._settings_events_bound = false;
            }
            const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
            if (failures.length) throw new AggregateError(failures.map(r => r.reason), "XNode shutdown failed");
        })();
        return this._cleanup;
    }


    // this method bind to settings changes events
    // to apply changes dynamically
    private bindSettingsEvents() {
        _xem.on("settings:update", (data: any) => {
            let needRestart = false;

            if (needRestart) {
                _xlog.log(
                    "Settings changed. Restart required to apply changes."
                );
            }
        }, { _owner: this });

        _xem.on("settings:error", (err: any) => {
            _xlog.error("XpellServer settings error", err);
        }, { _owner: this });

        _xlog.log("Xpell settings events bound ✅");
    }
}

export default XNode;
