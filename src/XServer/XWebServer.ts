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
import type { Socket } from "node:net";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import enforce from "express-sslify";

import { _x, _xlog } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import { _xs } from "@xpell/node-core";
import {
  createXpellMCPProtectedResourceMetadata,
  ensureXpellMCPSettings,
  getXpellMCPProtectedResourceMetadataPath,
  mountXpellMCPRoute,
  resolveXpellMCPAuthorizationServer,
  resolveXpellMCPRequestOrigin,
} from "@xpell/mcp";
import { fileURLToPath } from "url";
import {
  createWormholesWSServer,
  createWormholesRestRouter,
  whForbidden,
  whUnauthorized,
  type WHAuthPayload,
  type WHAuthResult,
  type WHContext,
  type XCmd,
} from "../Wormholes/wh.index.js";
import {
  DEFAULT_XAPP_DOWNLOAD_CORS_ORIGINS,
  createXAppPackageTransferRouter,
} from "../XAppPackage/XAppDownloadTransfer.js";
import {
  XAUTH_ERR,
  XAUTH_OAUTH_AUTHORIZATION_ENDPOINT,
  XAUTH_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  XAUTH_OAUTH_REVOCATION_ENDPOINT,
  XAUTH_OAUTH_TOKEN_ENDPOINT,
  createXAuthAuthorizationServerMetadata,
  createXAuthOAuthPendingRequest,
  deleteXAuthOAuthPendingRequest,
  XAuthOAuthError,
  isXAuthOAuthError,
  normalizeXAuthOAuthAuthorizeRequest,
  readXAuthOAuthPendingRequest,
  resolveXAuthOAuthClient,
  toOAuthRedirect,
  verify_jwt,
} from "../XAuth/index.js";

declare global {
  namespace Express {
    interface Request {
      /** Exact bytes received by XWebServer's JSON body parser. */
      rawBody?: Buffer;
    }
  }
}

export type XWebRequest = Request;
export type XWebRouteContributor = (app: Express, server: XWebServer) => void;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/* ENV                                                                */
/* ------------------------------------------------------------------ */

const SUPER_USER_KEY = process.env.SUPER_USER_KEY ?? "";
const ENV_NAME = (process.env.ENV_NAME ?? "local").toLowerCase();
const DEFAULT_BOOTSTRAP_ENV = "default";
const ADMIN_BOOTSTRAP_APP_ID = "vibe-system";
const XWEB_JSON_BODY_LIMIT = "10mb";
export const XWEB_AUTH_COOKIE_NAME = "xauth_session";
export const XWEB_ADMIN_CLEARANCE_LEVEL = 100;

const XWEB_ADMIN_PROTECTED_MODULES = new Set([
  "module-creator",
  "studio",
  "xmutator",
  "xvibe",
]);

const XWEB_RUNTIME_AUTH_STUDIO_OPS = new Set([
  "sync-client-skills",
]);

const XWEB_RUNTIME_SKILL_MAX_APP_ID_LENGTH = 120;
const XWEB_RUNTIME_SKILL_MAX_ENV_LENGTH = 120;
const XWEB_RUNTIME_SKILL_MAX_JSON_BYTES = 2_000_000;
const XWEB_RUNTIME_SKILL_MAX_MODULES = 128;
const XWEB_RUNTIME_SKILL_MAX_SKILLS = 512;
const XWEB_RUNTIME_SKILL_MAX_OBJECTS = 1024;
const XWEB_RUNTIME_SKILL_MAX_TOTAL_OBJECTS = 1024;
const XWEB_RUNTIME_SKILL_MAX_TOTAL_RECORDS = 16_384;
const XWEB_RUNTIME_SKILL_MAX_DEPTH = 12;
const XWEB_RUNTIME_SKILL_MAX_ARRAY_LENGTH = 2_048;
const XWEB_RUNTIME_SKILL_MAX_STRING_LENGTH = 16_384;
const XWEB_RUNTIME_SKILL_BLOCKED_KEYS = new Set([
  "_auth",
  "auth",
  "_token",
  "token",
  "authorization",
  "cookie",
  "cookies",
  "_clearance_level",
  "clearance_level",
  "_user_id",
  "user_id",
  "_account_id",
  "account_id",
  "_agent_id",
  "agent_id",
]);

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function handleJsonBodyParserError(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const record =
    isPlainObject(err)
      ? err
      : {};

  const type =
    typeof record.type === "string"
      ? record.type
      : "";

  const status =
    typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : 400;

  const is_json_body_error =
    type === "entity.too.large" ||
    type === "entity.parse.failed" ||
    status === 413;

  if (!is_json_body_error) {
    next(err);
    return;
  }

  const code =
    status === 413
      ? "E_XWEB_REQUEST_TOO_LARGE"
      : "E_XWEB_BAD_JSON";

  const message =
    status === 413
      ? "HTTP JSON body exceeds configured limit"
      : "HTTP JSON body is invalid";

  _xlog.warn("[xweb] json body rejected", {
    _code: code,
    _status: status,
    _method: req.method,
    _path: req.path,
    _content_type: req.headers["content-type"] ?? "",
  });

  res.status(status).json({
    _ok: false,
    _result: {
      _code: code,
      _level: "warn",
      name: "XError",
      message,
      _details: {
        _limit: "http_json_body",
        _configured_limit: XWEB_JSON_BODY_LIMIT,
        _method: req.method,
        _path: req.path,
        _content_type: req.headers["content-type"] ?? "",
      }
    }
  });
}

function preserveRawJsonBody(
  req: http.IncomingMessage,
  _res: http.ServerResponse,
  body: Buffer,
): void {
  (req as Request).rawBody = body;
}

type RuntimeSkillPayloadMetrics = {
  _payload_bytes: number;
  _root_object_count: number;
  _module_object_count: number;
  _object_count: number;
  _module_count: number;
  _root_skill_count: number;
};

function runtimeSkillPayloadMetrics(skills: unknown, json?: string): RuntimeSkillPayloadMetrics {
  const payload = isPlainObject(skills) ? skills : {};
  const modules = Array.isArray(payload._modules) ? payload._modules : [];
  const root_objects = Array.isArray(payload._objects) ? payload._objects : [];
  const root_skills = Array.isArray(payload._skills) ? payload._skills : [];
  let module_object_count = 0;

  for (const module_item of modules) {
    if (isPlainObject(module_item) && Array.isArray(module_item._objects)) {
      module_object_count += module_item._objects.length;
    }
  }

  const serialized = json ?? safeJsonStringify(skills);
  return {
    _payload_bytes: serialized ? Buffer.byteLength(serialized, "utf8") : 0,
    _root_object_count: root_objects.length,
    _module_object_count: module_object_count,
    _object_count: root_objects.length + module_object_count,
    _module_count: modules.length,
    _root_skill_count: root_skills.length,
  };
}

const XWEB_ADMIN_PROTECTED_XAUTH_OPS = new Set([
  "create-mcp-token",
]);

export const XWEB_ADMIN_PROTECTED_SERVER_XVM_OPS = new Set([
  "apply-change-plan-operations",
  "apply-generated-operation",
  "clear-default-app",
  "create-app",
  "create-view",
  "delete-entity",
  "export-app",
  "get-project-memory",
  "import-app",
  "inspect-app-package",
  "list-apps",
  "list-generated-modules",
  "list-trashed-apps",
  "list-views",
  "load-app-from-disk",
  "patch-project-memory",
  "preview-app-import",
  "push-update",
  "reload-app",
  "restore-app",
  "save-project-memory",
  "save-view-json",
  "set-active-app",
  "set-default-app",
  "set-entity",
  "set-flow",
  "trash-app",
  "upload-app-package",
]);

type XWebBootstrapMetadata = {
  _mode: "runtime" | "admin" | "admin-login" | "admin-denied";
  _admin: boolean;
  _app_id?: string | null;
  _env: string;
  _authenticated?: boolean;
  _required_clearance_level?: number;
  _clearance_level?: number;
  _reason?: string;
};

type XWebBootstrapErrorData = {
  _status: number;
  _code: string;
  _message: string;
  _details?: Record<string, unknown>;
};

class XWebBootstrapError extends Error {
  _status: number;
  _code: string;
  _details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "XWebBootstrapError";
    this._status = status;
    this._code = code;
    this._details = details;
  }
}

/* ------------------------------------------------------------------ */
/* SETTINGS                                                           */
/* ------------------------------------------------------------------ */

export type XWebSettings = {
  domain: string;
  /** Optional bind address. Omission preserves Node's existing default binding. */
  "listen-host"?: string;
  "http-port": number;
  "enable-ssl": boolean;
  "enable-wormhole": boolean;
  "xapp-cors-origins": string[];
  "xapp-cors-allow-credentials": boolean;
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
  "xapp-cors-origins": DEFAULT_XAPP_DOWNLOAD_CORS_ORIGINS,
  "xapp-cors-allow-credentials": true,
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
  _routes_handlers: XWebRouteContributor[] = [];
  private _sockets = new Set<Socket>();
  private _owned_servers = new Set<http.Server>();
  private _wormholes_server?: ReturnType<typeof createWormholesWSServer>;
  private _start_promise?: Promise<string>;
  private _stop_promise?: Promise<void>;
  private _stopping = false;

  constructor() { }

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
  private ensureDefaultWebSettings() {
    _xs.ensureDefaults("xweb", DEFAULT_XWEB_SETTINGS);
    ensureXpellMCPSettings();
  }

  onSetup(workFolder = ".work") {
    this.init(workFolder);
    _xu.checkFolders([this._public_folder]);

    this.ensureDefaultWebSettings();

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
    this._web_settings = {
      ...DEFAULT_XWEB_SETTINGS,
      ...(_xs.get("xweb") ?? {}),
      "ssl-settings": {
        ...DEFAULT_XWEB_SETTINGS["ssl-settings"],
        ...((_xs.get("xweb") as any)?.["ssl-settings"] ?? {})
      }
    };
    this._app = express();
    this._app.use(express.json({
      limit: XWEB_JSON_BODY_LIMIT,
      verify: preserveRawJsonBody,
    }));
    this._app.use(express.urlencoded({ extended: false, limit: XWEB_JSON_BODY_LIMIT }));
    this._app.use(handleJsonBodyParserError);
    this._app.use(createXAppPackageTransferRouter({
      _work_folder: this._work_folder,
      _cors_origins: this._web_settings["xapp-cors-origins"],
      _cors_allow_credentials: this._web_settings["xapp-cors-allow-credentials"],
    }));
    this._app.use(cors({ origin: true }));

    this.installAuthRoutes();
    this.installOAuthDiscoveryRoutes();
    this.installBootstrapRoutes();
    this.installMCPRoutes();
    this._app.use(express.static(this._public_folder));
    this._app.use("/public", express.static(this._public_folder));
    _xlog.log("XWeb public folder", this._public_folder);

    this.applyRoutes();

    // 🔴 DO NOT ADD FALLBACK HERE (breaks REST wormholes)
    _xlog.log("Xpell Web Server loaded ✅", this._engine_id);
  }

  useRoutes(handler: XWebRouteContributor) {
    this._routes_handlers.push(handler);
    if (this._app) {
      handler(this._app, this);
    }
  }

  /* ---------------------------------------------------------------- */
  /* START                                                            */
  /* ---------------------------------------------------------------- */

  async start() {
    if (this._stopping) throw new Error("E_XWEB_STOPPED");
    if (this._start_promise) return this._start_promise;
    if (this._web_server?.listening) {
      if (!this._owned_servers.has(this._web_server)) throw new Error("E_XWEB_LISTENER_IN_USE");
      return "Web server started";
    }
    const startup = this.startListeners();
    this._start_promise = startup;
    try { return await startup; }
    finally { this._start_promise = undefined; }
  }

  private async startListeners(): Promise<string> {
    const listen_host = this._web_settings["listen-host"];
    if (listen_host !== undefined && (typeof listen_host !== "string"
      || !listen_host || listen_host.trim() !== listen_host)) {
      throw new TypeError("XWebServer listen-host must be a non-empty hostname or IP address");
    }
    _xlog.log("⚙️ Starting Xpell Web Server...");
    try {
      const handler: http.RequestListener = (req, res) => {
        if (this._stopping) { res.writeHead(503); res.end(); return; }
        this._app(req, res);
      };
      this._web_server = http.createServer(handler);
      this.trackSockets(this._web_server);
      await this.listen(this._web_server, this._web_settings["http-port"], listen_host);
      _xlog.log(`HTTP listening on ${this._web_settings["http-port"]}`);
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

        this._secured_web_server = https.createServer(creds, handler);
        this.trackSockets(this._secured_web_server);
        await this.listen(this._secured_web_server, this._web_settings["ssl-settings"]["https-port"], listen_host);
        _xlog.log(`HTTPS listening on ${this._web_settings["ssl-settings"]["https-port"]}`);
      }

      if (this._web_settings["enable-wormhole"]) {
        this._installWormholesV2();
      }

      // ✅ SAFE fallback (after wormholes)
      this._app.use((req, res) => res.json({ message: "o||o" }));

      return "Web server started";
    } catch (error) {
      this._stopping = true;
      await this.closeListeners();
      throw error;
    }
  }

  private trackSockets(server: http.Server): void {
    this._owned_servers.add(server);
    server.on("connection", (socket: Socket) => {
      if (this._stopping) { socket.destroy(); return; }
      this._sockets.add(socket);
      socket.once("close", () => this._sockets.delete(socket));
    });
  }

  private listen(server: http.Server, port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => {
        server.off("error", failed);
        this._stopping ? reject(new Error("E_XWEB_STOPPED")) : resolve();
      };
      server.once("error", failed); server.once("listening", ready);
      try { server.listen({ port, host }); }
      catch (error) { server.off("error", failed); server.off("listening", ready); reject(error); }
    });
  }

  /** Terminal, idempotent shutdown of this web server's listeners and sockets only. */
  stop(): Promise<void> {
    if (this._stop_promise) return this._stop_promise;
    this._stopping = true;
    this._stop_promise = (async () => {
      await this._start_promise?.catch(() => {});
      await this.closeListeners();
    })();
    return this._stop_promise;
  }

  private async closeListeners(): Promise<void> {
    const servers = [...this._owned_servers];
    const wss = this._wormholes_server; this._wormholes_server = undefined;
    const closing: Promise<void>[] = servers.map(server => new Promise((resolve, reject) => {
      server.close(error => !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING" ? resolve() : reject(error));
      server.closeAllConnections();
    }));
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      closing.push(new Promise(resolve => wss.close(() => resolve())));
    }
    // Includes upgraded sockets, which closeAllConnections deliberately excludes.
    for (const socket of this._sockets) socket.destroy();
    const results = await Promise.allSettled(closing);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), "XWebServer shutdown failed");
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
        _node: this._engine_id,
        _xpell: "2.0.0-alpha",
        _caps: ["reqres", "rest"],
        _require_auth: false,
        _auth_cookie_name: XWEB_AUTH_COOKIE_NAME,
        _auth: (payload, ctx) => this.resolveWormholesAuth(payload, ctx),
        _authorize_req: (cmd, ctx) => this.authorizeWormholesReq(cmd, ctx),
      })
    );

    // WS
    this._wormholes_server = createWormholesWSServer(server, {
      _node: this._engine_id,
      _xpell: "2.0.0-alpha",
      _path: "/wh/v2",
      _require_auth: false,
      _auth_cookie_name: XWEB_AUTH_COOKIE_NAME,
      _auth: (payload, ctx) => this.resolveWormholesAuth(payload, ctx),
      _authorize_req: (cmd, ctx) => this.authorizeWormholesReq(cmd, ctx),
      _log_connect: true,
    });

    _xlog.log("Wormholes v2 installed ✅");
  }

  private installMCPRoutes() {
    const mounted = mountXpellMCPRoute(this._app);
    if (mounted._mounted) {
      _xlog.log("MCP Streamable HTTP route mounted", {
        _path: mounted._path,
        _require_auth: mounted._require_auth,
      });
    }
  }

  private installOAuthDiscoveryRoutes() {
    const initial_mcp_settings = ensureXpellMCPSettings();
    const protected_resource_paths = Array.from(new Set([
      "/.well-known/oauth-protected-resource",
      getXpellMCPProtectedResourceMetadataPath(initial_mcp_settings.path),
    ]));

    for (const route_path of protected_resource_paths) {
      this._app.get(route_path, (req, res) => {
        const mcp_settings = ensureXpellMCPSettings();

        res
          .status(200)
          .setHeader("Cache-Control", "no-store")
          .json(createXpellMCPProtectedResourceMetadata(
            mcp_settings,
            this.toMCPUrlContext(req),
          ));
      });
    }

    this._app.get(XAUTH_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH, (req, res) => {
      const mcp_settings = ensureXpellMCPSettings();
      const origin = resolveXpellMCPRequestOrigin(this.toMCPUrlContext(req));
      const issuer = resolveXpellMCPAuthorizationServer(mcp_settings, origin);

      res
        .status(200)
        .setHeader("Cache-Control", "no-store")
        .json(createXAuthAuthorizationServerMetadata({
          _issuer: issuer,
          _scopes: mcp_settings.scopes_supported,
        }));
    });

    this._app.get(XAUTH_OAUTH_AUTHORIZATION_ENDPOINT, async (req, res) => {
      try {
        const oauth = this.resolveOAuthRouteContext(req);
        const normalized_request = normalizeXAuthOAuthAuthorizeRequest(
          this.readOAuthInput(req.query),
          {
            _resource: oauth._resource,
            _issuer: oauth._issuer,
            _supported_scopes: oauth._scopes,
          },
        );
        const client_request = await resolveXAuthOAuthClient(normalized_request);
        const pending = createXAuthOAuthPendingRequest(client_request);
        const auth = await this.resolveOAuthBrowserAuth(req, res);

        if (!auth) {
          this.renderOAuthLogin(res, pending);
          return;
        }

        this.renderOAuthConsent(res, pending, auth);
      } catch (error) {
        this.sendOAuthAuthorizeError(res, error);
      }
    });

    this._app.post("/oauth/login", async (req, res) => {
      try {
        const body = this.readOAuthInput(req.body);
        const pending = readXAuthOAuthPendingRequest(this.readRequiredFormString(body.request_id, "request_id"));
        const login_result: any = await _x.execute({
          _module: "xauth",
          _op: "login",
          _params: {
            email: this.readRequiredFormString(body.email, "email"),
            password: this.readRequiredFormString(body.password, "password"),
          },
        } as any);
        const token = this.readAuthTokenFromLoginResult(login_result);
        if (!token) {
          throw new XWebBootstrapError(
            500,
            "E_XWEB_AUTH_LOGIN_SESSION_MISSING",
            "xauth login did not return a session token.",
          );
        }
        this.setAuthCookie(res, req, token, this.readAuthSessionExpiry(login_result));
        const auth = await this.resolveOAuthBrowserAuth(req, res, token);
        if (!auth) {
          throw new XWebBootstrapError(401, XAUTH_ERR.UNAUTHORIZED, "Invalid credentials.");
        }
        this.renderOAuthConsent(res, pending, auth);
      } catch (error) {
        this.sendOAuthAuthorizeError(res, error);
      }
    });

    this._app.post("/oauth/authorize/consent", async (req, res) => {
      try {
        const body = this.readOAuthInput(req.body);
        const pending = readXAuthOAuthPendingRequest(this.readRequiredFormString(body.request_id, "request_id"));
        const action = this.readRequiredFormString(body.action, "action");

        if (action !== "authorize") {
          deleteXAuthOAuthPendingRequest(pending.request_id);
          this.redirectOAuth(res, toOAuthRedirect(pending.redirect_uri, {
            error: "access_denied",
            error_description: "The authorization request was cancelled.",
            state: pending.state,
            iss: pending.issuer,
          }));
          return;
        }

        const auth = await this.resolveOAuthBrowserAuth(req, res);
        if (!auth) {
          this.renderOAuthLogin(res, pending);
          return;
        }

        const code_result: any = await _x.execute({
          _module: "xauth",
          _op: "create-oauth-authorization-code",
          _params: {
            client_id: pending.client_id,
            redirect_uri: pending.redirect_uri,
            resource: pending.resource,
            scopes: pending.scopes,
            code_challenge: pending.code_challenge,
            code_challenge_method: pending.code_challenge_method,
            issuer: pending.issuer,
          },
          _ctx: {
            _source: "oauth",
            _route: "/oauth/authorize/consent",
            _auth: auth,
          },
        } as any);
        deleteXAuthOAuthPendingRequest(pending.request_id);
        this.redirectOAuth(res, toOAuthRedirect(pending.redirect_uri, {
          code: typeof code_result?._code === "string" ? code_result._code : "",
          state: pending.state,
          iss: pending.issuer,
        }));
      } catch (error) {
        this.sendOAuthAuthorizeError(res, error);
      }
    });

    this._app.post(XAUTH_OAUTH_TOKEN_ENDPOINT, async (req, res) => {
      try {
        const body = this.readOAuthInput(req.body);
        const token_result = await _x.execute({
          _module: "xauth",
          _op: "exchange-oauth-authorization-code",
          _params: {
            grant_type: body.grant_type,
            code: body.code,
            refresh_token: body.refresh_token,
            client_id: body.client_id,
            redirect_uri: body.redirect_uri,
            resource: body.resource,
            code_verifier: body.code_verifier,
            scope: body.scope,
          },
          _ctx: {
            _source: "oauth",
            _route: XAUTH_OAUTH_TOKEN_ENDPOINT,
          },
        } as any);

        res
          .status(200)
          .setHeader("Cache-Control", "no-store")
          .setHeader("Pragma", "no-cache")
          .json(token_result);
      } catch (error) {
        this.sendOAuthJsonError(res, error);
      }
    });

    this._app.post(XAUTH_OAUTH_REVOCATION_ENDPOINT, async (req, res) => {
      try {
        const body = this.readOAuthInput(req.body);
        await _x.execute({
          _module: "xauth",
          _op: "revoke-oauth-token",
          _params: {
            token: body.token,
            token_type_hint: body.token_type_hint,
            client_id: body.client_id,
            resource: body.resource,
          },
          _ctx: {
            _source: "oauth",
            _route: XAUTH_OAUTH_REVOCATION_ENDPOINT,
          },
        } as any);

        res
          .status(200)
          .setHeader("Cache-Control", "no-store")
          .setHeader("Pragma", "no-cache")
          .json({ _ok: true });
      } catch (error) {
        this.sendOAuthJsonError(res, error);
      }
    });
  }

  private toMCPUrlContext(req: express.Request) {
    return {
      headers: req.headers as Record<string, string | string[] | undefined>,
      protocol: req.protocol,
      secure: req.secure,
    };
  }

  private resolveOAuthRouteContext(req: express.Request) {
    const mcp_settings = ensureXpellMCPSettings();
    const origin = resolveXpellMCPRequestOrigin(this.toMCPUrlContext(req));
    const issuer = resolveXpellMCPAuthorizationServer(mcp_settings, origin);
    return {
      _settings: mcp_settings,
      _origin: origin,
      _issuer: issuer,
      _resource: createXpellMCPProtectedResourceMetadata(
        mcp_settings,
        this.toMCPUrlContext(req),
      ).resource,
      _scopes: mcp_settings.scopes_supported,
    };
  }

  private async resolveOAuthBrowserAuth(
    req: express.Request,
    res: express.Response,
    token_override?: string,
  ): Promise<Record<string, unknown> | null> {
    const session_token = token_override ?? this.readCookie(req, XWEB_AUTH_COOKIE_NAME);
    if (!session_token) return null;

    try {
      const auth: any = await _x.execute({
        _module: "xauth",
        _op: "authorize_req",
        _params: {
          _ctx: {
            _source: "oauth",
            _route: req.path,
            _meta: {
              _token: session_token,
            },
          },
          _token: session_token,
        },
      } as any);

      return auth?._authenticated === true ? auth : null;
    } catch {
      this.clearAuthCookie(res, req);
      return null;
    }
  }

  private readOAuthInput(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      const selected = Array.isArray(item) ? item[0] : item;
      if (typeof selected === "string") out[key] = selected;
    }
    return out;
  }

  private readRequiredFormString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new XAuthOAuthError("invalid_request", `Missing ${field}.`);
    }
    return value.trim();
  }

  private renderOAuthLogin(res: express.Response, pending: {
    request_id: string;
    client_name: string;
    scope: string;
    resource: string;
  }): void {
    this.sendOAuthHtml(res, this.renderOAuthPageShell({
      _title: "Xpell Authorization",
      _heading: "Sign in to Xpell",
      _lead: `${pending.client_name} is requesting access to ${pending.resource}.`,
      _body: [
        this.renderOAuthDetailRows([
          ["Client", pending.client_name],
          ["Resource", pending.resource],
        ]),
        "<form class=\"xoauth-form\" method=\"post\" action=\"/oauth/login\">",
        `<input type=\"hidden\" name=\"request_id\" value=\"${escapeHtml(pending.request_id)}\">`,
        "<label class=\"xoauth-field\"><span>Email</span><input name=\"email\" type=\"email\" autocomplete=\"username\" required></label>",
        "<label class=\"xoauth-field\"><span>Password</span><input name=\"password\" type=\"password\" autocomplete=\"current-password\" required></label>",
        "<div class=\"xoauth-actions\">",
        "<button class=\"xoauth-button xoauth-button-primary\" type=\"submit\">Continue</button>",
        "</div>",
        "</form>",
      ].join(""),
    }));
  }

  private renderOAuthConsent(
    res: express.Response,
    pending: {
      request_id: string;
      client_name: string;
      scope: string;
      resource: string;
    },
    auth: Record<string, unknown>,
  ): void {
    const user_id = typeof auth._user_id === "string" ? auth._user_id : "authenticated user";
    this.sendOAuthHtml(res, this.renderOAuthPageShell({
      _title: "Authorize Xpell MCP",
      _heading: "Authorize Xpell MCP",
      _lead: "Review the connection request before granting access.",
      _body: [
        this.renderOAuthDetailRows([
          ["Signed in as", user_id],
          ["Client", pending.client_name],
          ["Resource", pending.resource],
        ]),
        this.renderOAuthScopes(pending.scope),
        "<form class=\"xoauth-actions\" method=\"post\" action=\"/oauth/authorize/consent\">",
        `<input type=\"hidden\" name=\"request_id\" value=\"${escapeHtml(pending.request_id)}\">`,
        "<button class=\"xoauth-button xoauth-button-primary\" type=\"submit\" name=\"action\" value=\"authorize\">Authorize</button>",
        "<button class=\"xoauth-button xoauth-button-secondary\" type=\"submit\" name=\"action\" value=\"cancel\">Cancel</button>",
        "</form>",
      ].join(""),
    }));
  }

  private renderOAuthPageShell(input: {
    _title: string;
    _heading: string;
    _lead: string;
    _body: string;
  }): string {
    return [
      "<!doctype html>",
      `<html lang=\"en\" data-theme=\"dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>${escapeHtml(input._title)}</title>`,
      "<style>",
      ":root{color-scheme:dark;--x-bg:#0f1115;--x-bg-muted:#12161d;--x-surface:#16191f;--x-surface-2:#1d222b;--x-card:#1a2028;--x-panel:#151922;--x-input:#1b2029;--x-text:#f2f5f8;--x-text-muted:#9aa5b1;--x-text-subtle:#7d8796;--x-text-inverse:#0f1115;--x-primary:#55b98f;--x-accent:#55b98f;--x-focus:#78d6ad;--x-border:rgba(222,228,235,.10);--x-border-subtle:rgba(222,228,235,.075);--x-border-strong:rgba(222,228,235,.18);--x-font-sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;--x-font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",monospace;--x-radius-sm:4px;--x-radius-md:6px;--x-radius-lg:8px;--x-shadow-lg:0 24px 64px rgba(0,0,0,.32)}",
      "*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{font-family:var(--x-font-sans);line-height:1.45;background:radial-gradient(circle at top,rgba(85,185,143,.14),transparent 34%),linear-gradient(135deg,#080a0d 0%,var(--x-bg) 48%,#111820 100%);color:var(--x-text);display:grid;place-items:center;padding:32px 16px}",
      ".xoauth-shell{width:min(100%,520px)}.xoauth-brand{display:flex;align-items:center;gap:12px;margin:0 0 18px;color:var(--x-text)}.xoauth-mark{width:40px;height:40px;border:1px solid rgba(85,185,143,.32);border-radius:8px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(85,185,143,.20),rgba(29,34,43,.92));box-shadow:0 0 0 1px rgba(255,255,255,.04) inset;color:var(--x-accent);font-weight:800;font-size:21px;letter-spacing:0}.xoauth-wordmark{display:flex;flex-direction:column;gap:1px}.xoauth-wordmark strong{font-size:15px;letter-spacing:0}.xoauth-wordmark span{font-size:12px;color:var(--x-text-muted)}",
      ".xoauth-card{border:1px solid var(--x-border-strong);border-radius:8px;background:linear-gradient(180deg,rgba(26,32,40,.96),rgba(21,25,34,.96));box-shadow:var(--x-shadow-lg);padding:28px}.xoauth-kicker{margin:0 0 8px;color:var(--x-accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0}.xoauth-card h1{margin:0;color:var(--x-text);font-size:28px;line-height:1.14;font-weight:750;letter-spacing:0}.xoauth-lead{margin:12px 0 22px;color:var(--x-text-muted);font-size:14px}",
      ".xoauth-details{display:grid;gap:10px;margin:0 0 22px;padding:14px;border:1px solid var(--x-border);border-radius:8px;background:rgba(15,17,21,.42)}.xoauth-row{display:grid;grid-template-columns:116px minmax(0,1fr);gap:12px;align-items:start}.xoauth-label{color:var(--x-text-subtle);font-size:12px;font-weight:650}.xoauth-value{min-width:0;color:var(--x-text);font-size:13px;overflow-wrap:anywhere}.xoauth-scopes{margin:0 0 22px}.xoauth-scopes-title{margin:0 0 10px;color:var(--x-text-subtle);font-size:12px;font-weight:650}.xoauth-scope-list{display:flex;flex-wrap:wrap;gap:8px}.xoauth-scope{border:1px solid rgba(85,185,143,.24);border-radius:999px;background:rgba(85,185,143,.10);color:#b8f3d8;font-family:var(--x-font-mono);font-size:12px;line-height:1;padding:7px 9px}",
      ".xoauth-form{display:grid;gap:14px}.xoauth-field{display:grid;gap:7px;color:var(--x-text-muted);font-size:12px;font-weight:650}.xoauth-field input{width:100%;height:42px;border:1px solid var(--x-border-strong);border-radius:6px;background:var(--x-input);color:var(--x-text);font:inherit;font-size:14px;padding:0 12px;outline:none}.xoauth-field input:focus{border-color:var(--x-focus);box-shadow:0 0 0 3px rgba(120,214,173,.18)}.xoauth-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:4px}.xoauth-button{min-height:40px;border-radius:6px;padding:0 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer}.xoauth-button-primary{border:1px solid rgba(120,214,173,.48);background:linear-gradient(180deg,#63c79a,#3f9f78);color:#06100b}.xoauth-button-primary:hover{filter:brightness(1.06)}.xoauth-button-secondary{border:1px solid var(--x-border-strong);background:rgba(255,255,255,.025);color:var(--x-text-muted)}.xoauth-button-secondary:hover{border-color:rgba(222,228,235,.28);color:var(--x-text)}",
      "@media(max-width:520px){body{padding:18px 12px;place-items:start center}.xoauth-card{padding:22px}.xoauth-card h1{font-size:24px}.xoauth-row{grid-template-columns:1fr;gap:3px}.xoauth-actions{display:grid;grid-template-columns:1fr}.xoauth-button{width:100%}}",
      "</style></head>",
      "<body>",
      "<main class=\"xoauth-shell\">",
      "<div class=\"xoauth-brand\" aria-label=\"Xpell MCP\">",
      "<div class=\"xoauth-mark\" aria-hidden=\"true\">X</div>",
      "<div class=\"xoauth-wordmark\"><strong>Xpell</strong><span>MCP authorization</span></div>",
      "</div>",
      "<section class=\"xoauth-card\">",
      "<p class=\"xoauth-kicker\">Secure connection</p>",
      `<h1>${escapeHtml(input._heading)}</h1>`,
      `<p class=\"xoauth-lead\">${escapeHtml(input._lead)}</p>`,
      input._body,
      "</section>",
      "</main>",
      "</body></html>",
    ].join("");
  }

  private renderOAuthDetailRows(rows: Array<[string, string]>): string {
    return [
      "<div class=\"xoauth-details\">",
      ...rows.map(([label, value]) => [
        "<div class=\"xoauth-row\">",
        `<div class=\"xoauth-label\">${escapeHtml(label)}</div>`,
        `<div class=\"xoauth-value\">${escapeHtml(value)}</div>`,
        "</div>",
      ].join("")),
      "</div>",
    ].join("");
  }

  private renderOAuthScopes(scope: string): string {
    const scopes = scope.split(/\s+/).filter(Boolean);
    return [
      "<section class=\"xoauth-scopes\">",
      "<p class=\"xoauth-scopes-title\">Scopes</p>",
      `<div class=\"xoauth-scope-list\" aria-label=\"Scopes: ${escapeHtml(scope)}\">`,
      ...scopes.map((item) => `<span class=\"xoauth-scope\">${escapeHtml(item)}</span>`),
      "</div>",
      "</section>",
    ].join("");
  }

  private sendOAuthHtml(res: express.Response, html: string): void {
    res
      .status(200)
      .setHeader("Cache-Control", "no-store")
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(html);
  }

  private redirectOAuth(res: express.Response, location: string): void {
    res
      .status(302)
      .setHeader("Cache-Control", "no-store")
      .setHeader("Location", location)
      .end();
  }

  private sendOAuthAuthorizeError(res: express.Response, error: unknown): void {
    const normalized = this.normalizeOAuthHttpError(error);
    res
      .status(normalized._status)
      .setHeader("Cache-Control", "no-store")
      .json({
        error: normalized._code,
        error_description: normalized._message,
      });
  }

  private sendOAuthJsonError(res: express.Response, error: unknown): void {
    const normalized = this.normalizeOAuthHttpError(error);
    res
      .status(normalized._status)
      .setHeader("Cache-Control", "no-store")
      .setHeader("Pragma", "no-cache")
      .json({
        error: normalized._code,
        error_description: normalized._message,
      });
  }

  private normalizeOAuthHttpError(error: unknown): XWebBootstrapErrorData {
    if (isXAuthOAuthError(error)) {
      return {
        _status: error._status,
        _code: error._error,
        _message: error.message,
      };
    }

    if (error instanceof XWebBootstrapError) {
      return {
        _status: error._status,
        _code: error._code,
        _message: error.message,
      };
    }

    return {
      _status: 400,
      _code: "invalid_request",
      _message: "Invalid OAuth request.",
    };
  }

  /* ---------------------------------------------------------------- */
  /* HELPERS                                                          */
  /* ---------------------------------------------------------------- */

  private async resolveWormholesAuth(
    payload: WHAuthPayload,
    ctx: WHContext,
  ): Promise<WHAuthResult> {
    const token = typeof payload?._token === "string" && payload._token.trim()
      ? payload._token.trim()
      : typeof ctx?._meta?._token === "string" && ctx._meta._token.trim()
        ? ctx._meta._token.trim()
        : "";

    if (!token) {
      return { _authenticated: false };
    }

    try {
      const auth: any = await _x.execute({
        _module: "xauth",
        _op: "authorize_req",
        _params: {
          _ctx: ctx,
          _token: token,
        },
      } as any);

      if (auth?._authenticated !== true) {
        return { _authenticated: false };
      }

      return {
        _authenticated: true,
        _clearance_level: typeof auth._clearance_level === "number"
          ? auth._clearance_level
          : 0,
        _user_id: typeof auth._user_id === "string" ? auth._user_id : undefined,
        _account_id: typeof auth._account_id === "string" ? auth._account_id : undefined,
        _agent_id: typeof auth._agent_id === "string" ? auth._agent_id : undefined,
        _auth_type: typeof auth._auth_type === "string" ? auth._auth_type : undefined,
      };
    } catch (error) {
      _xlog.warn("[wormholes] auth resolution failed", {
        _code: this.readErrorCode(error) ?? "E_XWEB_WH_AUTH_RESOLVE_FAILED",
      });
      return { _authenticated: false };
    }
  }

  private authorizeWormholesReq(cmd: XCmd, ctx: WHContext): void {
    if (this.isRuntimeStudioWormholesOp(cmd)) {
      this.authorizeRuntimeStudioReq(cmd, ctx);
      return;
    }

    if (!this.isAdminProtectedWormholesOp(cmd)) return;

    const auth = ctx?._auth;
    const authenticated = auth?._authenticated === true;
    const clearance_level = typeof auth?._clearance_level === "number"
      ? auth._clearance_level
      : 0;
    const module_name = normalizePolicyName(cmd._module);
    const op_name = normalizePolicyName(cmd._op);

    if (!authenticated) {
      _xlog.warn("[wormholes] admin op denied", {
        _module: module_name,
        _op: op_name,
        _authenticated: false,
        _clearance_level: 0,
      });
      throw whUnauthorized("Admin authentication required", {
        _module: module_name,
        _op: op_name,
      });
    }

    if (clearance_level < XWEB_ADMIN_CLEARANCE_LEVEL) {
      _xlog.warn("[wormholes] admin op denied", {
        _module: module_name,
        _op: op_name,
        _authenticated: true,
        _clearance_level: clearance_level,
      });
      throw whForbidden("Admin clearance required", {
        _module: module_name,
        _op: op_name,
        _required_clearance_level: XWEB_ADMIN_CLEARANCE_LEVEL,
      });
    }
  }

  private isAdminProtectedWormholesOp(cmd: XCmd): boolean {
    const module_name = normalizePolicyName(cmd?._module);
    const op_name = normalizePolicyName(cmd?._op);

    if (module_name === "xauth") {
      return XWEB_ADMIN_PROTECTED_XAUTH_OPS.has(op_name);
    }

    if (module_name === "server-xvm") {
      return XWEB_ADMIN_PROTECTED_SERVER_XVM_OPS.has(op_name);
    }

    return XWEB_ADMIN_PROTECTED_MODULES.has(module_name);
  }

  private isRuntimeStudioWormholesOp(cmd: XCmd): boolean {
    const module_name = normalizePolicyName(cmd?._module);
    const op_name = normalizePolicyName(cmd?._op);
    return module_name === "studio" && XWEB_RUNTIME_AUTH_STUDIO_OPS.has(op_name);
  }

  private authorizeRuntimeStudioReq(cmd: XCmd, ctx: WHContext): void {
    const module_name = normalizePolicyName(cmd?._module);
    const op_name = normalizePolicyName(cmd?._op);
    const auth = ctx?._auth;
    const authenticated = auth?._authenticated === true;
    const clearance_level = typeof auth?._clearance_level === "number"
      ? auth._clearance_level
      : 0;

    if (!authenticated) {
      _xlog.warn("[wormholes] runtime studio op denied", {
        _module: module_name,
        _op: op_name,
        _authenticated: false,
        _clearance_level: 0,
      });
      throw whUnauthorized("Authenticated runtime connection required", {
        _module: module_name,
        _op: op_name,
      });
    }

    const params = isPlainObject(cmd?._params) ? cmd._params : {};
    const app_id = this.readRuntimeSkillBoundedString(
      params._app_id,
      "_app_id",
      XWEB_RUNTIME_SKILL_MAX_APP_ID_LENGTH,
      module_name,
      op_name,
    );
    const env = this.readRuntimeSkillBoundedString(
      params._env,
      "_env",
      XWEB_RUNTIME_SKILL_MAX_ENV_LENGTH,
      module_name,
      op_name,
    );
    const mode = typeof params._mode === "string" ? params._mode.trim() : "";
    if (mode !== "runtime") {
      throw whForbidden("Runtime skill sync requires runtime mode", {
        _module: module_name,
        _op: op_name,
        _mode: mode || null,
      });
    }

    const meta = ctx?._meta as (WHContext["_meta"] & { _app_id?: string; _env?: string }) | undefined;
    if (!meta?._wid || meta._app_id !== app_id || meta._env !== env) {
      _xlog.warn("[wormholes] runtime studio op scope denied", {
        _module: module_name,
        _op: op_name,
        _authenticated: true,
        _clearance_level: clearance_level,
        _app_id: app_id,
        _env: env,
        _subscribed_app_id: meta?._app_id,
        _subscribed_env: meta?._env,
      });
      throw whForbidden("Runtime skill sync scope must match active subscription", {
        _module: module_name,
        _op: op_name,
        _app_id: app_id,
        _env: env,
      });
    }

    this.validateRuntimeSkillPayload(params._skills, module_name, op_name);
  }

  private readRuntimeSkillBoundedString(
    value: unknown,
    field_name: string,
    max_length: number,
    module_name: string,
    op_name: string,
  ): string {
    if (typeof value !== "string") {
      throw whForbidden("Invalid runtime skill sync request", {
        _module: module_name,
        _op: op_name,
        _field: field_name,
      });
    }
    const out = value.trim();
    if (!out || out.length > max_length) {
      throw whForbidden("Invalid runtime skill sync request", {
        _module: module_name,
        _op: op_name,
        _field: field_name,
      });
    }
    return out;
  }

  private validateRuntimeSkillPayload(skills: unknown, module_name: string, op_name: string): void {
    if (!isPlainObject(skills)) {
      throw whForbidden("Invalid runtime skill payload", {
        _module: module_name,
        _op: op_name,
        _field: "_skills",
      });
    }

    const json = safeJsonStringify(skills);
    const metrics = runtimeSkillPayloadMetrics(skills, json);
    if (!json || metrics._payload_bytes > XWEB_RUNTIME_SKILL_MAX_JSON_BYTES) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        metrics,
        "max_json_bytes",
        XWEB_RUNTIME_SKILL_MAX_JSON_BYTES,
      );
    }

    const modules = skills._modules;
    const root_skills = skills._skills;
    const root_objects = skills._objects;
    if (!Array.isArray(modules) || !Array.isArray(root_skills) || !Array.isArray(root_objects)) {
      throw whForbidden("Invalid compact runtime skill payload", {
        _module: module_name,
        _op: op_name,
      });
    }
    if (modules.length > XWEB_RUNTIME_SKILL_MAX_MODULES) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        metrics,
        "max_modules",
        XWEB_RUNTIME_SKILL_MAX_MODULES,
      );
    }
    if (root_skills.length > XWEB_RUNTIME_SKILL_MAX_SKILLS) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        metrics,
        "max_root_skills",
        XWEB_RUNTIME_SKILL_MAX_SKILLS,
      );
    }
    if (root_objects.length > XWEB_RUNTIME_SKILL_MAX_OBJECTS) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        metrics,
        "max_root_objects",
        XWEB_RUNTIME_SKILL_MAX_OBJECTS,
      );
    }
    if (metrics._object_count > XWEB_RUNTIME_SKILL_MAX_TOTAL_OBJECTS) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        metrics,
        "max_total_objects",
        XWEB_RUNTIME_SKILL_MAX_TOTAL_OBJECTS,
      );
    }

    const counts = this.validateRuntimeSkillJsonValue(skills, {
      _depth: 0,
      _records: 0,
      _module: module_name,
      _op: op_name,
      _metrics: metrics,
    });
    if (counts._records > XWEB_RUNTIME_SKILL_MAX_TOTAL_RECORDS) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too large",
        module_name,
        op_name,
        { ...metrics, _record_count: counts._records },
        "max_total_records",
        XWEB_RUNTIME_SKILL_MAX_TOTAL_RECORDS,
      );
    }
  }

  private rejectRuntimeSkillPayload(
    message: string,
    module_name: string,
    op_name: string,
    metrics: RuntimeSkillPayloadMetrics & { _record_count?: number },
    limit_name: string,
    configured_limit: number,
    extra: Record<string, unknown> = {},
  ): never {
    const details = {
      _module: module_name,
      _op: op_name,
      ...metrics,
      _limit: limit_name,
      _configured_limit: configured_limit,
      ...extra,
    };
    _xlog.warn("[wormholes] runtime skill payload rejected", details);
    throw whForbidden(message, details);
  }

  private validateRuntimeSkillJsonValue(
    value: unknown,
    state: {
      _depth: number;
      _records: number;
      _module: string;
      _op: string;
      _metrics: RuntimeSkillPayloadMetrics;
    },
  ): { _records: number } {
    if (state._depth > XWEB_RUNTIME_SKILL_MAX_DEPTH) {
      this.rejectRuntimeSkillPayload(
        "Runtime skill payload too deep",
        state._module,
        state._op,
        state._metrics,
        "max_depth",
        XWEB_RUNTIME_SKILL_MAX_DEPTH,
        { _depth: state._depth },
      );
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        this.rejectRuntimeSkillPayload(
          "Invalid runtime skill payload value",
          state._module,
          state._op,
          state._metrics,
          "json_value",
          0,
        );
      }
      return { _records: state._records };
    }

    if (typeof value === "string") {
      if (value.length > XWEB_RUNTIME_SKILL_MAX_STRING_LENGTH) {
        this.rejectRuntimeSkillPayload(
          "Runtime skill payload string too large",
          state._module,
          state._op,
          state._metrics,
          "max_string_length",
          XWEB_RUNTIME_SKILL_MAX_STRING_LENGTH,
          { _string_length: value.length },
        );
      }
      return { _records: state._records };
    }

    if (Array.isArray(value)) {
      if (value.length > XWEB_RUNTIME_SKILL_MAX_ARRAY_LENGTH) {
        this.rejectRuntimeSkillPayload(
          "Runtime skill payload array too large",
          state._module,
          state._op,
          state._metrics,
          "max_array_length",
          XWEB_RUNTIME_SKILL_MAX_ARRAY_LENGTH,
          { _array_length: value.length },
        );
      }
      let records = state._records;
      for (const item of value) {
        records = this.validateRuntimeSkillJsonValue(item, {
          ...state,
          _depth: state._depth + 1,
          _records: records,
        })._records;
      }
      return { _records: records };
    }

    if (!isPlainObject(value)) {
      this.rejectRuntimeSkillPayload(
        "Invalid runtime skill payload value",
        state._module,
        state._op,
        state._metrics,
        "json_value",
        0,
      );
    }

    let records = state._records + 1;
    for (const [key, nested] of Object.entries(value)) {
      if (XWEB_RUNTIME_SKILL_BLOCKED_KEYS.has(key.toLowerCase())) {
        this.rejectRuntimeSkillPayload(
          "Runtime skill payload contains disallowed field",
          state._module,
          state._op,
          state._metrics,
          "blocked_key",
          0,
          { _field: key },
        );
      }
      records = this.validateRuntimeSkillJsonValue(nested, {
        ...state,
        _depth: state._depth + 1,
        _records: records,
      })._records;
      if (records > XWEB_RUNTIME_SKILL_MAX_TOTAL_RECORDS) break;
    }
    return { _records: records };
  }

  private installAuthRoutes() {
    this._app.post("/xauth/login", async (req, res) => {
      try {
        const body = isRecord(req.body) ? req.body : {};
        const email = typeof body.email === "string" ? body.email : "";
        const password = typeof body.password === "string" ? body.password : "";

        const login_result: any = await _x.execute({
          _module: "xauth",
          _op: "login",
          _params: {
            email,
            password,
          },
        } as any);

        if (login_result?._ok !== true) {
          throw new XWebBootstrapError(
            401,
            this.readErrorCode(login_result) ?? XAUTH_ERR.INVALID_CREDENTIALS,
            "Invalid credentials.",
          );
        }

        const token = this.readAuthTokenFromLoginResult(login_result);
        if (!token) {
          throw new XWebBootstrapError(
            500,
            "E_XWEB_AUTH_LOGIN_SESSION_MISSING",
            "xauth login did not return a session token.",
          );
        }

        this.setAuthCookie(
          res,
          req,
          token,
          this.readAuthSessionExpiry(login_result),
        );

        res
          .status(200)
          .setHeader("Cache-Control", "no-store")
          .json(this.toSafeHttpAuthResult(login_result));
      } catch (error) {
        const normalized = this.normalizeAuthHttpError(error);
        this.clearAuthCookie(res, req);
        res
          .status(normalized._status)
          .setHeader("Cache-Control", "no-store")
          .json({
            _ok: false,
            _result: {
              _code: normalized._code,
              _message: normalized._message,
            },
          });
      }
    });

    this._app.post("/xauth/logout", (req, res) => {
      this.clearAuthCookie(res, req);
      res
        .status(200)
        .setHeader("Cache-Control", "no-store")
        .json({ _ok: true });
    });

    this._app.post("/xauth/mcp-token", async (req, res) => {
      try {
        const session_token = this.readCookie(req, XWEB_AUTH_COOKIE_NAME);
        if (!session_token) {
          throw new XWebBootstrapError(
            401,
            XAUTH_ERR.UNAUTHORIZED,
            "Admin authentication required.",
          );
        }

        const auth: any = await _x.execute({
          _module: "xauth",
          _op: "authorize_req",
          _params: {
            _ctx: {
              _source: "xweb",
              _route: "/xauth/mcp-token",
              _meta: {
                _token: session_token,
              },
            },
            _token: session_token,
          },
        } as any);

        if (auth?._authenticated !== true) {
          throw new XWebBootstrapError(
            401,
            XAUTH_ERR.UNAUTHORIZED,
            "Admin authentication required.",
          );
        }

        const clearance_level = typeof auth._clearance_level === "number"
          ? auth._clearance_level
          : 0;

        if (clearance_level < XWEB_ADMIN_CLEARANCE_LEVEL) {
          throw new XWebBootstrapError(
            403,
            "E_XAUTH_ADMIN_CLEARANCE_REQUIRED",
            "Admin clearance required.",
            {
              _required_clearance_level: XWEB_ADMIN_CLEARANCE_LEVEL,
              _clearance_level: clearance_level,
            },
          );
        }

        const token_result: any = await _x.execute({
          _module: "xauth",
          _op: "create-mcp-token",
          _params: {},
          _ctx: {
            _source: "xweb",
            _route: "/xauth/mcp-token",
            _auth: auth,
          },
        } as any);

        res
          .status(200)
          .setHeader("Cache-Control", "no-store")
          .json({
            _ok: true,
            _token: typeof token_result?._token === "string" ? token_result._token : "",
            _expires_at: token_result?._expires_at,
            _clearance_level: token_result?._clearance_level,
          });
      } catch (error) {
        const normalized = this.normalizeMcpTokenHttpError(error);
        if (normalized._status === 401) {
          this.clearAuthCookie(res, req);
        }

        res
          .status(normalized._status)
          .setHeader("Cache-Control", "no-store")
          .json({
            _ok: false,
            _result: {
              _code: normalized._code,
              _message: normalized._message,
            },
          });
      }
    });
  }

  private installBootstrapRoutes() {
    this._app.get("/", async (_req, res) => {
      try {
        const bootstrap = await this.resolveRuntimeBootstrap(DEFAULT_BOOTSTRAP_ENV);
        this.sendBootstrappedIndex(res, bootstrap);
      } catch (error) {
        this.sendBootstrapError(res, error);
      }
    });

    this._app.get(["/admin", "/admin/"], async (req, res) => {
      try {
        const bootstrap = await this.resolveAdminBootstrap(DEFAULT_BOOTSTRAP_ENV, req, res);
        this.sendBootstrappedIndex(res, bootstrap);
      } catch (error) {
        this.sendBootstrapError(res, error);
      }
    });
  }

  private resolveAdminCookieAuth(req: express.Request): {
    _authenticated: boolean;
    _clearance_level: number;
    _reason: string;
    _clear_cookie?: boolean;
  } {
    const token = this.readCookie(req, XWEB_AUTH_COOKIE_NAME);
    if (!token) {
      return {
        _authenticated: false,
        _clearance_level: 0,
        _reason: "missing_session",
      };
    }

    try {
      const payload = verify_jwt(token);
      return {
        _authenticated: true,
        _clearance_level: payload._clearance_level,
        _reason: "authenticated",
      };
    } catch (error) {
      return {
        _authenticated: false,
        _clearance_level: 0,
        _reason: this.readErrorMessage(error) === "Token expired"
          ? "expired_session"
          : "invalid_session",
        _clear_cookie: true,
      };
    }
  }

  private readCookie(req: express.Request, name: string): string | null {
    const header = req.headers.cookie;
    if (typeof header !== "string" || !header.trim()) return null;

    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;

      const key = part.slice(0, separator).trim();
      if (key !== name) continue;

      const raw = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }

    return null;
  }

  private setAuthCookie(
    res: express.Response,
    req: express.Request,
    token: string,
    expires_at?: number,
  ) {
    res.cookie(XWEB_AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.shouldUseSecureCookie(req),
      sameSite: "lax",
      path: "/",
      ...(typeof expires_at === "number"
        ? { maxAge: Math.max(0, expires_at * 1000 - Date.now()) }
        : {}),
    });
  }

  private clearAuthCookie(res: express.Response, req: express.Request) {
    res.clearCookie(XWEB_AUTH_COOKIE_NAME, {
      httpOnly: true,
      secure: this.shouldUseSecureCookie(req),
      sameSite: "lax",
      path: "/",
    });
  }

  private shouldUseSecureCookie(req: express.Request): boolean {
    const forwarded_proto = req.headers["x-forwarded-proto"];
    const is_forwarded_https = typeof forwarded_proto === "string" &&
      forwarded_proto.split(",").map((item) => item.trim()).includes("https");

    return (
      this._web_settings?.["enable-ssl"] === true ||
      req.secure === true ||
      is_forwarded_https ||
      process.env.NODE_ENV === "production" ||
      process.env.XPELL_ENV === "production" ||
      process.env.XNODE_ENV === "production"
    );
  }

  private readAuthTokenFromLoginResult(login_result: any): string {
    const token = typeof login_result?._session?._token === "string"
      ? login_result._session._token
      : typeof login_result?._token === "string"
        ? login_result._token
        : "";

    return token.trim();
  }

  private readAuthSessionExpiry(login_result: any): number | undefined {
    return typeof login_result?._session?._expires_at === "number"
      ? login_result._session._expires_at
      : undefined;
  }

  private toSafeHttpAuthResult(login_result: any) {
    const session = isRecord(login_result?._session)
      ? { ...login_result._session }
      : {};
    delete (session as any)._token;

    return {
      _ok: true,
      _authenticated: login_result?._authenticated === true,
      _user: login_result?._user ?? session._user ?? null,
      _account: login_result?._account ?? session._account ?? null,
      _session: session,
    };
  }

  private normalizeAuthHttpError(error: unknown): XWebBootstrapErrorData {
    const normalized = this.normalizeBootstrapError(error);
    const code = normalized._code;
    if (
      code === XAUTH_ERR.INVALID_CREDENTIALS ||
      code === XAUTH_ERR.UNAUTHORIZED ||
      code === XAUTH_ERR.INVALID_TOKEN
    ) {
      return {
        _status: 401,
        _code: code,
        _message: code === XAUTH_ERR.INVALID_CREDENTIALS
          ? "Invalid credentials."
          : "Unauthorized.",
      };
    }

    return normalized;
  }

  private normalizeMcpTokenHttpError(error: unknown): XWebBootstrapErrorData {
    const normalized = this.normalizeBootstrapError(error);
    const code = normalized._code;

    if (normalized._status === 403 || code === "E_XAUTH_ADMIN_CLEARANCE_REQUIRED") {
      return {
        _status: 403,
        _code: "E_XAUTH_ADMIN_CLEARANCE_REQUIRED",
        _message: "Admin clearance required.",
      };
    }

    if (
      normalized._status === 401 ||
      code === XAUTH_ERR.UNAUTHORIZED ||
      code === XAUTH_ERR.INVALID_TOKEN
    ) {
      return {
        _status: 401,
        _code: code === XAUTH_ERR.INVALID_TOKEN ? XAUTH_ERR.INVALID_TOKEN : XAUTH_ERR.UNAUTHORIZED,
        _message: "Admin authentication required.",
      };
    }

    return normalized;
  }

  private async resolveRuntimeBootstrap(env: string): Promise<XWebBootstrapMetadata> {
    const default_response = await this.executeServerXvm(
      "get-default-app",
      { _env: env },
      "E_XWEB_DEFAULT_APP_RESOLVE_FAILED",
    );
    const default_result = default_response?._result ?? {};
    const app_id = typeof default_result._app_id === "string"
      ? default_result._app_id.trim()
      : "";

    if (!app_id || default_result._has_default !== true) {
      throw new XWebBootstrapError(
        503,
        "E_XWEB_DEFAULT_APP_NOT_CONFIGURED",
        `No production default app is configured for env '${env}'.`,
        { _env: env },
      );
    }

    await this.validateBootstrapApp(app_id, env, {
      _allow_system: false,
      _missing_code: "E_XWEB_DEFAULT_APP_UNAVAILABLE",
      _trashed_code: "E_XWEB_DEFAULT_APP_TRASHED",
      _system_code: "E_XWEB_DEFAULT_APP_SYSTEM_FORBIDDEN",
    });

    return {
      _mode: "runtime",
      _admin: false,
      _app_id: app_id,
      _env: env,
    };
  }

  private async resolveAdminBootstrap(
    env: string,
    req: express.Request,
    res: express.Response,
  ): Promise<XWebBootstrapMetadata> {
    const auth = this.resolveAdminCookieAuth(req);

    if (!auth._authenticated) {
      if (auth._clear_cookie === true) {
        this.clearAuthCookie(res, req);
      }

      return {
        _mode: "admin-login",
        _admin: true,
        _app_id: null,
        _env: env,
        _authenticated: false,
        _required_clearance_level: XWEB_ADMIN_CLEARANCE_LEVEL,
        _reason: auth._reason,
      };
    }

    if (auth._clearance_level < XWEB_ADMIN_CLEARANCE_LEVEL) {
      return {
        _mode: "admin-denied",
        _admin: true,
        _app_id: null,
        _env: env,
        _authenticated: true,
        _clearance_level: auth._clearance_level,
        _required_clearance_level: XWEB_ADMIN_CLEARANCE_LEVEL,
      };
    }

    await this.validateBootstrapApp(ADMIN_BOOTSTRAP_APP_ID, env, {
      _allow_system: true,
      _missing_code: "E_XWEB_ADMIN_APP_UNAVAILABLE",
      _trashed_code: "E_XWEB_ADMIN_APP_TRASHED",
      _system_code: "E_XWEB_ADMIN_APP_SYSTEM_FORBIDDEN",
    });

    return {
      _mode: "admin",
      _admin: true,
      _app_id: ADMIN_BOOTSTRAP_APP_ID,
      _env: env,
    };
  }

  private async validateBootstrapApp(
    app_id: string,
    env: string,
    options: {
      _allow_system: boolean;
      _missing_code: string;
      _trashed_code: string;
      _system_code: string;
    },
  ) {
    try {
      const app_response = await this.executeServerXvm(
        "get-app",
        {
          _app_id: app_id,
          _env: env,
          _include_views: false,
          _include_flows: false,
        },
        options._missing_code,
      );
      const app = app_response?._result?._app;

      if (app?._system === true && !options._allow_system) {
        throw new XWebBootstrapError(
          409,
          options._system_code,
          `System app cannot be used as the public runtime default: ${app_id}`,
          { _app_id: app_id, _env: env },
        );
      }
    } catch (error) {
      if (error instanceof XWebBootstrapError && error._code === options._system_code) {
        throw error;
      }

      const code = this.readErrorCode(error);
      if (code === "E_XWEB_SERVER_XVM_UNAVAILABLE") {
        throw error;
      }

      if (await this.isBootstrapAppTrashed(app_id, env)) {
        throw new XWebBootstrapError(
          409,
          options._trashed_code,
          `Configured bootstrap app is trashed: ${app_id}`,
          { _app_id: app_id, _env: env },
        );
      }

      throw new XWebBootstrapError(
        503,
        options._missing_code,
        `Configured bootstrap app is not available: ${app_id}`,
        {
          _app_id: app_id,
          _env: env,
          _cause_code: code ?? null,
        },
      );
    }
  }

  private async isBootstrapAppTrashed(app_id: string, env: string): Promise<boolean> {
    try {
      const trashed_response = await this.executeServerXvm(
        "list-trashed-apps",
        { _env: env },
        "E_XWEB_TRASHED_APPS_RESOLVE_FAILED",
      );
      const trashed_apps = Array.isArray(trashed_response?._result?._apps)
        ? trashed_response._result._apps
        : [];

      return trashed_apps.some((app: any) =>
        app?._app_id === app_id &&
        app?._env === env
      );
    } catch {
      return false;
    }
  }

  private async executeServerXvm(
    op: string,
    params: Record<string, unknown>,
    fallback_code: string,
  ) {
    try {
      const response = await _x.execute({
        _module: "server-xvm",
        _op: op,
        _params: params as any,
      } as any);

      if (response && response._ok === false) {
        throw new XWebBootstrapError(
          503,
          this.readErrorCode(response) ?? fallback_code,
          this.readErrorMessage(response) ?? `server-xvm.${op} failed.`,
          { _op: op },
        );
      }

      return response;
    } catch (error) {
      const raw_code = this.readErrorCode(error);
      if (raw_code === "E_XWEB_SERVER_XVM_UNAVAILABLE") throw error;
      if (typeof raw_code === "string" && raw_code.startsWith("E_XVM_")) throw error;

      const message = this.readErrorMessage(error) ?? String(error);
      const code = message.includes("server-xvm") && message.includes("not loaded")
        ? "E_XWEB_SERVER_XVM_UNAVAILABLE"
        : fallback_code;

      throw new XWebBootstrapError(
        503,
        code,
        code === "E_XWEB_SERVER_XVM_UNAVAILABLE"
          ? "server-xvm is not loaded; bootstrap routing cannot resolve an app yet."
          : message,
        { _op: op },
      );
    }
  }

  private sendBootstrappedIndex(res: express.Response, bootstrap: XWebBootstrapMetadata) {
    const index_path = path.join(this._public_folder, "index.html");
    if (!fs.existsSync(index_path)) {
      throw new XWebBootstrapError(
        500,
        "E_XWEB_INDEX_NOT_FOUND",
        "Client index.html was not found in the XWeb public folder.",
        { _public_folder: this._public_folder },
      );
    }

    const html = fs.readFileSync(index_path, "utf-8");
    const injected_html = this.injectBootstrapMetadata(html, bootstrap);

    res
      .status(200)
      .setHeader("Cache-Control", "no-store")
      .setHeader("X-Xpell-Bootstrap-Mode", bootstrap._mode)
      .setHeader("X-Xpell-Bootstrap-Env", bootstrap._env);

    if (bootstrap._app_id) {
      res.setHeader("X-Xpell-Bootstrap-App-Id", bootstrap._app_id);
    }

    res
      .type("html")
      .send(injected_html);
  }

  private injectBootstrapMetadata(html: string, bootstrap: XWebBootstrapMetadata) {
    const script = `<script id="xpell-bootstrap" type="application/json">${this.safeJsonForHtml(bootstrap)}</script>`;
    if (html.includes("</head>")) {
      return html.replace("</head>", `${script}</head>`);
    }
    return `${script}${html}`;
  }

  private safeJsonForHtml(value: unknown) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  private sendBootstrapError(res: express.Response, error: unknown) {
    const normalized = this.normalizeBootstrapError(error);
    _xlog.warn("[xweb] bootstrap failed", {
      _code: normalized._code,
      _status: normalized._status,
      ...(normalized._details ?? {}),
    });

    res
      .status(normalized._status)
      .setHeader("Cache-Control", "no-store")
      .json({
        _ok: false,
        _result: {
          _code: normalized._code,
          _message: normalized._message,
          _details: normalized._details ?? {},
        },
      });
  }

  private normalizeBootstrapError(error: unknown): XWebBootstrapErrorData {
    if (error instanceof XWebBootstrapError) {
      return {
        _status: error._status,
        _code: error._code,
        _message: error.message,
        _details: error._details,
      };
    }

    return {
      _status: 500,
      _code: this.readErrorCode(error) ?? "E_XWEB_BOOTSTRAP_FAILED",
      _message: this.readErrorMessage(error) ?? "XWeb bootstrap routing failed.",
    };
  }

  private readErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as any;
    if (typeof record._code === "string") return record._code;
    if (typeof record._result?._code === "string") return record._result._code;
    if (typeof record._result?._error?._code === "string") return record._result._error._code;
    if (typeof record._error?._code === "string") return record._error._code;
    return undefined;
  }

  private readErrorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as any;
    if (typeof record.message === "string") return record.message;
    if (typeof record._message === "string") return record._message;
    if (typeof record._result?.message === "string") return record._result.message;
    if (typeof record._result?._message === "string") return record._result._message;
    if (typeof record._result?._error?._message === "string") return record._result._error._message;
    return undefined;
  }

  private applyRoutes() {
    for (const handler of this._routes_handlers) {
      handler(this._app, this);
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePolicyName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("_", "-")
    : "";
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default XWebServer;
