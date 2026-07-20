
import path from "path";
import fs from "fs";
import { _x, _xlog, type XModule } from "@xpell/core";
import { _xs } from "@xpell/node-core";
import { _xu } from "@xpell/node-core";
import { XWebServer } from "./XWebServer.js";
import type { XWebSettings } from "./XWebServer.js";
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
import { MongoConnections } from "../XEntityManager/MongoConnectionManager.js";

import type { IXDBEmbeddingProvider, IXDBVectorQueryProvider, XDBOptions } from "../XDB/index.js";
import { XVibeModule } from "@xpell/vibe";
import { XModuleCreatorModule } from "../XGenerative/index.js";
import { XMutatorModule } from "../XMutator/XMutatorModule.js";
import { XStudioModule } from "../XStudio/index.js";
import { WormholesModule } from "../Wormholes/wh.index.js";

type XNodeOptions = {
    _settings_path?: string;
    _work_folder?: string;
    _web_settings?: Partial<XWebSettings>;
    _system_xapps_path?: string;
    _port?: number;
    _host?: string;
    _xdb?: XDBOptions;
    _modules?: XModule[];
    _load_vibe?: boolean;
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
        if (options._host !== undefined) overrides.domain = options._host;
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

        return {
            _has_xvibe: seen.has("xvibe")
        };
    }


    /**
     * Start the server singleton (idempotent). Subsequent calls return the same instance.
     */

    async start(options: XNodeOptions = {}): Promise<void> {
        if (this._started) return;
        const work_folder = options._work_folder ?? "./work";
        const application_modules = options._modules ?? [];
        const application_module_state =
            this.validateApplicationModules(application_modules);

        if (!this._settings_events_bound) {
            this.bindSettingsEvents();
            this._settings_events_bound = true;
        }

        this.ensureSetup(work_folder);

        _x.start();

        this.applyWebSettingsOverrides(options);

        // Example: XNode.start({ routes: (app, server) => app.get("/", (_req, res) => res.send("hello")) })
        // Example: XNode.start({ web_settings: { routes: { /* xweb route overrides */ } } })
        //TODO - add support for dynamic routes loading from options (e.g. for plugins) without needing to restart the server, currently routes can be added only via onSetup or by directly calling web_server.useRoutes() after start
        // if (options.routes) {
        //     this._web_server.useRoutes(options.routes);
        // }
        this._web_server.load();
        await this._web_server.start();
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

        XDB.init({
            storage: xdb_storage,
            enableCache: xdb_options._cache ?? true,
            workFolder: work_folder,
            embedder: xdb_options._embedder,
            vectorQuery: xdb_options._vector_query
        });
        await _x.loadModuleAsync(XDB);
        await _x.loadModuleAsync(new PingModule());
        await _x.loadModuleAsync(new WormholesModule());
        await _x.loadModuleAsync(new XAuthModule());
        await _x.loadModuleAsync(XAI);

        await _x.loadModuleAsync(new XModuleCreatorModule({
            _work_folder: this._work_folder
        }));

        await _x.loadModuleAsync(new XMutatorModule());

        for (const mod of application_modules) {
            await _x.loadModuleAsync(mod);
        }

        if (options._load_vibe !== false && !application_module_state._has_xvibe) {
            await _x.loadModuleAsync(new XVibeModule());
        }

        await _x.loadModuleAsync(new FlowManagerModule());
        await _x.loadModuleAsync(new XEntityManager());
        await _x.loadModuleAsync(new XStudioModule());
        const server_xvm = new ServerXVMModule({ _work_folder: this._work_folder, _system_xapps_path: options._system_xapps_path });
        await _x.loadModuleAsync(server_xvm);


        this._started = true;
        _xem.fire("server:started", { work_folder: this._work_folder });
    }




    /**
     * Stop the server if it is running.
     */
    async stop() {
        await MongoConnections.disconnectAll();
        // this.server?.close();
        // this.server = undefined;
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
        });

        _xem.on("settings:error", (err: any) => {
            _xlog.error("XpellServer settings error", err);
        });

        _xlog.log("Xpell settings events bound ✅");
    }
}

export default XNode;
