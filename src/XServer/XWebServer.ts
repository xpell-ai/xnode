/*
 AIME Web Server
 Author       : Tamir Fridman
 Date Created : 18/05/2022
 Copyright AIME Web3 Technologies
*/

import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import enforce from "express-sslify";
import WebSocket from "ws";

import { _x, _xlog } from "xpell-core";
import { _xu } from "../XNUtils/XUtils.js";
import { _xs } from "../XSettings/XSettings.js";
import { fileURLToPath } from "url";

import {
  createWormholesWSServer,
  createWormholesRestRouter,
} from "../Wormholes/wh.index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/* ENV                                                                */
/* ------------------------------------------------------------------ */

const SUPER_USER_KEY = process.env.SUPER_USER_KEY ?? "";
const ENV_NAME = (process.env.ENV_NAME ?? "local").toLowerCase();

/* ------------------------------------------------------------------ */
/* SETTINGS                                                           */
/* ------------------------------------------------------------------ */

export type XWebSettings = {
  domain: string;
  "http-port": number;
  "enable-ssl": boolean;
  "enable-wormhole": boolean;
  "ssl-settings": {
    "https-port": number;
    "ssl-pk-file": string;
    "ssl-cert-file": string;
    "ssl-chain-file": string;
  };
};

const DEFAULT_XWEB_SETTINGS: XWebSettings = {
  domain: "localhost",
  "http-port": 3000,
  "enable-ssl": false,
  "enable-wormhole": true,
  "ssl-settings": {
    "https-port": 3443,
    "ssl-pk-file": "",
    "ssl-cert-file": "",
    "ssl-chain-file": "",
  },
};

/* ------------------------------------------------------------------ */
/* SERVER                                                             */
/* ------------------------------------------------------------------ */

export class XWebServer {
  _engine_id = _xu.guid();
  _work_folder!: string;
  _public_folder!: string;
  _web_settings!: XWebSettings;

  _web_server?: http.Server;
  _secured_web_server?: https.Server;
  _app!: express.Express;

  constructor() {}

  get _express_app() {
    return this._app;
  }

  /* ---------------------------------------------------------------- */
  /* SETUP                                                            */
  /* ---------------------------------------------------------------- */

  init(workFolder = ".work") {
    this._work_folder = path.resolve(workFolder);
    this._public_folder = path.resolve(workFolder, "public");
  }

  onSetup(workFolder = ".work") {
    this.init(workFolder);
    _xu.checkFolders([this._public_folder]);

    _xs.set("xweb", DEFAULT_XWEB_SETTINGS);

    const indexSrc = path.resolve(
      "./node_modules/xpell-node/dist/assets/index.html"
    );
    const indexDst = path.join(this._public_folder, "index.html");

    if (fs.existsSync(indexSrc)) {
      fs.copyFileSync(indexSrc, indexDst);
    }
  }

  /* ---------------------------------------------------------------- */
  /* LOAD                                                             */
  /* ---------------------------------------------------------------- */

  load() {
    this._web_settings = _xs.get("xweb");

    this._app = express();
    this._app.use(express.json());
    this._app.use(cors({ origin: true }));

    this._app.use("/public", express.static(this._public_folder));

    this._app.get("/", this.loadHome);

    // 🔴 DO NOT ADD FALLBACK HERE (breaks REST wormholes)
    _xlog.log("Xpell Web Server loaded ✅", this._engine_id);
  }

  /* ---------------------------------------------------------------- */
  /* START                                                            */
  /* ---------------------------------------------------------------- */

  async start() {
    _xlog.log("⚙️ Starting Xpell Web Server...");

    this._web_server = http
      .createServer(this._app)
      .listen(this._web_settings["http-port"], () => {
        _xlog.log(
          `HTTP listening on ${this._web_settings["http-port"]}`
        );
      });

    if (this._web_settings["enable-ssl"]) {
      this._app.use(enforce.HTTPS({ trustProtoHeader: true }));

      const creds = {
        key: fs.readFileSync(this._web_settings["ssl-settings"]["ssl-pk-file"]),
        cert: fs.readFileSync(
          this._web_settings["ssl-settings"]["ssl-cert-file"]
        ),
        ca: fs.readFileSync(
          this._web_settings["ssl-settings"]["ssl-chain-file"]
        ),
      };

      this._secured_web_server = https
        .createServer(creds, this._app)
        .listen(this._web_settings["ssl-settings"]["https-port"], () => {
          _xlog.log(
            `HTTPS listening on ${this._web_settings["ssl-settings"]["https-port"]}`
          );
        });
    }

    if (this._web_settings["enable-wormhole"]) {
      this._installWormholesV2();
    }

    // ✅ SAFE fallback (after wormholes)
    this._app.use((req, res) => res.json({ message: "o||o" }));

    return "Web server started";
  }

  /* ---------------------------------------------------------------- */
  /* WORMHOLES v2                                                     */
  /* ---------------------------------------------------------------- */

  _installWormholesV2() {
    const server = this._secured_web_server ?? this._web_server;
    if (!server) throw new Error("Server not started");

    // REST
    this._app.use(
      createWormholesRestRouter({
        _node: "xnode",
        _xpell: "2.0.0-alpha",
        _caps: ["reqres", "rest"],
        _require_auth: false,
      })
    );

    // WS
    createWormholesWSServer(server, {
      _node: "xnode",
      _xpell: "2.0.0-alpha",
      _path: "/wh/v2",
      _require_auth: false,
      _log_connect: true,
    });

    _xlog.log("Wormholes v2 installed ✅");
  }

  /* ---------------------------------------------------------------- */
  /* HELPERS                                                          */
  /* ---------------------------------------------------------------- */

  loadHome = (_req: any, res: any) => {
    res.send(
      fs.readFileSync(
        path.resolve(this._public_folder, "index.html"),
        "utf-8"
      )
    );
  };
}

export default XWebServer;
