
import path from "path";
import fs from 'fs'
import { _x,_xlog } from "xpell-core";
import { _xs } from "../XSettings/XSettings.js";
import { _xu } from "../XNUtils/XUtils.js";
import {XWebServer} from "./XWebServer.js";

type XNodeOptions = {
    settingsPath?: string;
    port?: number;
    host?: string;
};

const WORK_FOLDER = "./work";
const ServerFolders = [WORK_FOLDER, WORK_FOLDER + "/data" ];


/**
 * Lightweight Xpell Node server bootstrapper.
 * Host applications can simply call XNode.start() to spin up an Express HTTP server
 * using server-settings.json defaults (port/host) or explicit options.
 */
export class XNode {

    _web_server: XWebServer = new XWebServer();

    constructor() {
        
        this.onSetup();
        
    }


    // this method runs only once during first server start
    // the method call all server onSetup methods
    private onSetup() {
        //ensure required folders exist
        
        //check if ".data/.xpell-initialized"   file exists
        const initFilePath = path.join(WORK_FOLDER , ".xpell-initialized");
        if (!fs.existsSync(initFilePath)) {
            _xlog.log("⚙️ Running Xpell Server for first time , performing initial setup");
            _xu.checkFolders(ServerFolders);
            _xs.onSetup(WORK_FOLDER);
            _xs.set("modules",{}); //save default settings file
            this._web_server.onSetup(WORK_FOLDER);
            
            //create the file to mark initialization
            fs.writeFileSync(initFilePath, Date.now().toString(), 'utf-8');
        } else {
            this.init();
        }
    }

    init() {
        _xs.init(WORK_FOLDER);
        this._web_server.init(WORK_FOLDER);
        _xlog.log("Xpell Server initialization check ✅");
    }




    /**
     * Start the server singleton (idempotent). Subsequent calls return the same instance.
     */

    async start(options: XNodeOptions = {}): Promise<void> {
        this.bindSettingsEvents();
        this._web_server.load();
        this.listen();
        _x.start()
    }


    

    /**
     * Stop the server if it is running.
     */
    stop() {
        // this.server?.close();
        // this.server = undefined;
    }

    private listen() {
        this._web_server.start();
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
