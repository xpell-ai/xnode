
import path from "path";
import fs from "fs";
import type { Express } from "express";
import { _x, _xlog } from "@xpell/core";
import { _xs } from "../XSettings/XSettings.js";
import { _xu } from "../XNUtils/XUtils.js";
import { XWebServer } from "./XWebServer.js";
import type { XWebSettings } from "./XWebServer.js";
import { PingModule } from "../modules/PingModule.js";
import { ServerXVMModule } from "../modules/ServerXVMModule.js";

type XNodeOptions = {
    settingsPath?: string;
    work_folder?: string;
    web_settings?: Partial<XWebSettings>;
    routes?: (app: Express, server: XWebServer) => void;
    port?: number;
    host?: string;
};


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
        const server_folders = [work_folder, path.join(work_folder, "data")];
        const initFilePath = path.join(work_folder, ".xpell-initialized");
        if (!fs.existsSync(initFilePath)) {
            _xlog.log("⚙️ Running Xpell Server for first time , performing initial setup");
            _xu.checkFolders(server_folders);
            _xs.onSetup(work_folder);
            _xs.set("modules", {}); //save default settings file
            this._web_server.onSetup(work_folder);

            //create the file to mark initialization
            fs.writeFileSync(initFilePath, Date.now().toString(), "utf-8");
        } else {
            this.init(work_folder);
        }
    }

    init(work_folder: string) {
        this._work_folder = work_folder;
        _xs.init(work_folder);
        this._web_server.init(work_folder);
        _xlog.log("Xpell Server initialization check ✅");
    }

    private applyWebSettingsOverrides(options: XNodeOptions) {
        const overrides: Partial<XWebSettings> = { ...(options.web_settings ?? {}) };
        if (options.port !== undefined) overrides["http-port"] = options.port;
        if (options.host !== undefined) overrides.domain = options.host;
        if (Object.keys(overrides).length === 0) return;

        const current = _xs.get("xweb");
        const merged = { ...(current ?? {}), ...overrides };
        _xs.set("xweb", merged);
    }


    /**
     * Start the server singleton (idempotent). Subsequent calls return the same instance.
     */

    async start(options: XNodeOptions = {}): Promise<void> {
        if (this._started) return;
        const work_folder = options.work_folder ?? "./work";

        if (!this._settings_events_bound) {
            this.bindSettingsEvents();
            this._settings_events_bound = true;
        }

        this.ensureSetup(work_folder);

        _x.start();

        this.applyWebSettingsOverrides(options);

        // Example: XNode.start({ routes: (app, server) => app.get("/", (_req, res) => res.send("hello")) })
        // Example: XNode.start({ web_settings: { routes: { /* xweb route overrides */ } } })
        if (options.routes) {
            this._web_server.useRoutes(options.routes);
        }
        this._web_server.load();
        await this._web_server.start();
        _x.loadModule(new PingModule());
        const server_xvm = new ServerXVMModule({ _work_folder: this._work_folder });
        _x.loadModule(server_xvm);
        if (typeof (server_xvm as any).init_on_boot === "function") {
            await (server_xvm as any).init_on_boot();
        }
        this._started = true;
    }


    

    /**
     * Stop the server if it is running.
     */
    stop() {
        // this.server?.close();
        // this.server = undefined;
    }


    // this method bind to settings changes events
    // to apply changes dynamically
    private bindSettingsEvents() {
        _xs.on("update", (data: any) => {
            let needRestart: boolean = false;
            if (needRestart) {
                _xlog.log(`Settings changed. Restart required to apply changes.`);
            }
        });
        _xs.on("error", (err: any) => {
            _xlog.error("XpellServer settings error", err);
        });
        _xlog.log("Xpell settings events bounded ✅");
    }
}

export default XNode;
