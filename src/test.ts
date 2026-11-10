import assert from "assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { _x, XModule } from "@xpell/core";
import { apply_deterministic_view_edit } from "@xpell/vibe/XVIBE/XVibeModule.js";
import {
  MCPModule,
  getXpellMCPRuntimeReadiness,
  markXpellMCPRuntimeReady,
  markXpellMCPRuntimeStarting,
} from "@xpell/mcp";
import * as NodePackage from "./index.js";
import * as NodeCorePackage from "@xpell/node-core";
import FlowManagerModule from "./XFM/FlowManagerModule.js";
import { XEntityManager } from "./XEntityManager/XEntityManager.js";
import { run_entity_provider_conformance_tests } from "./XEntityManager/EntityProviderConformanceTests.js";
import { create_xapp_zip } from "./XAppPackage/XAppArchive.js";
import {
  finalize_xapp_manifest,
  sha256_buffer,
  stable_json_buffer,
  type XAppManifest,
} from "./XAppPackage/XAppManifest.js";
import { register_xapp_download, store_xapp_upload } from "./XAppPackage/XAppDownloadTransfer.js";
import { listXAuthOAuthRefreshTokenRecordsForTests } from "./XAuth/XAuthOAuth.js";

type HttpBytesResponse = {
  _status: number;
  _headers: http.IncomingHttpHeaders;
  _bytes: Buffer;
};

type OAuthClientMetadataServer = {
  _client_id: string;
  _redirect_uri: string;
};

async function with_oauth_client_metadata_server<T>(
  handler: (client: OAuthClientMetadataServer) => Promise<T>,
  options: {
    _redirect_uris?: (base_url: string) => string[];
  } = {},
): Promise<T> {
  const default_redirect_uris = (base_url: string) => [`${base_url}/callback`, `${base_url}/callback-alt`];
  const listening = http.createServer((req, res) => {
    const host = req.headers.host ?? "";
    const base_url = `http://${host}`;
    const redirect_uris = options._redirect_uris?.(base_url) ?? default_redirect_uris(base_url);

    if (req.url === "/client.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({
        client_name: "Codex Test Client",
        redirect_uris,
        token_endpoint_auth_methods_supported: ["none"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base_url = `http://127.0.0.1:${address.port}`;
    const redirect_uris = options._redirect_uris?.(base_url) ?? default_redirect_uris(base_url);
    return await handler({
      _client_id: `${base_url}/client.json`,
      _redirect_uri: redirect_uris[0],
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: NodeJS.ErrnoException | undefined) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

async function with_xapp_transfer_server<T>(
  work_folder: string,
  handler: (base_url: string) => Promise<T>,
  options: { _max_upload_bytes?: number; _cors_origins?: string[]; _cors_allow_credentials?: boolean } = {},
): Promise<T> {
  const app = express();
  app.use(NodePackage.createXAppPackageTransferRouter({
    _work_folder: work_folder,
    _max_upload_bytes: options._max_upload_bytes,
    _cors_origins: options._cors_origins,
    _cors_allow_credentials: options._cors_allow_credentials,
  }));
  const server = await new Promise<http.Server>((resolve, reject) => {
    const listening = http.createServer(app);
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: NodeJS.ErrnoException | undefined) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

async function with_xweb_bootstrap_server<T>(
  work_folder: string,
  server_xvm: any,
  handler: (base_url: string) => Promise<T>,
  options: {
    _enable_wormholes?: boolean;
    _mcp_ready?: boolean;
    _mcp_settings?: Record<string, unknown>;
  } = {},
): Promise<T> {
  await mkdir(path.join(work_folder, "public"), { recursive: true });
  await writeFile(
    path.join(work_folder, "public", "index.html"),
    [
      "<!doctype html>",
      "<html>",
      "<head><title>Xpell</title></head>",
      "<body><div id=\"root\"></div><script type=\"module\" src=\"/assets/index.js\"></script></body>",
      "</html>",
    ].join(""),
  );

  const modules = (_x as any)._modules ?? {};
  const previous_server_xvm = modules["server-xvm"];
  const previous_xauth = modules["xauth"];
  const previous_mcp = modules["mcp"];
  NodePackage.XDB.init({
    storage: new NodePackage.XDBStorageFS({ xdbFolder: path.join(work_folder, "xdb") }),
    enableCache: false,
    workFolder: work_folder,
  });
  await (NodePackage.XDB as any).onLoad();
  const web = new NodePackage.XWebServer();
  web.init(work_folder);
  if (options._mcp_settings) {
    const settings_folder = path.join(work_folder, "settings");
    fs.mkdirSync(settings_folder, { recursive: true });
    const settings_file = path.join(settings_folder, "server-settings.json");
    fs.writeFileSync(
      settings_file,
      JSON.stringify({ mcp: options._mcp_settings }, null, 2),
      "utf-8",
    );
    NodeCorePackage._xs.load(settings_file);
  }
  modules["server-xvm"] = server_xvm;
  modules["xauth"] = new NodePackage.XAuthModule();
  modules["mcp"] = new MCPModule();
  if (options._mcp_ready === false) {
    markXpellMCPRuntimeStarting("test_xweb_runtime_loading");
  } else {
    markXpellMCPRuntimeReady("test_xweb_runtime_ready");
  }
  web.load();

  const listening = http.createServer(web._express_app);
  if (options._enable_wormholes === true) {
    (web as any)._web_server = listening;
    (web as any)._installWormholesV2();
  }

  const server = await new Promise<http.Server>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    if (previous_server_xvm) {
      modules["server-xvm"] = previous_server_xvm;
    } else {
      delete modules["server-xvm"];
    }
    if (previous_xauth) {
      modules["xauth"] = previous_xauth;
    } else {
      delete modules["xauth"];
    }
    if (previous_mcp) {
      modules["mcp"] = previous_mcp;
    } else {
      delete modules["mcp"];
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error: NodeJS.ErrnoException | undefined) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

async function with_xweb_raw_json_server<T>(
  handler: (base_url: string, work_folder: string) => Promise<T>,
): Promise<T> {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-xweb-raw-json-"));
  await mkdir(path.join(work_folder, "public"), { recursive: true });

  const web = new NodePackage.XWebServer();
  web.init(work_folder);
  web.useRoutes((app) => {
    app.post("/__xweb_test/inspect-json", (req, res) => {
      const raw_body: Buffer | undefined = req.rawBody;
      res.status(200).json({
        _body: req.body,
        _raw_body_base64: raw_body?.toString("base64"),
        _raw_body_is_buffer: Buffer.isBuffer(raw_body),
      });
    });
    app.post("/__xweb_test/normal-json", (req, res) => {
      res.status(200).json(req.body);
    });
    app.post("/__xweb_test/non-json", (req, res) => {
      res.status(200).json({
        _has_raw_body: req.rawBody !== undefined,
      });
    });
  });
  web.load();

  const listening = http.createServer(web._express_app);
  const server = await new Promise<http.Server>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await handler(`http://127.0.0.1:${address.port}`, work_folder);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: NodeJS.ErrnoException | undefined) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
      });
    });
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function read_http_bytes(
  url: string,
  options: { _method?: string; _headers?: Record<string, string> } = {},
): Promise<HttpBytesResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      method: options._method ?? "GET",
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: options._headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          _status: res.statusCode ?? 0,
          _headers: res.headers,
          _bytes: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function read_json_response(response: HttpBytesResponse): any {
  return JSON.parse(response._bytes.toString("utf-8"));
}

function cookie_header_from_set_cookie(value: string | string[] | undefined): string {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];

  return items
    .map((item) => item.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function read_xweb_bootstrap(response: HttpBytesResponse): any {
  const html = response._bytes.toString("utf-8");
  assert.equal((html.match(/id="xpell-bootstrap"/g) ?? []).length, 1);
  assert.equal((html.match(/id="xpell-server-bootstrap"/g) ?? []).length, 0);
  assert.equal((html.match(/data-xpell-bootstrap/g) ?? []).length, 0);
  assert.equal((html.match(/data-xnode-bootstrap/g) ?? []).length, 0);
  const bootstrap_scripts = html.match(/<script[^>]*(?:id="xpell-bootstrap"|data-xpell-bootstrap|data-xnode-bootstrap)[^>]*>/g) ?? [];
  assert.equal(bootstrap_scripts.length, 1);
  const match = html.match(/<script id="xpell-bootstrap" type="application\/json">([^<]*)<\/script>/);
  assert.ok(match, "Expected canonical xpell-bootstrap script in HTML response");
  return JSON.parse(match[1]);
}

function wormholes_req(_module: string, _op: string, _params: Record<string, any> = {}) {
  return {
    _v: 2,
    _id: NodePackage._xu.guid(),
    _kind: "REQ",
    _payload: {
      _module,
      _op,
      _params,
    },
  };
}

async function post_wormholes_call(
  base_url: string,
  _module: string,
  _op: string,
  _params: Record<string, any> = {},
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await post_http_bytes(
    `${base_url}/wh/v2/call`,
    Buffer.from(JSON.stringify(wormholes_req(_module, _op, _params))),
    {
      "content-type": "application/json",
      ...headers,
    },
  );
  assert.equal(response._status, 200);
  return read_json_response(response);
}

function read_wormholes_result(response: any): any {
  return response?._payload?._result;
}

function read_wormholes_error_code(response: any): string | undefined {
  return read_wormholes_result(response)?._code;
}

function read_mcp_sse_response(text: string): any {
  const data_line = text
    .split("\n")
    .find((line) => line.startsWith("data: "));

  assert.ok(data_line, "expected MCP SSE data line");
  return JSON.parse(data_line.slice("data: ".length));
}

function mcp_rpc(id: number, method: string, params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };
}

function pkce_s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function extract_oauth_request_id(html: string): string {
  const match = html.match(/name="request_id" value="([^"]+)"/);
  assert.ok(match, "expected OAuth pending request id");
  return match[1];
}

function assert_oauth_login_page_contract(html: string): void {
  assert.match(html, /Sign in to Xpell/);
  assert.match(html, /class="xoauth-card"/);
  assert.match(html, /<form[^>]*method="post"[^>]*action="\/oauth\/login"/);
  assert.match(html, /name="request_id" value="[^"]+"/);
  assert.match(html, /<input[^>]*name="email"[^>]*type="email"[^>]*autocomplete="username"[^>]*required/);
  assert.match(html, /<input[^>]*name="password"[^>]*type="password"[^>]*autocomplete="current-password"[^>]*required/);
  assert.equal(/<script\b/i.test(html), false);
}

function assert_oauth_consent_page_contract(html: string): void {
  assert.match(html, /Authorize Xpell MCP/);
  assert.match(html, /class="xoauth-card"/);
  assert.match(html, /class="xoauth-scope"/);
  assert.match(html, /<form[^>]*method="post"[^>]*action="\/oauth\/authorize\/consent"/);
  assert.match(html, /name="request_id" value="[^"]+"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*name="action"[^>]*value="authorize"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*name="action"[^>]*value="cancel"/);
  assert.equal(/<script\b/i.test(html), false);
}

function read_redirect_param(location: string | string[] | undefined, name: string): string {
  assert.equal(typeof location, "string");
  const redirect_location = location as string;
  return new URL(redirect_location).searchParams.get(name) ?? "";
}

function oauth_authorize_url(
  base_url: string,
  input: {
    client_id: string;
    redirect_uri: string;
    resource?: string;
    scope?: string;
    state?: string;
    verifier?: string;
  },
): string {
  const verifier = input.verifier ?? "test-verifier-1234567890";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    scope: input.scope ?? "xpell:read xpell:write xpell:admin",
    state: input.state ?? "state-123",
    code_challenge: pkce_s256(verifier),
    code_challenge_method: "S256",
    resource: input.resource ?? `${base_url}/mcp`,
  });
  return `${base_url}/oauth/authorize?${params.toString()}`;
}

async function issue_oauth_token_via_consent(
  base_url: string,
  client: OAuthClientMetadataServer,
  admin_cookie: string,
  input: {
    scope?: string;
    verifier?: string;
    state?: string;
  } = {},
): Promise<{ _token_body: any; _code: string; _verifier: string }> {
  const verifier = input.verifier ?? `oauth-verifier-${Date.now()}-${Math.random()}`;
  const page = await read_http_bytes(oauth_authorize_url(base_url, {
    client_id: client._client_id,
    redirect_uri: client._redirect_uri,
    scope: input.scope,
    state: input.state,
    verifier,
  }), {
    _headers: { cookie: admin_cookie },
  });
  assert.equal(page._status, 200);
  const request_id = extract_oauth_request_id(page._bytes.toString("utf-8"));
  const redirect = await post_oauth_form(
    `${base_url}/oauth/authorize/consent`,
    { request_id, action: "authorize" },
    { cookie: admin_cookie },
  );
  assert.equal(redirect._status, 302);
  const code = read_redirect_param(redirect._headers.location, "code");
  assert.ok(code);
  const token_response = await post_oauth_form(
    `${base_url}/oauth/token`,
    {
      grant_type: "authorization_code",
      code,
      client_id: client._client_id,
      redirect_uri: client._redirect_uri,
      resource: `${base_url}/mcp`,
      code_verifier: verifier,
    },
  );
  assert.equal(token_response._status, 200);
  return {
    _token_body: read_json_response(token_response),
    _code: code,
    _verifier: verifier,
  };
}

async function post_oauth_form(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<HttpBytesResponse> {
  const encoded = new URLSearchParams(body).toString();
  return post_http_bytes(
    url,
    Buffer.from(encoded),
    {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
  );
}

async function post_http_bytes(
  url: string,
  bytes: Buffer,
  headers: Record<string, string>,
): Promise<HttpBytesResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...headers,
        "content-length": String(bytes.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          _status: res.statusCode ?? 0,
          _headers: res.headers,
          _bytes: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

function multipart_xapp_upload(filename: string, bytes: Buffer): { _body: Buffer; _content_type: string } {
  const boundary = `xapp-boundary-${Date.now()}`;
  return {
    _content_type: `multipart/form-data; boundary=${boundary}`,
    _body: Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
      Buffer.from("Content-Type: application/octet-stream\r\n\r\n"),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function hash_file_sync(file_path: string): string {
  return createHash("sha256").update(fs.readFileSync(file_path)).digest("hex");
}

function hash_tree_sync(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        out[relative] = hash_file_sync(absolute);
      }
    }
  };

  visit(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

type PlanningQuestionFixture = {
  _id: string;
  _type: "single" | "multi" | "text";
  _question: string;
  _options?: string[];
  _required?: boolean;
  _answer?: string | string[] | null;
  _suggestions?: string[];
};

async function run_node_core_compatibility_tests() {
  assert.equal(NodePackage.XEventManager, NodeCorePackage.XEventManager);
  assert.equal(NodePackage._xem, NodeCorePackage._xem);
  assert.equal(NodePackage.XSettings, NodeCorePackage.XSettings);
  assert.equal(NodePackage.Settings, NodeCorePackage.XSettings);
  assert.equal(NodePackage._xs, NodeCorePackage._xs);
  assert.equal(NodePackage.XUtils, NodeCorePackage.XUtils);
  assert.equal(NodePackage._xu, NodeCorePackage._xu);

  const event_name = `node-core:compat:${Date.now()}`;
  const event_payload = { _ok: true };
  let observed_payload: unknown;
  const listener_id = NodePackage._xem.on(event_name, (payload: unknown) => {
    observed_payload = payload;
  });

  try {
    await NodeCorePackage._xem.fire(event_name, event_payload);
    assert.equal(observed_payload, event_payload);
  } finally {
    NodePackage._xem.remove(listener_id);
  }

  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-core-settings-"));
  const settings_file = path.join(work_folder, "settings", "server-settings.json");
  const settings = new NodeCorePackage._XSettings();
  const loaded_settings = new NodeCorePackage._XSettings();

  try {
    settings.onSetup(work_folder);
    settings.set("compat", { _ok: true });
    assert.deepEqual(
      JSON.parse(await readFile(settings_file, "utf-8")).compat,
      { _ok: true },
    );
    assert.equal(loaded_settings.load(settings_file), true);
    assert.deepEqual(loaded_settings.get("compat"), { _ok: true });
  } finally {
    settings.close();
    loaded_settings.close();
    await rm(work_folder, { recursive: true, force: true });
  }

  const encoded = NodePackage._xu.encode("hello node core");
  assert.equal(NodeCorePackage._xu.decode(encoded), "hello node core");

  const utils_folder = await mkdtemp(path.join(tmpdir(), "xnode-core-utils-"));
  try {
    const nested_folder = path.join(utils_folder, "a", "b");
    NodePackage._xu.checkFolders([nested_folder]);
    assert.equal((await stat(nested_folder)).isDirectory(), true);
  } finally {
    await rm(utils_folder, { recursive: true, force: true });
  }

  assert.equal((NodePackage._xu as any).is_plain_object({ _ok: true }), true);
}

function find_json_object_by_id(value: unknown, id: string): any {
  if (!value || typeof value !== "object") return null;
  if ((value as any)._id === id) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find_json_object_by_id(item, id);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = find_json_object_by_id(item, id);
    if (found) return found;
  }
  return null;
}

async function run_operations_starter_image_contract_tests() {
  const starter_view_path = path.resolve(
    process.cwd(),
    "system-xapps",
    "app-starters",
    "dashboard",
    "views",
    "main.json",
  );
  const view = JSON.parse(await readFile(starter_view_path, "utf-8"));
  const sidebar = find_json_object_by_id(view, "dashboard-sidebar");
  const settings_card = find_json_object_by_id(view, "dashboard-settings-card");

  assert.ok(sidebar, "dashboard-sidebar missing from Operations starter");
  assert.ok(settings_card, "dashboard-settings-card missing from Operations starter");
  assert.equal(sidebar._logo?._type, "image");
  assert.equal(sidebar._logo?._id, "dashboard-sidebar-logo");
  assert.equal(sidebar._logo?.src, "assets/logo.svg");
  assert.equal(sidebar._logo?.alt, "Xpell Dashboard Starter logo");
  assert.equal(settings_card._image?._type, "image");
  assert.equal(settings_card._image?._id, "dashboard-settings-card-image");
  assert.equal(settings_card._image?.src, "assets/placeholder-record.svg");
  assert.equal(settings_card._image?.alt, "Dashboard placeholder");
}

class XNodeCompositionTestModule extends XModule {
  constructor(name: string) {
    super({ _name: name });
  }
}

function create_fake_xnode_web_server_for_test() {
    const app = express();
    const route_contributors: NodePackage.XWebRouteContributor[] = [];
    const lifecycle: string[] = [];
    const server = {
        onSetup() {},
        init() {},
        load() {
            lifecycle.push("load");
            for (const contributor of route_contributors) {
                contributor(app, server as unknown as NodePackage.XWebServer);
            }
        },
        useRoutes(contributor: NodePackage.XWebRouteContributor) {
            lifecycle.push("use-routes");
            route_contributors.push(contributor);
        },
        async start() {
            lifecycle.push("start");
            return "test web server started";
        },
        _lifecycle: lifecycle,
        _route_contributors: route_contributors,
    };
    return server;
}

async function run_xnode_generic_composition_tests() {
  const original_load_module_async = (_x as any).loadModuleAsync;
  const original_start = (_x as any).start;
  const loaded_modules: string[] = [];
  const readiness_at_load: Array<{ _module: string; _ready: boolean }> = [];

  (_x as any).loadModuleAsync = async (mod: XModule) => {
    readiness_at_load.push({
      _module: mod._name,
      _ready: getXpellMCPRuntimeReadiness()._ready,
    });
    if (mod._name === "failing-app-module") {
      throw new Error("failing app module load");
    }
    loaded_modules.push(mod._name);
  };
  (_x as any).start = () => {};

  async function start_xnode_for_composition_test(options: {
    _modules?: XModule[];
    _routes?: NodePackage.XWebRouteContributor[];
  } = {}) {
    loaded_modules.length = 0;
    readiness_at_load.length = 0;
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-composition-"));
    const node = new NodePackage.XNode();
    const fake_web_server = create_fake_xnode_web_server_for_test();
    (node as any)._web_server = fake_web_server;

    try {
      await node.start({
        _work_folder: work_folder,
        _modules: options._modules,
        _routes: options._routes,
      });
      return {
        _work_folder: work_folder,
        _loaded_modules: [...loaded_modules],
        _readiness_at_load: [...readiness_at_load],
        _mcp_readiness: getXpellMCPRuntimeReadiness(),
        _web_lifecycle: [...fake_web_server._lifecycle],
        _route_contributor_count: fake_web_server._route_contributors.length,
      };
    } catch (err) {
      NodeCorePackage._xs.close();
      await rm(work_folder, { recursive: true, force: true });
      throw err;
    }
  }

  try {
    const default_startup = await start_xnode_for_composition_test();
    try {
      assert.deepEqual(
        default_startup._loaded_modules,
        [
          "xdb",
          "ping",
          "wormholes",
          "xauth",
          "mcp",
          "xai",
          "file-service",
          "module-creator",
          "xmutator",
          "flow",
          "entity-manager",
          "planning",
          "studio",
          "server-xvm",
        ],
      );
      assert.equal(default_startup._loaded_modules.includes("xvibe"), false);
      assert.equal(default_startup._mcp_readiness._ready, true);
      assert.equal(default_startup._mcp_readiness._reason, "xnode_module_graph_loaded");
      assert.equal(default_startup._readiness_at_load.every((entry) => entry._ready === false), true);
      assert.deepEqual(default_startup._web_lifecycle, ["use-routes", "load", "start"]);
      assert.equal(default_startup._route_contributor_count, 1);
    } finally {
      NodeCorePackage._xs.close();
      await rm(default_startup._work_folder, { recursive: true, force: true });
    }

    const custom_module = new XNodeCompositionTestModule("custom-app-module");
    const custom_startup = await start_xnode_for_composition_test({
      _modules: [custom_module],
    });
    try {
      assert.ok(custom_startup._loaded_modules.includes("custom-app-module"));
      assert.equal(custom_startup._loaded_modules.indexOf("custom-app-module"), 9);
      assert.equal(custom_startup._loaded_modules.includes("xvibe"), false);
      assert.equal(custom_startup._loaded_modules[10], "flow");
      assert.equal(custom_startup._loaded_modules[12], "planning");
      assert.equal(custom_startup._mcp_readiness._ready, true);
      assert.equal(custom_startup._readiness_at_load.every((entry) => entry._ready === false), true);
    } finally {
      NodeCorePackage._xs.close();
      await rm(custom_startup._work_folder, { recursive: true, force: true });
    }

    const route_execution_order: string[] = [];
    const routed_startup = await start_xnode_for_composition_test({
      _routes: [
        () => route_execution_order.push("first"),
        () => route_execution_order.push("second"),
      ],
    });
    try {
      assert.deepEqual(route_execution_order, ["first", "second"]);
      assert.deepEqual(
        routed_startup._web_lifecycle,
        ["use-routes", "use-routes", "use-routes", "load", "start"],
      );
      assert.equal(routed_startup._route_contributor_count, 3);
    } finally {
      NodeCorePackage._xs.close();
      await rm(routed_startup._work_folder, { recursive: true, force: true });
    }

    await assert.rejects(
      async () => {
        await start_xnode_for_composition_test({
          _routes: [(() => {}) as NodePackage.XWebRouteContributor, "invalid" as any],
        });
      },
      (err: any) => {
        assert.equal(err?._code, "E_XNODE_INVALID_ROUTE_CONTRIBUTOR");
        assert.equal(err?._details?._index, 1);
        assert.equal(err?._details?._received_type, "string");
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await start_xnode_for_composition_test({
          _modules: [
            new XNodeCompositionTestModule("duplicate-app-module"),
            new XNodeCompositionTestModule("duplicate-app-module"),
          ],
        });
      },
      (err: any) => {
        assert.equal(err?._ok, false);
        assert.equal(err?._code, "E_XNODE_DUPLICATE_MODULES");
        assert.deepEqual(err?._details?._duplicates, ["duplicate-app-module"]);
        assert.deepEqual(err?.toXData?.(), {
          _ok: false,
          _error: {
            _code: "E_XNODE_DUPLICATE_MODULES",
            _message: "XNode.start option '_modules' contains duplicate module names.",
            _details: {
              _duplicates: ["duplicate-app-module"],
            },
          },
        });
        return true;
      },
    );

    assert.equal(loaded_modules.length, 0);
    assert.equal(getXpellMCPRuntimeReadiness()._status, "failed");
    assert.equal(getXpellMCPRuntimeReadiness()._ready, false);

    const failing_module = new XNodeCompositionTestModule("failing-app-module");
    await assert.rejects(
      async () => {
        await start_xnode_for_composition_test({
          _modules: [failing_module],
        });
      },
      /failing app module load/,
    );
    assert.equal(getXpellMCPRuntimeReadiness()._status, "failed");
    assert.equal(getXpellMCPRuntimeReadiness()._ready, false);

    const route_work_folder = await mkdtemp(path.join(tmpdir(), "xnode-route-contribution-"));
    const route_node = new NodePackage.XNode();
    const request_json = '{"message":"route contribution","count":2}';
    try {
      await route_node.start({
        _work_folder: route_work_folder,
        _port: 0,
        _host: "127.0.0.1",
        _web_settings: {
          "enable-wormhole": false,
        },
        _routes: [
          (app, web) => {
            assert.equal(web, route_node._web_server);
            app.post("/__xnode_test/contributed", (req, res) => {
              res.status(201).json({
                _body: req.body,
                _raw_body_base64: req.rawBody?.toString("base64"),
                _raw_body_is_buffer: Buffer.isBuffer(req.rawBody),
              });
            });
          },
        ],
      });

      const http_server = route_node._web_server._web_server;
      assert.ok(http_server, "XNode did not create an HTTP server");
      if (!http_server.listening) {
        await new Promise<void>((resolve, reject) => {
          http_server.once("listening", resolve);
          http_server.once("error", reject);
        });
      }
      const address = http_server.address();
      assert.ok(address && typeof address === "object");

      const response = await fetch(
        `http://127.0.0.1:${address.port}/__xnode_test/contributed`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: request_json,
        },
      );
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), {
        _body: {
          message: "route contribution",
          count: 2,
        },
        _raw_body_base64: Buffer.from(request_json).toString("base64"),
        _raw_body_is_buffer: true,
      });
    } finally {
      const http_server = route_node._web_server._web_server;
      if (http_server) {
        await new Promise<void>((resolve, reject) => {
          http_server.close((error: NodeJS.ErrnoException | undefined) => {
            if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
              resolve();
              return;
            }
            reject(error);
          });
        });
      }
      NodeCorePackage._xs.close();
      await rm(route_work_folder, { recursive: true, force: true });
    }

    const xnode_source = await readFile(path.resolve("src/XServer/XNode.ts"), "utf-8");
    const readiness_lines = xnode_source
      .split("\n")
      .filter((line) => line.includes("markXpellMCPRuntime"));
    assert.equal(readiness_lines.some((line) => line.toLowerCase().includes("xvibe")), false);
  } finally {
    (_x as any).loadModuleAsync = original_load_module_async;
    (_x as any).start = original_start;
  }
}

function planning_question(
  overrides: PlanningQuestionFixture = {
    _id: "primary_user",
    _type: "single",
    _question: "Who will use it?",
    _options: ["Personal user", "Team"],
  },
) {
  return {
    _id: overrides._id,
    _type: overrides._type,
    _question: overrides._question,
    ...(overrides._options ? { _options: overrides._options } : {}),
    ...(overrides._suggestions ? { _suggestions: overrides._suggestions } : {}),
    _required: overrides._required ?? true,
    _answer: overrides._answer ?? null,
  };
}

function planning_state(overrides: Record<string, unknown> = {}) {
  const first_question = planning_question();
  return {
    _contract_version: NodePackage.XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
    _type: "project-plan",
    _stage: "planning",
    _status: "awaiting-answer",
    _app_archetype: "personal-list",
    _scope: "personal",
    _goal: "Build a personal shopping list",
    _questions: [first_question],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: first_question,
    _proposed: {
      _entities: [{ _id: "shopping_item", _title: "Shopping Item" }],
      _views: [{ _id: "list", _title: "List" }],
      _flows: [{ _id: "add-item", _title: "Add Item" }],
      _server_modules: [],
    },
    ...overrides,
  };
}

function shopping_list_plan(overrides: Record<string, unknown> = {}) {
  const list_structure_question = {
    _id: "list_structure",
    _type: "single_choice",
    _question: "How should shopping lists be organized?",
    _required: true,
    _options: [
      { _id: "single", _label: "Single list" },
      { _id: "multiple_named", _label: "Multiple named lists" },
    ],
    _answer: "single",
    _answer_state: "confirmed",
    _affected_plan_sections: ["entities", "views", "flows", "milestones"],
  };
  const sync_question = {
    _id: "sync_behavior",
    _type: "single_choice",
    _question: "Should the list sync across devices?",
    _required: false,
    _options: [
      { _id: "local_only", _label: "Local only" },
      { _id: "cloud_sync", _label: "Cloud sync" },
    ],
  };
  const list_item_fields_question = {
    _id: "list_item_fields",
    _type: "multiple_choice",
    _question: "Which item fields should be included?",
    _required: true,
    _options: [
      { _id: "name", _label: "Name" },
      { _id: "quantity", _label: "Quantity" },
      { _id: "status", _label: "Status" },
    ],
    _answer: ["name", "quantity", "status"],
    _answer_state: "confirmed",
  };
  const completed_item_behavior_question = {
    _id: "completed_item_behavior",
    _type: "single_choice",
    _question: "What should happen when an item is completed?",
    _required: true,
    _options: [
      { _id: "mark_purchased", _label: "Mark purchased" },
      { _id: "archive", _label: "Archive" },
    ],
    _answer: "mark_purchased",
    _answer_state: "confirmed",
  };

  return {
    _type: "project-plan",
    _contract_version: NodePackage.XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
    _selected_app_type: "custom",
    _inferred_archetype: "personal_list",
    _scope: "personal",
    _goal: "Build a personal shopping list app",
    _summary: "Track shopping items and mark them as purchased.",
    _initial_vision: "I want to build a shopping list for myself",
    _planning_status: "complete",
    _stage: "planning",
    _status: "ready-for-confirmation",
    _facts: [
      {
        _id: "primary_user",
        _label: "Primary user",
        _value: "Self",
        _state: "inferred",
        _source: "initial_vision",
        _question_id: "primary_user",
      },
    ],
    _assumptions: [
      {
        _id: "sharing",
        _label: "Sharing",
        _value: "Single-user first version",
        _state: "default",
      },
    ],
    _answers: {
      list_structure: {
        _question_id: "list_structure",
        _value: "single",
        _state: "confirmed",
        _source: "planning_answer_application",
      },
      list_item_fields: {
        _question_id: "list_item_fields",
        _value: ["name", "quantity", "status"],
        _state: "confirmed",
        _source: "planning_answer_application",
      },
      completed_item_behavior: {
        _question_id: "completed_item_behavior",
        _value: "mark_purchased",
        _state: "confirmed",
        _source: "planning_answer_application",
      },
    },
    _questions: [
      list_structure_question,
      list_item_fields_question,
      completed_item_behavior_question,
      sync_question,
    ],
    _current_question: null,
    _proposed_entities: [
      { _id: "shopping_item", _title: "Shopping Item", _fields: ["name", "status"] },
    ],
    _proposed_views: [
      { _id: "shopping_list", _title: "Shopping List" },
    ],
    _proposed_flows: [
      { _id: "add_shopping_item", _title: "Add Shopping Item" },
      { _id: "mark_purchased", _title: "Mark Purchased" },
    ],
    _proposed_modules: [],
    _capabilities: [],
    _milestones: [
      {
        _id: "working_shopping_list",
        _title: "Working Shopping List",
        _items: ["Shopping item model", "List view", "Add and complete flows"],
      },
    ],
    _warnings: [],
    _proposed: {
      _entities: [
        { _id: "shopping_item", _title: "Shopping Item", _fields: ["name", "status"] },
      ],
      _views: [
        { _id: "shopping_list", _title: "Shopping List" },
      ],
      _flows: [
        { _id: "add_shopping_item", _title: "Add Shopping Item" },
        { _id: "mark_purchased", _title: "Mark Purchased" },
      ],
      _server_modules: [],
    },
    ...overrides,
  };
}

function incomplete_shopping_list_plan() {
  const plan = shopping_list_plan();
  const list_structure_question = (plan._questions as any[])[0];
  return {
    ...plan,
    _planning_status: "awaiting_answer",
    _status: "collecting-information",
    _answers: {},
    _questions: [
      {
        ...list_structure_question,
        _answer: null,
        _answer_state: undefined,
      },
      (plan._questions as any[])[1],
    ],
    _current_question: list_structure_question,
    _unanswered_required_question_ids: ["list_structure"],
  };
}

function assert_planning_error(
  fn: () => unknown,
  code: string,
) {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.equal((err as any)?._code, code);
      return true;
    },
  );
}

async function run_xauth_session_contract_tests() {
  const original_node_env = process.env.NODE_ENV;
  const original_xpell_env = process.env.XPELL_ENV;
  const original_xnode_env = process.env.XNODE_ENV;
  const original_email = process.env.XAUTH_DEV_EMAIL;
  const original_password = process.env.XAUTH_DEV_PASSWORD;
  const original_expires = process.env.XAUTH_JWT_EXPIRES_IN;
  const original_date_now = Date.now;

  delete process.env.NODE_ENV;
  delete process.env.XPELL_ENV;
  delete process.env.XNODE_ENV;
  delete process.env.XAUTH_DEV_EMAIL;
  delete process.env.XAUTH_DEV_PASSWORD;
  delete process.env.XAUTH_JWT_EXPIRES_IN;

  try {
    const xauth = new NodePackage.XAuthModule();
    const login = await xauth._login({
      _module: "xauth",
      _op: "login",
      _params: {
        email: "admin@local.dev",
        password: "admin",
      },
    } as any);

    assert.equal(login._ok, true);
    assert.equal(login._authenticated, true);
    assert.equal(typeof login._token, "string");
    assert.equal(login._token.length > 0, true);
    assert.equal(login._user._id, "dev-user");
    assert.equal(login._user.email, "admin@local.dev");
    assert.equal(login._user._clearance_level, 100);
    assert.equal(login._account._id, "dev-account");
    assert.equal(login._session._authenticated, true);
    assert.equal(login._session._auth_type, "jwt");
    assert.equal(login._session._token, login._token);
    assert.equal(login._session._user_id, "dev-user");
    assert.equal(login._session._account_id, "dev-account");
    assert.equal(login._session._clearance_level, 100);
    assert.deepEqual(login._session._user, login._user);
    assert.deepEqual(login._session._account, login._account);
    assert.equal(typeof login._session._issued_at, "number");
    assert.equal(typeof login._session._expires_at, "number");
    assert.equal(login._session._expires_at! > login._session._issued_at!, true);

    const verified = await xauth._verify_jwt({
      _module: "xauth",
      _op: "verify_jwt",
      _params: {
        _token: login._token,
      },
    } as any);
    assert.equal(verified._ok, true);
    assert.equal(verified._auth._authenticated, true);
    assert.equal(verified._auth._clearance_level, 100);

    await assert.rejects(
      async () =>
        xauth._login({
          _module: "xauth",
          _op: "login",
          _params: {
            email: "admin@local.dev",
            password: "wrong",
          },
        } as any),
      (err: any) => err?._code === "E_XAUTH_INVALID_CREDENTIALS",
    );

    await assert.rejects(
      async () =>
        xauth._verify_jwt({
          _module: "xauth",
          _op: "verify_jwt",
          _params: {
            _token: "not-a-token",
          },
        } as any),
      (err: any) => err?._code === "E_XAUTH_INVALID_TOKEN",
    );

    process.env.XAUTH_JWT_EXPIRES_IN = "1s";
    Date.now = () => 1_000_000;
    const short_login = await xauth._login({
      _module: "xauth",
      _op: "login",
      _params: {
        email: "admin@local.dev",
        password: "admin",
      },
    } as any);
    Date.now = () => 3_000_000;
    await assert.rejects(
      async () =>
        xauth._verify_jwt({
          _module: "xauth",
          _op: "verify_jwt",
          _params: {
            _token: short_login._token,
          },
        } as any),
      (err: any) => err?._code === "E_XAUTH_INVALID_TOKEN",
    );
  } finally {
    Date.now = original_date_now;
    restore_env("NODE_ENV", original_node_env);
    restore_env("XPELL_ENV", original_xpell_env);
    restore_env("XNODE_ENV", original_xnode_env);
    restore_env("XAUTH_DEV_EMAIL", original_email);
    restore_env("XAUTH_DEV_PASSWORD", original_password);
    restore_env("XAUTH_JWT_EXPIRES_IN", original_expires);
  }
}

function restore_env(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function capture_console_output<T>(
  handler: () => Promise<T>,
): Promise<{ _result: T; _text: string }> {
  const original_log = console.log;
  const original_warn = console.warn;
  const original_error = console.error;
  const entries: string[] = [];
  const capture = (...args: any[]) => {
    entries.push(args.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item)
    ).join(" "));
  };

  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return {
      _result: await handler(),
      _text: entries.join("\n"),
    };
  } finally {
    console.log = original_log;
    console.warn = original_warn;
    console.error = original_error;
  }
}

async function run_xauth_mcp_token_contract_tests() {
  const original_mcp_expires = process.env.XAUTH_MCP_TOKEN_EXPIRES_IN;
  const original_jwt_expires = process.env.XAUTH_JWT_EXPIRES_IN;
  const original_oauth_refresh_expires = process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN;
  const original_oauth_grant_expires = process.env.XAUTH_MCP_OAUTH_GRANT_EXPIRES_IN;
  const original_date_now = Date.now;
  const work_folder = await mkdtemp(path.join(tmpdir(), "xauth-mcp-token-"));

  delete process.env.XAUTH_MCP_TOKEN_EXPIRES_IN;
  delete process.env.XAUTH_JWT_EXPIRES_IN;
  delete process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN;
  delete process.env.XAUTH_MCP_OAUTH_GRANT_EXPIRES_IN;

  try {
    await with_xweb_bootstrap_server(work_folder, {}, async (base_url) => {
      const protected_resource = await read_http_bytes(
        `${base_url}/.well-known/oauth-protected-resource/mcp`,
      );
      assert.equal(protected_resource._status, 200);
      assert.equal(read_json_response(protected_resource).resource, `${base_url}/mcp`);

      const authorization_server = await read_http_bytes(
        `${base_url}/.well-known/oauth-authorization-server`,
      );
      assert.equal(authorization_server._status, 200);

      const unauth_mcp = await post_http_bytes(
        `${base_url}/mcp`,
        Buffer.from(JSON.stringify(mcp_rpc(100, "tools/list", {}))),
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      );
      assert.equal(unauth_mcp._status, 401);
      assert.match(unauth_mcp._bytes.toString("utf-8"), /E_XMCP_AUTH_REQUIRED/);
    }, {
      _mcp_ready: false,
      _mcp_settings: {
        enabled: true,
        require_auth: true,
        path: "/mcp",
      },
    });

    await with_xweb_bootstrap_server(work_folder, {}, async (base_url) => {
      const protected_resource = await read_http_bytes(
        `${base_url}/.well-known/oauth-protected-resource/mcp`,
      );
      assert.equal(protected_resource._status, 200);
      const protected_resource_body = read_json_response(protected_resource);
      assert.equal(protected_resource_body.resource, `${base_url}/mcp`);
      assert.deepEqual(protected_resource_body.authorization_servers, [base_url]);
      assert.deepEqual(protected_resource_body.scopes_supported, [
        "xpell:read",
        "xpell:write",
        "xpell:admin",
      ]);
      assert.deepEqual(protected_resource_body.bearer_methods_supported, ["header"]);

      const protected_resource_root = await read_http_bytes(
        `${base_url}/.well-known/oauth-protected-resource`,
      );
      assert.equal(protected_resource_root._status, 200);
      assert.deepEqual(read_json_response(protected_resource_root), protected_resource_body);

      const authorization_server = await read_http_bytes(
        `${base_url}/.well-known/oauth-authorization-server`,
      );
      assert.equal(authorization_server._status, 200);
      const authorization_server_body = read_json_response(authorization_server);
      assert.equal(authorization_server_body.issuer, base_url);
      assert.equal(authorization_server_body.authorization_endpoint, `${base_url}/oauth/authorize`);
      assert.equal(authorization_server_body.token_endpoint, `${base_url}/oauth/token`);
      assert.equal(authorization_server_body.revocation_endpoint, `${base_url}/oauth/revoke`);
      assert.equal(authorization_server_body.authorization_response_iss_parameter_supported, true);
      assert.equal(authorization_server_body.client_id_metadata_document_supported, true);
      assert.deepEqual(authorization_server_body.grant_types_supported, ["authorization_code", "refresh_token"]);
      assert.deepEqual(authorization_server_body.response_types_supported, ["code"]);
      assert.deepEqual(authorization_server_body.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(authorization_server_body.token_endpoint_auth_methods_supported, ["none"]);
      assert.deepEqual(authorization_server_body.scopes_supported, [
        "xpell:read",
        "xpell:write",
        "xpell:admin",
      ]);

      const unauth_mcp = await post_http_bytes(
        `${base_url}/mcp`,
        Buffer.from(JSON.stringify(mcp_rpc(1, "tools/list", {}))),
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      );
      assert.equal(unauth_mcp._status, 401);
      assert.equal(
        unauth_mcp._headers["www-authenticate"],
        `Bearer resource_metadata="${base_url}/.well-known/oauth-protected-resource/mcp", scope="xpell:read xpell:write xpell:admin"`,
      );
      assert.match(unauth_mcp._bytes.toString("utf-8"), /E_XMCP_AUTH_REQUIRED/);

      const unauth = await post_http_bytes(
        `${base_url}/xauth/mcp-token`,
        Buffer.from("{}"),
        { "content-type": "application/json" },
      );
      assert.equal(unauth._status, 401);
      assert.equal(JSON.stringify(read_json_response(unauth)).includes("_token"), false);

      const login_response = await post_http_bytes(
        `${base_url}/xauth/login`,
        Buffer.from(JSON.stringify({
          email: "admin@local.dev",
          password: "admin",
        })),
        { "content-type": "application/json" },
      );
      assert.equal(login_response._status, 200);
      const login_body = read_json_response(login_response);
      assert.equal(JSON.stringify(login_body).includes("_token"), false);

      const admin_cookie = cookie_header_from_set_cookie(login_response._headers["set-cookie"]);
      const browser_session_token = decodeURIComponent(admin_cookie.replace(/^xauth_session=/, ""));
      assert.ok(browser_session_token);

      await with_oauth_client_metadata_server(async (loopback_client) => {
        const requested_redirect = "http://127.0.0.1:53158/callback";
        const loopback_authorize = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: loopback_client._client_id,
          redirect_uri: requested_redirect,
          verifier: "oauth-loopback-verifier-1234567890",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(loopback_authorize._status, 200);
        const loopback_request_id = extract_oauth_request_id(loopback_authorize._bytes.toString("utf-8"));
        const loopback_redirect = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: loopback_request_id, action: "authorize" },
          { cookie: admin_cookie },
        );
        assert.equal(loopback_redirect._status, 302);
        assert.equal(typeof loopback_redirect._headers.location, "string");
        assert.equal((loopback_redirect._headers.location as string).startsWith(`${requested_redirect}?`), true);
        const loopback_code = read_redirect_param(loopback_redirect._headers.location, "code");
        assert.ok(loopback_code);
        const loopback_token = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code: loopback_code,
            client_id: loopback_client._client_id,
            redirect_uri: requested_redirect,
            resource: `${base_url}/mcp`,
            code_verifier: "oauth-loopback-verifier-1234567890",
          },
        );
        assert.equal(loopback_token._status, 200);

        const mismatch_authorize = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: loopback_client._client_id,
          redirect_uri: requested_redirect,
          verifier: "oauth-loopback-mismatch-verifier-1234567890",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(mismatch_authorize._status, 200);
        const mismatch_request_id = extract_oauth_request_id(mismatch_authorize._bytes.toString("utf-8"));
        const mismatch_redirect_response = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: mismatch_request_id, action: "authorize" },
          { cookie: admin_cookie },
        );
        const mismatch_code = read_redirect_param(mismatch_redirect_response._headers.location, "code");
        const wrong_port_token = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code: mismatch_code,
            client_id: loopback_client._client_id,
            redirect_uri: "http://127.0.0.1:53159/callback",
            resource: `${base_url}/mcp`,
            code_verifier: "oauth-loopback-mismatch-verifier-1234567890",
          },
        );
        assert.equal(wrong_port_token._status, 400);
        assert.equal(read_json_response(wrong_port_token).error, "invalid_grant");

        const changed_path = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: loopback_client._client_id,
          redirect_uri: "http://127.0.0.1:53158/other",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(changed_path._status, 400);
        assert.equal(read_json_response(changed_path).error, "invalid_redirect_uri");

        const query_injection = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: loopback_client._client_id,
          redirect_uri: "http://127.0.0.1:53158/callback?extra=1",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(query_injection._status, 400);
        assert.equal(read_json_response(query_injection).error, "invalid_redirect_uri");

        const changed_host = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: loopback_client._client_id,
          redirect_uri: "http://0.0.0.0:53158/callback",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(changed_host._status, 400);
        assert.equal(read_json_response(changed_host).error, "invalid_redirect_uri");
      }, {
        _redirect_uris: () => ["http://127.0.0.1/callback"],
      });

      await with_oauth_client_metadata_server(async (localhost_client) => {
        const localhost_authorize = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: localhost_client._client_id,
          redirect_uri: "http://localhost:53158/callback",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(localhost_authorize._status, 200);
      }, {
        _redirect_uris: () => ["http://localhost/callback"],
      });

      await with_oauth_client_metadata_server(async (https_client) => {
        const exact_https = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: https_client._client_id,
          redirect_uri: "https://client.example/callback",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(exact_https._status, 200);

        const changed_https_port = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: https_client._client_id,
          redirect_uri: "https://client.example:53158/callback",
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(changed_https_port._status, 400);
        assert.equal(read_json_response(changed_https_port).error, "invalid_redirect_uri");
      }, {
        _redirect_uris: () => ["https://client.example/callback"],
      });

      await with_oauth_client_metadata_server(async (client) => {
        const no_session_authorize = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          state: "state-without-session",
        }));
        assert.equal(no_session_authorize._status, 200);
        const no_session_html = no_session_authorize._bytes.toString("utf-8");
        assert_oauth_login_page_contract(no_session_html);
        const login_request_id = extract_oauth_request_id(no_session_html);
        const resumed_consent = await post_oauth_form(
          `${base_url}/oauth/login`,
          {
            request_id: login_request_id,
            email: "admin@local.dev",
            password: "admin",
          },
        );
        assert.equal(resumed_consent._status, 200);
        assert.ok(cookie_header_from_set_cookie(resumed_consent._headers["set-cookie"]));
        assert_oauth_consent_page_contract(resumed_consent._bytes.toString("utf-8"));

        const verifier = "oauth-verifier-valid-1234567890";
        const consent = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          state: "state-value/+==",
          verifier,
        }), {
          _headers: { cookie: admin_cookie },
        });
        assert.equal(consent._status, 200);
        const consent_html = consent._bytes.toString("utf-8");
        assert_oauth_consent_page_contract(consent_html);
        assert.match(consent_html, /Codex Test Client/);
        assert.match(consent_html, /xpell:read xpell:write xpell:admin/);
        assert.match(consent_html, new RegExp(`${base_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/mcp`));
        const request_id = extract_oauth_request_id(consent_html);

        const issued_code_capture = await capture_console_output(async () =>
          post_oauth_form(
            `${base_url}/oauth/authorize/consent`,
            {
              request_id,
              action: "authorize",
            },
            { cookie: admin_cookie },
          )
        );
        const issued_code_redirect = issued_code_capture._result;
        assert.equal(issued_code_redirect._status, 302);
        assert.equal(read_redirect_param(issued_code_redirect._headers.location, "state"), "state-value/+==");
        assert.equal(read_redirect_param(issued_code_redirect._headers.location, "iss"), base_url);
        const code = read_redirect_param(issued_code_redirect._headers.location, "code");
        assert.ok(code);
        assert.equal(issued_code_capture._text.includes(code), false);

        const token_capture = await capture_console_output(async () =>
          post_oauth_form(
            `${base_url}/oauth/token`,
            {
              grant_type: "authorization_code",
              code,
              client_id: client._client_id,
              redirect_uri: client._redirect_uri,
              resource: `${base_url}/mcp`,
              code_verifier: verifier,
            },
          )
        );
        const token_response = token_capture._result;
        assert.equal(token_response._status, 200);
        const token_body = read_json_response(token_response);
        assert.equal(token_body.token_type, "Bearer");
        assert.equal(token_body.scope, "xpell:read xpell:write xpell:admin");
        assert.equal(typeof token_body.access_token, "string");
        assert.equal(token_body.access_token.length > 0, true);
        assert.equal(typeof token_body.refresh_token, "string");
        assert.equal(token_body.refresh_token.startsWith("xrt_"), true);
        assert.notEqual(token_body.refresh_token, token_body.access_token);
        assert.equal(token_capture._text.includes(code), false);
        assert.equal(token_capture._text.includes(token_body.access_token), false);
        assert.equal(token_capture._text.includes(token_body.refresh_token), false);

        const oauth_payload = NodePackage.verify_jwt(
          token_body.access_token,
          NodePackage.get_oauth_mcp_access_token_jwt_config(base_url),
        );
        assert.equal(oauth_payload.iss, base_url);
        assert.equal(oauth_payload.sub, "dev-user");
        assert.equal(oauth_payload._user_id, "dev-user");
        assert.equal(oauth_payload._account_id, "dev-account");
        assert.equal(oauth_payload._clearance_level, 100);
        assert.equal(oauth_payload._token_purpose, "mcp");
        assert.equal(oauth_payload._audience, "mcp");
        assert.equal(oauth_payload.aud, `${base_url}/mcp`);
        assert.equal(oauth_payload.resource, `${base_url}/mcp`);
        assert.equal(oauth_payload.scope, "xpell:read xpell:write xpell:admin");
        assert.equal(oauth_payload.client_id, client._client_id);
        assert.equal(typeof oauth_payload.grant_id, "string");
        assert.equal(typeof oauth_payload.family_id, "string");
        assert.equal(oauth_payload.grant_id, oauth_payload.family_id);
        assert.equal(typeof oauth_payload.jti, "string");
        assert.equal(token_body.expires_in, oauth_payload.exp - oauth_payload.iat);

        const all_refresh_records = await listXAuthOAuthRefreshTokenRecordsForTests();
        const refresh_records = all_refresh_records.filter((record) => record.family_id === oauth_payload.family_id);
        assert.equal(refresh_records.length, 1);
        assert.equal(refresh_records[0].token_hash.startsWith("hmac-sha256.v1."), true);
        assert.notEqual(refresh_records[0].token_hash, token_body.refresh_token);
        assert.equal(JSON.stringify(all_refresh_records).includes(token_body.refresh_token), false);
        assert.equal(refresh_records[0].client_id, client._client_id);
        assert.equal(refresh_records[0].resource, `${base_url}/mcp`);
        assert.deepEqual(refresh_records[0].scopes, ["xpell:read", "xpell:write", "xpell:admin"]);

        const refresh_data_file = path.join(
          work_folder,
          "xdb",
          "entities",
          "xauth_oauth_refresh_tokens",
          "_data.json",
        );
        const refresh_data_text = await readFile(refresh_data_file, "utf-8");
        assert.equal(refresh_data_text.includes(token_body.refresh_token), false);

        NodePackage.XDB.init({
          storage: new NodePackage.XDBStorageFS({ xdbFolder: path.join(work_folder, "xdb") }),
          enableCache: false,
          workFolder: work_folder,
        });
        await (NodePackage.XDB as any).onLoad();

        Date.now = () => (oauth_payload.iat + 2) * 1000;
        const refresh_capture = await capture_console_output(async () =>
          post_oauth_form(
            `${base_url}/oauth/token`,
            {
              grant_type: "refresh_token",
              refresh_token: token_body.refresh_token,
              client_id: client._client_id,
              resource: `${base_url}/mcp`,
            },
          )
        );
        Date.now = original_date_now;
        const refresh_response = refresh_capture._result;
        assert.equal(refresh_response._status, 200);
        const refreshed_body = read_json_response(refresh_response);
        assert.equal(refreshed_body.token_type, "Bearer");
        assert.equal(refreshed_body.scope, "xpell:read xpell:write xpell:admin");
        assert.equal(typeof refreshed_body.access_token, "string");
        assert.equal(typeof refreshed_body.refresh_token, "string");
        assert.notEqual(refreshed_body.access_token, token_body.access_token);
        assert.notEqual(refreshed_body.refresh_token, token_body.refresh_token);
        assert.equal(refresh_capture._text.includes(token_body.refresh_token), false);
        assert.equal(refresh_capture._text.includes(refreshed_body.refresh_token), false);

        const refreshed_payload = NodePackage.verify_jwt(
          refreshed_body.access_token,
          NodePackage.get_oauth_mcp_access_token_jwt_config(base_url),
        );
        assert.equal(refreshed_payload.jti !== oauth_payload.jti, true);
        assert.equal(refreshed_payload.exp > oauth_payload.exp, true);
        assert.equal(refreshed_payload._user_id, oauth_payload._user_id);
        assert.equal(refreshed_payload._account_id, oauth_payload._account_id);
        assert.equal(refreshed_payload._clearance_level, oauth_payload._clearance_level);
        assert.equal(refreshed_payload.client_id, client._client_id);
        assert.equal(refreshed_payload.resource, `${base_url}/mcp`);
        assert.equal(refreshed_payload.scope, oauth_payload.scope);
        assert.equal(refreshed_payload.grant_id, oauth_payload.grant_id);
        assert.equal(refreshed_payload.family_id, oauth_payload.family_id);

        const wrong_client_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: refreshed_body.refresh_token,
            client_id: `${client._client_id}/wrong`,
            resource: `${base_url}/mcp`,
          },
        );
        assert.equal(wrong_client_refresh._status, 400);
        assert.equal(read_json_response(wrong_client_refresh).error, "invalid_grant");

        const wrong_resource_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: refreshed_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp-wrong`,
          },
        );
        assert.equal(wrong_resource_refresh._status, 400);
        assert.equal(read_json_response(wrong_resource_refresh).error, "invalid_grant");

        const narrowed_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: refreshed_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
            scope: "xpell:read",
          },
        );
        assert.equal(narrowed_refresh._status, 200);
        const narrowed_body = read_json_response(narrowed_refresh);
        assert.equal(narrowed_body.scope, "xpell:read");

        const scope_escalation = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: narrowed_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
            scope: "xpell:read xpell:write",
          },
        );
        assert.equal(scope_escalation._status, 400);
        assert.equal(read_json_response(scope_escalation).error, "invalid_scope");

        const replay_old_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: refreshed_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
          },
        );
        assert.equal(replay_old_refresh._status, 400);
        assert.equal(read_json_response(replay_old_refresh).error, "invalid_grant");

        const revoked_descendant = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: narrowed_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
          },
        );
        assert.equal(revoked_descendant._status, 400);
        assert.equal(read_json_response(revoked_descendant).error, "invalid_grant");

        const family_records = await listXAuthOAuthRefreshTokenRecordsForTests();
        const same_family = family_records.filter((record) => record.family_id === oauth_payload.family_id);
        assert.equal(same_family.length >= 3, true);
        assert.equal(same_family.every((record) => Boolean(record.revoked_at)), true);

        process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN = "1s";
        const short_refresh_issue = await issue_oauth_token_via_consent(
          base_url,
          client,
          admin_cookie,
          { state: "short-refresh" },
        );
        const short_refresh_payload = NodePackage.verify_jwt(
          short_refresh_issue._token_body.access_token,
          NodePackage.get_oauth_mcp_access_token_jwt_config(base_url),
        );
        Date.now = () => (short_refresh_payload.iat + 2) * 1000;
        const expired_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: short_refresh_issue._token_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
          },
        );
        Date.now = original_date_now;
        delete process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN;
        assert.equal(expired_refresh._status, 400);
        assert.equal(read_json_response(expired_refresh).error, "invalid_grant");

        const revoked_issue = await issue_oauth_token_via_consent(
          base_url,
          client,
          admin_cookie,
          { state: "revoked-refresh" },
        );
        const revoke_capture = await capture_console_output(async () =>
          post_oauth_form(
            `${base_url}/oauth/revoke`,
            {
              token: revoked_issue._token_body.refresh_token,
              token_type_hint: "refresh_token",
              client_id: client._client_id,
              resource: `${base_url}/mcp`,
            },
          )
        );
        assert.equal(revoke_capture._result._status, 200);
        assert.equal(revoke_capture._text.includes(revoked_issue._token_body.refresh_token), false);
        const revoked_refresh = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: revoked_issue._token_body.refresh_token,
            client_id: client._client_id,
            resource: `${base_url}/mcp`,
          },
        );
        assert.equal(revoked_refresh._status, 400);
        assert.equal(read_json_response(revoked_refresh).error, "invalid_grant");

        const oauth_mcp_response = await post_http_bytes(
          `${base_url}/mcp`,
          Buffer.from(JSON.stringify(mcp_rpc(3, "tools/call", {
            name: "xpell_server_status",
            arguments: {},
          }))),
          {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token_body.access_token}`,
          },
        );
        assert.equal(oauth_mcp_response._status, 200);
        assert.equal(read_mcp_sse_response(oauth_mcp_response._bytes.toString("utf-8")).result.structuredContent._ok, true);

        const reuse_response = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code,
            client_id: client._client_id,
            redirect_uri: client._redirect_uri,
            resource: `${base_url}/mcp`,
            code_verifier: verifier,
          },
        );
        assert.equal(reuse_response._status, 400);
        assert.equal(read_json_response(reuse_response).error, "invalid_grant");

        const bad_verifier = "oauth-verifier-invalid-1234567890";
        const bad_code_page = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          verifier: bad_verifier,
        }), {
          _headers: { cookie: admin_cookie },
        });
        const bad_code_request_id = extract_oauth_request_id(bad_code_page._bytes.toString("utf-8"));
        const bad_code_redirect = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: bad_code_request_id, action: "authorize" },
          { cookie: admin_cookie },
        );
        const bad_code = read_redirect_param(bad_code_redirect._headers.location, "code");
        const invalid_verifier_response = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code: bad_code,
            client_id: client._client_id,
            redirect_uri: client._redirect_uri,
            resource: `${base_url}/mcp`,
            code_verifier: "wrong-verifier-1234567890",
          },
        );
        assert.equal(invalid_verifier_response._status, 400);
        assert.equal(read_json_response(invalid_verifier_response).error, "invalid_grant");

        const mismatch_page = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          verifier,
        }), {
          _headers: { cookie: admin_cookie },
        });
        const mismatch_request_id = extract_oauth_request_id(mismatch_page._bytes.toString("utf-8"));
        const mismatch_redirect = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: mismatch_request_id, action: "authorize" },
          { cookie: admin_cookie },
        );
        const mismatch_code = read_redirect_param(mismatch_redirect._headers.location, "code");
        const redirect_mismatch = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code: mismatch_code,
            client_id: client._client_id,
            redirect_uri: `${client._redirect_uri}-alt`,
            resource: `${base_url}/mcp`,
            code_verifier: verifier,
          },
        );
        assert.equal(redirect_mismatch._status, 400);
        assert.equal(read_json_response(redirect_mismatch).error, "invalid_grant");

        const read_only_page = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          scope: "xpell:read",
          verifier,
        }), {
          _headers: { cookie: admin_cookie },
        });
        const read_only_request_id = extract_oauth_request_id(read_only_page._bytes.toString("utf-8"));
        const read_only_redirect = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: read_only_request_id, action: "authorize" },
          { cookie: admin_cookie },
        );
        const read_only_code = read_redirect_param(read_only_redirect._headers.location, "code");
        const read_only_token_response = await post_oauth_form(
          `${base_url}/oauth/token`,
          {
            grant_type: "authorization_code",
            code: read_only_code,
            client_id: client._client_id,
            redirect_uri: client._redirect_uri,
            resource: `${base_url}/mcp`,
            code_verifier: verifier,
          },
        );
        assert.equal(read_only_token_response._status, 200);
        const read_only_token = read_json_response(read_only_token_response).access_token;
        const insufficient_scope = await post_http_bytes(
          `${base_url}/mcp`,
          Buffer.from(JSON.stringify(mcp_rpc(4, "tools/call", {
            name: "xpell_apply_view_edit",
            arguments: {
              app_id: "app",
              env: "default",
              view_id: "main",
              edit_action: "set-property",
              target_id: "root",
              property_name: "title",
              property_value: "Updated",
            },
          }))),
          {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${read_only_token}`,
          },
        );
        assert.equal(insufficient_scope._status, 200);
        const insufficient_scope_body = read_mcp_sse_response(insufficient_scope._bytes.toString("utf-8"));
        assert.equal(insufficient_scope_body.result.isError, true);
        assert.equal(
          insufficient_scope_body.result.structuredContent._error._code,
          "E_XMCP_INSUFFICIENT_SCOPE",
        );

        const cancelled_page = await read_http_bytes(oauth_authorize_url(base_url, {
          client_id: client._client_id,
          redirect_uri: client._redirect_uri,
          state: "cancel-state",
        }), {
          _headers: { cookie: admin_cookie },
        });
        const cancelled_request_id = extract_oauth_request_id(cancelled_page._bytes.toString("utf-8"));
        const cancelled = await post_oauth_form(
          `${base_url}/oauth/authorize/consent`,
          { request_id: cancelled_request_id, action: "cancel" },
          { cookie: admin_cookie },
        );
        assert.equal(cancelled._status, 302);
        assert.equal(read_redirect_param(cancelled._headers.location, "error"), "access_denied");
        assert.equal(read_redirect_param(cancelled._headers.location, "state"), "cancel-state");
      });

      const browser_session_mcp = await post_http_bytes(
        `${base_url}/mcp`,
        Buffer.from(JSON.stringify(mcp_rpc(2, "tools/list", {}))),
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${browser_session_token}`,
          cookie: admin_cookie,
        },
      );
      assert.equal(browser_session_mcp._status, 401);
      assert.equal(
        browser_session_mcp._headers["www-authenticate"],
        `Bearer resource_metadata="${base_url}/.well-known/oauth-protected-resource/mcp", scope="xpell:read xpell:write xpell:admin"`,
      );
      const browser_session_mcp_serialized = JSON.stringify({
        headers: browser_session_mcp._headers,
        text: browser_session_mcp._bytes.toString("utf-8"),
      });
      assert.equal(browser_session_mcp_serialized.includes(browser_session_token), false);

      const issued_capture = await capture_console_output(async () =>
        post_http_bytes(
          `${base_url}/xauth/mcp-token`,
          Buffer.from("{}"),
          {
            "content-type": "application/json",
            cookie: admin_cookie,
          },
        )
      );
      const issued = issued_capture._result;
      assert.equal(issued._status, 200);
      const issued_body = read_json_response(issued);
      assert.equal(issued_body._ok, true);
      assert.equal(typeof issued_body._token, "string");
      assert.equal(issued_body._token.length > 0, true);
      assert.equal(typeof issued_body._expires_at, "number");
      assert.equal(issued_body._clearance_level, 100);
      assert.notEqual(issued_body._token, browser_session_token);
      assert.equal(issued_capture._text.includes(issued_body._token), false);
      assert.equal(issued_capture._text.includes(browser_session_token), false);
      assert.equal(issued_capture._text.includes("admin"), false);

      const mcp_payload = NodePackage.verify_jwt(issued_body._token);
      assert.equal(mcp_payload._user_id, "dev-user");
      assert.equal(mcp_payload._account_id, "dev-account");
      assert.equal(mcp_payload._clearance_level, 100);
      assert.equal(mcp_payload._token_purpose, "mcp");
      assert.equal(mcp_payload._audience, "mcp");
      assert.equal(mcp_payload.exp, issued_body._expires_at);

      const authorized_mcp_token: any = await NodePackage._x.execute({
        _module: "xauth",
        _op: "authorize_req",
        _params: {
          _ctx: {
            _source: "test",
            _meta: {
              _token: issued_body._token,
            },
          },
          _token: issued_body._token,
        },
      } as any);
      assert.equal(authorized_mcp_token._authenticated, true);
      assert.equal(authorized_mcp_token._user_id, "dev-user");
      assert.equal(authorized_mcp_token._token_purpose, "mcp");
      assert.equal(authorized_mcp_token._audience, "mcp");

      const mcp_response = await post_http_bytes(
        `${base_url}/mcp`,
        Buffer.from(JSON.stringify(mcp_rpc(1, "tools/list", {}))),
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${issued_body._token}`,
        },
      );
      assert.equal(mcp_response._status, 200);
      const mcp_body = read_mcp_sse_response(mcp_response._bytes.toString("utf-8"));
      const tools = Array.isArray(mcp_body?.result?.tools) ? mcp_body.result.tools : [];
      assert.ok(tools.some((tool: any) => tool?.name === "xpell_server_status"));

      const low_clearance_token = NodePackage.sign_jwt({
        _user_id: "low-user",
        _account_id: "low-account",
        _clearance_level: 99,
        _auth_type: "jwt",
      });
      const low_clearance = await post_http_bytes(
        `${base_url}/xauth/mcp-token`,
        Buffer.from("{}"),
        {
          "content-type": "application/json",
          cookie: `xauth_session=${encodeURIComponent(low_clearance_token)}`,
        },
      );
      assert.equal(low_clearance._status, 403);
      const low_clearance_text = low_clearance._bytes.toString("utf-8");
      assert.equal(low_clearance_text.includes(low_clearance_token), false);
      assert.equal(JSON.stringify(read_json_response(low_clearance)).includes("_token"), false);

      try {
        process.env.XAUTH_JWT_EXPIRES_IN = "1s";
        Date.now = () => 1_000_000;
        const expired_session_token = NodePackage.sign_jwt({
          _user_id: "expired-user",
          _account_id: "expired-account",
          _clearance_level: 100,
          _auth_type: "jwt",
        });
        Date.now = () => 3_000_000;
        const expired_session = await post_http_bytes(
          `${base_url}/xauth/mcp-token`,
          Buffer.from("{}"),
          {
            "content-type": "application/json",
            cookie: `xauth_session=${encodeURIComponent(expired_session_token)}`,
          },
        );
        assert.equal(expired_session._status, 401);
        const expired_session_text = expired_session._bytes.toString("utf-8");
        assert.equal(expired_session_text.includes(expired_session_token), false);
        assert.equal(JSON.stringify(read_json_response(expired_session)).includes("_token"), false);
      } finally {
        Date.now = original_date_now;
        delete process.env.XAUTH_JWT_EXPIRES_IN;
      }

      try {
        process.env.XAUTH_MCP_TOKEN_EXPIRES_IN = "1s";
        Date.now = () => 1_000_000;
        const short_lived = await post_http_bytes(
          `${base_url}/xauth/mcp-token`,
          Buffer.from("{}"),
          {
            "content-type": "application/json",
            cookie: admin_cookie,
          },
        );
        assert.equal(short_lived._status, 200);
        const short_lived_body = read_json_response(short_lived);
        Date.now = () => 3_000_000;
        await assert.rejects(
          async () =>
            NodePackage._x.execute({
              _module: "xauth",
              _op: "authorize_req",
              _params: {
                _token: short_lived_body._token,
              },
            } as any),
          (err: any) => err?._code === "E_XAUTH_INVALID_TOKEN",
        );
      } finally {
        Date.now = original_date_now;
        delete process.env.XAUTH_MCP_TOKEN_EXPIRES_IN;
      }
    }, {
      _mcp_settings: {
        enabled: true,
        transport: "streamable-http",
        path: "/mcp",
        require_auth: true,
        allow_unauthenticated_localhost: false,
      },
    });
  } finally {
    Date.now = original_date_now;
    restore_env("XAUTH_MCP_TOKEN_EXPIRES_IN", original_mcp_expires);
    restore_env("XAUTH_JWT_EXPIRES_IN", original_jwt_expires);
    restore_env("XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN", original_oauth_refresh_expires);
    restore_env("XAUTH_MCP_OAUTH_GRANT_EXPIRES_IN", original_oauth_grant_expires);
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_xnode_planning_contract_tests() {
  const personal = NodePackage.normalize_xvibe_planning_state(planning_state());
  assert.equal(personal._contract_version, 1);
  assert.equal(personal._app_archetype, "personal-list");
  assert.equal(personal._scope, "personal");
  assert.equal(personal._proposed._entities[0] && (personal._proposed._entities[0] as any)._id, "shopping_item");

  const business_question = planning_question({
    _id: "primary_user",
    _type: "single",
    _question: "Who owns customer records?",
    _options: ["Sales", "Support"],
  });
  const business = NodePackage.normalize_xvibe_planning_state(planning_state({
    _app_archetype: "business-app",
    _scope: "business",
    _domain: "crm",
    _goal: "Build a CRM",
    _questions: [business_question],
    _unanswered: ["primary_user"],
    _current_question: business_question,
    _proposed: {
      _entities: [{ _id: "customer" }],
      _views: [{ _id: "dashboard" }],
      _flows: [{ _id: "create-customer" }],
      _server_modules: [],
    },
  }));
  assert.equal(business._app_archetype, "business-app");
  assert.equal(business._domain, "crm");

  const manual_question = planning_question({
    _id: "case_scope",
    _type: "single",
    _question: "Which legal case scope should this audit?",
    _options: ["Single case", "Matter portfolio"],
  });
  const manual_ended = NodePackage.normalize_xvibe_planning_state(planning_state({
    _planner_version: "v2",
    _goal: "Build a legal case audit app",
    _questions: [manual_question],
    _unanswered: ["case_scope"],
    _current_question: manual_question,
    _runtime_lifecycle: {
      _status: "completed",
      _phase: "manual",
      _confirmed: false,
      _plan_ready: false,
      _guide_available: false,
      _executable_guide_actions_available: false,
    },
  }));
  assert.equal(manual_ended._status, "manual");
  assert.equal(manual_ended._runtime_lifecycle._status, "completed");
  assert.equal(manual_ended._runtime_lifecycle._phase, "manual");
  assert.equal(manual_ended._runtime_lifecycle._confirmed, false);
  assert.equal(manual_ended._current_question, null);
  assert.deepEqual(manual_ended._unanswered, ["case_scope"]);

  const custom_personal = NodePackage.normalize_xvibe_planning_state(planning_state({
    _metadata: { _selected_type: "Custom" },
    _app_archetype: "personal-list",
    _scope: "personal",
  }));
  assert.equal(custom_personal._metadata._selected_type, "Custom");
  assert.equal(custom_personal._app_archetype, "personal-list");
  assert.equal(custom_personal._scope, "personal");

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state({
      _contract_version: 1,
      _type: "project-plan",
      _stage: "planning",
      _status: "awaiting-answer",
    }),
    NodePackage.XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
  );

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state(planning_state({
      _contract_version: 999,
    })),
    NodePackage.XNODE_PLANNING_ERR.UNSUPPORTED_CONTRACT_VERSION,
  );

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state(planning_state({
      _current_question: null,
    })),
    NodePackage.XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
  );

  const single_choice = planning_state();
  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_answer({
      _planning_state: single_choice,
      _question_id: "primary_user",
      _answer: "Sales",
    }),
    NodePackage.XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
  );

  const legacy_question = planning_question({
    _id: "primary_user",
    _type: "single",
    _question: "Who will use it?",
    _suggestions: ["Personal user", "Team"],
  });
  const legacy = NodePackage.normalize_xvibe_planning_state({
    _type: "project-plan",
    _stage: "planning",
    _status: "collecting-information",
    _questions: [legacy_question],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: { _id: "primary_user" },
  });
  assert.equal(legacy._contract_version, 1);
  assert.deepEqual(legacy._questions[0]._options, ["Personal user", "Team"]);
  assert.equal(legacy._compatibility?._legacy_project_plan, true);
  assert.deepEqual(legacy._proposed, {
    _entities: [],
    _views: [],
    _flows: [],
    _server_modules: [],
  });

  const neutral_custom = NodePackage.normalize_xvibe_planning_state({
    _contract_version: 1,
    _type: "project-plan",
    _stage: "planning",
    _status: "awaiting-answer",
    _app_archetype: "personal-list",
    _scope: "unknown",
    _questions: [planning_question()],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: { _id: "primary_user" },
  });
  assert.equal(neutral_custom._scope, "unknown");
  assert.equal(neutral_custom._domain, undefined);
  assert.deepEqual(neutral_custom._proposed._entities, []);
  assert.deepEqual(neutral_custom._proposed._views, []);

  const complete_shopping = NodePackage.normalize_xvibe_planning_state(
    shopping_list_plan(),
  );
  assert.equal(complete_shopping._ready, true);
  assert.deepEqual(complete_shopping._runtime_lifecycle, {
    _status: "planning",
    _phase: "ready-for-confirmation",
    _planning_status: "ready-for-confirmation",
    _plan_ready: true,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  });
  assert.equal(complete_shopping._selected_app_type, "custom");
  assert.equal(complete_shopping._inferred_archetype, "personal_list");
  assert.equal(complete_shopping._scope, "personal");
  assert.equal(complete_shopping._summary._goal, "Build a personal shopping list app");
  assert.deepEqual(complete_shopping._summary._proposed_entities, ["shopping_item"]);
  assert.deepEqual(complete_shopping._summary._proposed_views, ["shopping_list"]);
  assert.deepEqual(complete_shopping._summary._proposed_flows, ["add_shopping_item", "mark_purchased"]);
  assert.ok(
    complete_shopping._warnings.some(
      (warning: any) => warning._id === "optional_decision_unresolved:sync_behavior",
    ),
  );

  const incomplete_shopping = NodePackage.normalize_xvibe_planning_state(
    incomplete_shopping_list_plan(),
  );
  assert.equal(incomplete_shopping._ready, false);
  assert.deepEqual(incomplete_shopping._runtime_lifecycle, {
    _status: "planning",
    _phase: "collecting-decisions",
    _planning_status: "collecting-information",
    _plan_ready: false,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  });
  assert.ok(
    incomplete_shopping._blockers.some(
      (blocker: any) => blocker._id === "current_question_active",
    ),
  );
  assert.ok(
    incomplete_shopping._blockers.some(
      (blocker: any) => blocker._id === "required_decision_unresolved:list_structure",
    ),
  );

  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_readiness({
      _type: "xvibe-initial-planning-confirmation-readiness",
      _ready: "yes",
    }),
    NodePackage.XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
  );
  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_readiness({
      ...NodePackage.evaluate_xvibe_planning_readiness(shopping_list_plan()),
      _normalized_plan: undefined,
    }),
    NodePackage.XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
  );

  const legacy_ready = NodePackage.normalize_xvibe_planning_state({
    ...shopping_list_plan({
      _contract_version: undefined,
      _domain: "personal-list",
      _selected_app_type: undefined,
      _inferred_archetype: undefined,
      _planning_status: undefined,
      _questions: [
        planning_question({
          _id: "list_structure",
          _type: "single",
          _question: "How should shopping lists be organized?",
          _options: ["Single list", "Multiple named lists"],
          _answer: "Single list",
        }),
        planning_question({
          _id: "list_item_fields",
          _type: "multi",
          _question: "Which item fields should be included?",
          _options: ["Name", "Quantity", "Status"],
          _answer: ["Name", "Quantity", "Status"],
        }),
        planning_question({
          _id: "completed_item_behavior",
          _type: "single",
          _question: "What should happen when an item is completed?",
          _options: ["Mark purchased", "Archive"],
          _answer: "Mark purchased",
        }),
      ],
      _answers: {
        list_structure: "Single list",
        list_item_fields: ["Name", "Quantity", "Status"],
        completed_item_behavior: "Mark purchased",
      },
      _current_question: null,
    }),
  });
  assert.equal(legacy_ready._compatibility?._legacy_project_plan, true);
  assert.equal(legacy_ready._ready, true);

  const no_fallback = NodePackage.normalize_xvibe_planning_state(planning_state({
    _domain: "generic-business",
    _proposed: {
      _entities: [],
      _views: [],
      _flows: [],
      _server_modules: [],
    },
  }));
  assert.equal(no_fallback._ready, false);
  assert.deepEqual(no_fallback._proposed._entities, []);
  assert.ok(
    no_fallback._blockers.some(
      (blocker: any) => blocker._id === "proposed_entities_missing",
    ),
  );

  const normalized_memory = (new NodePackage.ServerXVMModule() as any)
    .normalize_project_memory({
      _planner_version: "v2",
      _initial_planner_version: "v2",
      _confirmed_planner_version: "v2",
      _confirmed_application_plan_v2: {
        _type: "xvibe-planner-v2-canonical-application-plan",
        _contract_version: 1,
        _planner_version: "v2",
      },
    }, {
      _touch_updated_at: false,
    });
  assert.equal(normalized_memory._planner_version, "v2");
  assert.equal(normalized_memory._initial_planner_version, "v2");
  assert.equal(normalized_memory._confirmed_planner_version, "v2");
  assert.equal(
    normalized_memory._confirmed_application_plan_v2._planner_version,
    "v2",
  );

  const original_execute = (_x as any).execute;
  const planning_module = new NodePackage.XPlanningModule();
  try {
    const execute_calls: any[] = [];
    const semantic_plan_ref = {
      _type: "xvibe-semantic-generation-plan",
      _version: "0.1.0",
      _source: "confirmed_initial_plan",
    };
    let mock_project_memory: any = {
      _stage: "building",
      _confirmed_initial_plan: shopping_list_plan(),
      _semantic_generation_plan: {
        ...semantic_plan_ref,
        _entities: [
          {
            _entity_id: "shopping_item",
            _title: "Shopping Item",
            _fields: [
              { _name: "name" },
              { _name: "quantity" },
              { _name: "status" },
            ],
          },
        ],
      },
      _current_focus: "Working Shopping List",
      _milestones: [
        {
          _id: "working-shopping-list",
          _title: "Working Shopping List",
          _items: [
            {
              _id: "shopping-item-crud",
              _title: "Shopping Item CRUD",
              _completed: false,
              _semantic_type: "crud",
              _artifact_type: "crud",
              _entity_id: "shopping_item",
              _entity_name: "shopping_item",
            },
            {
              _id: "mark-purchased",
              _title: "Add Mark Purchased behavior",
              _completed: false,
              _semantic_type: "flow",
              _artifact_type: "flow",
              _entity_id: "shopping_item",
              _flow_id: "mark-shopping-item-purchased",
            },
          ],
        },
      ],
      _completed: [],
      _achievements: [],
    };
    let mock_guide_recommendation: any = {
      _title: "Add Shopping Item CRUD",
      _reason: "Current focus is Working Shopping List.",
      _type: "crud",
      _priority: 100,
      _semantic_plan_ref: semantic_plan_ref,
      _expected_artifacts: [
        { _artifact_type: "entity", _id: "shopping_item" },
        { _artifact_type: "flow", _id: "create-shopping_item" },
        { _artifact_type: "view", _id: "shopping_item-form" },
        { _artifact_type: "view", _id: "shopping_item-list" },
      ],
      _action: {
        _prompt: "Add Shopping Item CRUD.",
        _semantic_plan_ref: semantic_plan_ref,
        _artifact_type: "entity",
        _artifact_request: {
          _graph_type: "crud",
          _entity_name: "shopping_item",
          _fields: [
            { _name: "name" },
            { _name: "quantity" },
            { _name: "status" },
          ],
        },
        _execution_payload: {
          _module: "xvibe",
          _op: "execute-execution-graph",
          _params: {
            _app_id: "shopping-app",
            _env: "test",
            _graph_type: "crud",
            _entity_name: "shopping_item",
            _fields: [
              { _name: "name" },
              { _name: "quantity" },
              { _name: "status" },
            ],
          },
        },
        _resolution: {
          _type: "execution-capability",
          _source: "execution-capability-registry",
          _confidence: 0.9,
          _capability_id: "entity-crud",
          _module: "xvibe",
          _op: "execute-execution-graph",
          _supported: true,
        },
      },
    };
    const next_guide_recommendation: any = {
      _title: "Add Mark Purchased behavior",
      _reason: "Shopping Item CRUD foundation exists.",
      _type: "flow",
      _priority: 90,
      _semantic_plan_ref: semantic_plan_ref,
      _action: {
        _prompt: "Add Mark Purchased behavior.",
        _semantic_plan_ref: semantic_plan_ref,
        _resolution: {
          _type: "runtime-module-op",
          _source: "runtime-skill-registry",
          _confidence: 0.8,
          _module: "xvibe",
          _op: "apply-artifact-request",
          _supported: true,
        },
      },
    };
    let mock_guide_state: any = { _available: true, _reason: "ready" };
    let guide_crud_execution_count = 0;
    (_x as any).execute = async (cmd: any) => {
      execute_calls.push(cmd);
      if (cmd._module === "xvibe" && cmd._op === "analyze-message") {
        if (cmd._params?._runtime_context?._planner_version === "v2") {
          return {
            _ok: true,
            _result: {
              _intent: {
                _artifact_type: "project-plan",
                _artifact_request: {
                  ...shopping_list_plan({
                    _planner_version: "v2",
                    _planning_status: "blocked",
                    _status: "blocked",
                    _questions: [],
                    _answers: {},
                    _current_question: null,
                    _unanswered_required_question_ids: [],
                    _unanswered: [],
                  }),
                  _canonical_application_plan: {
                    _type: "xvibe-planner-v2-canonical-application-plan",
                    _contract_version: 1,
                    _planner_version: "v2",
                    _intent: null,
                    _concepts: [],
                    _capability_plan: null,
                    _decisions: [],
                    _compiled_application: {
                      _entities: [],
                      _views: [],
                      _flows: [],
                      _modules: [],
                    },
                    _questions: [],
                    _readiness: {
                      _status: "blocked",
                      _ready: false,
                      _blockers: [
                        {
                          _id: "planner_v2_not_implemented",
                          _message: "Planner V2 is not implemented yet.",
                        },
                      ],
                      _warnings: [],
                    },
                  },
                },
              },
            },
          };
        }
        return {
          _ok: true,
          _result: {
            _intent: {
              _artifact_type: "project-plan",
              _artifact_request: shopping_list_plan(),
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "get-conversation") {
        return {
          _ok: true,
          _result: {
            _conversation: {
              _id: "planning-chat",
              _planning_draft: shopping_list_plan(),
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "resume-planning") {
        return {
          _ok: true,
          _result: {
            _operation: "resume-planning",
            _planning: shopping_list_plan(),
            _runtime_lifecycle: {
              _status: "planning",
              _phase: "ready-for-confirmation",
              _confirmed: false,
              _plan_ready: true,
              _guide_available: false,
              _executable_guide_actions_available: false,
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "end-planning") {
        return {
          _ok: true,
          _result: {
            _operation: "end-planning",
            _planning: {
              ...incomplete_shopping_list_plan(),
              _status: "manual",
              _runtime_lifecycle: {
                _status: "completed",
                _phase: "manual",
                _confirmed: false,
                _plan_ready: false,
                _guide_available: false,
                _executable_guide_actions_available: false,
              },
            },
            _runtime_lifecycle: {
              _status: "completed",
              _phase: "manual",
              _confirmed: false,
              _plan_ready: false,
              _guide_available: false,
              _executable_guide_actions_available: false,
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "confirm-project-plan") {
        return {
          _ok: true,
          _result: {
            _confirmed: true,
            _memory: { _project: { _stage: "planning-complete" } },
          },
        };
      }
      if (cmd._module === "server-xvm" && cmd._op === "get-project-memory") {
        if (cmd._params._app_id === "draft-app") {
          return {
            _ok: true,
            _result: {
              _memory: {
                _stage: "planning",
                _current_focus: "",
                _milestones: [],
              },
            },
          };
        }
        return {
          _ok: true,
          _result: {
            _memory: {
              _stage: "building",
              ...mock_project_memory,
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "get-guide-recommendation") {
        return {
          _ok: true,
          _result: {
            _recommendation:
              guide_crud_execution_count > 0 && mock_guide_recommendation
                ? next_guide_recommendation
                : mock_guide_recommendation,
            _guide_state: mock_guide_state,
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "execute-execution-graph") {
        assert.equal(cmd._params._graph_type, "crud");
        assert.equal(cmd._params._entity_name, "shopping_item");
        assert.equal(cmd._params._app_id, "shopping-app");
        assert.equal(cmd._params._env, "test");
        assert.notEqual(cmd._params._title, "Add Shopping Item CRUD");
        guide_crud_execution_count += 1;
        mock_project_memory = {
          ...mock_project_memory,
          _milestones: mock_project_memory._milestones.map((milestone: any) =>
            milestone._id === "working-shopping-list"
              ? {
                ...milestone,
                _items: milestone._items.map((item: any) =>
                  item._id === "shopping-item-crud"
                    ? { ...item, _completed: true }
                    : item
                ),
              }
              : milestone
          ),
        };
        if (guide_crud_execution_count > 1) {
          return {
            _ok: true,
            _graph_type: "crud",
            _entity_name: "shopping_item",
            _nodes: [],
            _summary: {
              _existing: 4,
              _created: 0,
              _skipped: 0,
              _failed: 0,
            },
          };
        }
        return {
          _ok: true,
          _graph_type: "crud",
          _entity_name: "shopping_item",
          _nodes: [
            {
              _id: "shopping_item",
              _artifact_type: "entity",
              _artifact_id: "shopping_item",
              _status: "created",
            },
          ],
          _summary: {
            _existing: 0,
            _created: 4,
            _skipped: 0,
            _failed: 0,
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "update-conversation-artifact") {
        assert.equal(cmd._params._app_id, "shopping-app");
        assert.equal(cmd._params._env, "test");
        assert.equal(cmd._params._conversation_id, "planning-chat");
        assert.equal(cmd._params._message_id, "guide-message");
        assert.equal(cmd._params._artifact_status, "done");
        assert.equal(
          cmd._params._artifact_result._type,
          "guide-recommendation-execution",
        );
        assert.equal(
          cmd._params._artifact_result._recommendation._title,
          "Add Shopping Item CRUD",
        );
        return {
          _ok: true,
          _result: {
            _updated: true,
          },
        };
      }
      throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
    };

    const start_res = await (planning_module as any)._start_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _message: "I want to build shopping list for myself",
        _runtime_context: {
          _guide_active_recommendation: {
            _title: "Unsafe early guide",
            _reason: "Should not be forwarded while planning.",
            _type: "crud",
            _priority: 100,
            _action: {
              _prompt: "Create CRUD before confirmation.",
            },
          },
        },
      },
    });
    assert.equal(start_res._ok, true);
    assert.equal(start_res._result._planning._selected_app_type, "custom");
    assert.equal(start_res._result._planning._planner_version, "v1");
    assert.equal(start_res._result._planning._inferred_archetype, "personal_list");
    assert.equal(start_res._result._planning._scope, "personal");
    assert.equal(start_res._result._planning._ready, true);
    assert.deepEqual(start_res._result._planning._blockers, []);
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "analyze-message" &&
          cmd._params._runtime_context._stage === "planning" &&
          cmd._params._runtime_context._guide_active_recommendation === undefined &&
          cmd._params._runtime_context._runtime_lifecycle._guide_available === false,
      ),
      true,
    );

    execute_calls.length = 0;
    const explicit_v2_start_res = await (planning_module as any)._start_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _message: "I want to build shopping list for myself",
        _planner_version: "v2",
      },
    });
    assert.equal(explicit_v2_start_res._ok, true);
    assert.equal(explicit_v2_start_res._result._planning._planner_version, "v2");
    assert.equal(explicit_v2_start_res._result._planning._status, "blocked");
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "analyze-message" &&
          cmd._params._runtime_context._planner_version === "v2",
      ),
      true,
    );

    execute_calls.length = 0;
    const get_res = await (planning_module as any)._get_planning_state({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    const resume_res = await (planning_module as any)._resume_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(get_res._ok, true);
    assert.equal(resume_res._ok, true);
    assert.deepEqual(
      resume_res._result._planning._summary,
      get_res._result._planning._summary,
    );
    assert.equal(resume_res._result._operation, "resume-planning");
    assert.equal(resume_res._result._planning._runtime_lifecycle._status, "planning");
    assert.equal(get_res._result._planning._inferred_archetype, "personal_list");
    assert.notEqual(get_res._result._planning._domain, "generic-business");
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "get-conversation",
      ).length,
      1,
    );
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "resume-planning",
      ).length,
      1,
    );

    execute_calls.length = 0;
    const end_res = await (planning_module as any)._end_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(end_res._ok, true);
    assert.equal(end_res._result._operation, "end-planning");
    assert.equal(end_res._result._planning._status, "manual");
    assert.equal(end_res._result._planning._runtime_lifecycle._status, "completed");
    assert.equal(end_res._result._planning._runtime_lifecycle._phase, "manual");
    assert.equal(end_res._result._planning._runtime_lifecycle._confirmed, false);
    assert.deepEqual(end_res._result._planning._unanswered, ["list_structure"]);
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "end-planning",
      ).length,
      1,
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "server-xvm" ||
          String(cmd._op ?? "").includes("generate") ||
          String(cmd._op ?? "").includes("build"),
      ),
      false,
    );

    execute_calls.length = 0;
    const invalid_state = incomplete_shopping_list_plan();
    const invalid_state_before = JSON.stringify(invalid_state);
    const invalid_answer_res = await (planning_module as any)._answer_planning_question({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _question_id: "list_structure",
        _answer: "Enterprise dashboard",
        _planning_state: invalid_state,
      },
    });
    assert.equal(invalid_answer_res._ok, false);
    assert.equal(
      invalid_answer_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
    );
    assert.equal(JSON.stringify(invalid_state), invalid_state_before);
    assert.equal(execute_calls.length, 0);

    execute_calls.length = 0;
    const answer_res = await (planning_module as any)._answer_planning_question({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _question_id: "list_structure",
        _answer: "Single list",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(answer_res._ok, true);
    assert.equal(answer_res._result._planning._ready, true);
    assert.equal(answer_res._result._planning._inferred_archetype, "personal_list");
    assert.equal(answer_res._result._planning._summary._goal, "Build a personal shopping list app");
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "analyze-message",
      ),
      true,
    );

    execute_calls.length = 0;
    const blocked_confirm_res = await (planning_module as any)._confirm_project_plan({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(blocked_confirm_res._ok, false);
    assert.equal(
      blocked_confirm_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.PLANNING_INCOMPLETE,
    );
    assert.ok(blocked_confirm_res._result._meta._blockers.length > 0);
    assert.ok(blocked_confirm_res._result._meta._summary._goal.includes("shopping list"));
    assert.equal(execute_calls.length, 0);

    const confirm_res = await (planning_module as any)._confirm_project_plan({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: shopping_list_plan(),
      },
    });
    assert.equal(confirm_res._ok, true);
    assert.equal(confirm_res._result._confirmed, true);
    assert.equal(confirm_res._result._runtime_lifecycle._status, "confirmed");
    assert.equal(confirm_res._result._runtime_lifecycle._guide_available, true);
    assert.deepEqual(confirm_res._result._memory, {
      _project: { _stage: "planning-complete" },
    });
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "confirm-project-plan",
      ).length,
      1,
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "server-xvm" && cmd._op === "patch-project-memory",
      ),
      false,
    );

    execute_calls.length = 0;
    const blocked_guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "draft-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(blocked_guide_res._ok, true);
    assert.equal(blocked_guide_res._result._recommendation, null);
    assert.equal(blocked_guide_res._result._guide._available, false);
    assert.equal(
      blocked_guide_res._result._runtime_lifecycle._status,
      "planning",
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "get-guide-recommendation",
      ),
      false,
    );

    execute_calls.length = 0;
    const guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(guide_res._ok, true);
    assert.equal(guide_res._result._recommendation._title, "Add Shopping Item CRUD");
    assert.equal(
      guide_res._result._recommendation._action._resolution._capability_id,
      "entity-crud",
    );
    assert.deepEqual(
      guide_res._result._recommendation._action._artifact_request,
      mock_guide_recommendation._action._artifact_request,
    );
    assert.deepEqual(
      guide_res._result._recommendation._action._execution_payload,
      mock_guide_recommendation._action._execution_payload,
    );
    assert.equal(guide_res._result._guide._available, true);
    assert.equal(
      guide_res._result._runtime_lifecycle._status,
      "executing",
    );
    assert.equal(
      guide_res._result._runtime_lifecycle._executable_guide_actions_available,
      true,
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "get-guide-recommendation" &&
          cmd._params._project_memory._confirmed_initial_plan !== undefined,
      ),
          true,
    );

    execute_calls.length = 0;
    const reloaded_recommendation = JSON.parse(
      JSON.stringify(guide_res._result._recommendation),
    );
    const guide_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _message_id: "guide-message",
        _recommendation: reloaded_recommendation,
      },
    });
    assert.equal(guide_execute_res._ok, true);
    assert.equal(guide_execute_res._result._status, "done");
    assert.equal(
      guide_execute_res._result._executor_route,
      "xvibe.execute-execution-graph",
    );
    assert.equal(
      guide_execute_res._result._execution_result._summary._created,
      4,
    );
    assert.equal(
      guide_execute_res._result._project_memory._milestones[0]._items[0]._completed,
      true,
    );
    assert.equal(
      guide_execute_res._result._next_recommendation._title,
      "Add Mark Purchased behavior",
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "execute-execution-graph" &&
          cmd._params._conversation_id === "planning-chat" &&
          cmd._params._message_id === "guide-message",
      ),
      true,
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "update-conversation-artifact" &&
          cmd._params._artifact_result._recommendation._expected_artifacts.length === 4,
      ),
      true,
    );

    execute_calls.length = 0;
    const retry_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: reloaded_recommendation,
      },
    });
    assert.equal(retry_res._ok, true);
    assert.equal(retry_res._result._status, "already-exists");
    assert.equal(retry_res._result._execution_result._summary._existing, 4);

    execute_calls.length = 0;
    const unconfirmed_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "draft-app",
        _env: "test",
        _recommendation: {
          ...reloaded_recommendation,
          _action: {
            ...reloaded_recommendation._action,
            _execution_payload: {
              ...reloaded_recommendation._action._execution_payload,
              _params: {
                ...reloaded_recommendation._action._execution_payload._params,
                _app_id: "draft-app",
              },
            },
          },
        },
      },
    });
    assert.equal(unconfirmed_execute_res._ok, false);
    assert.equal(
      unconfirmed_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_PLAN_NOT_CONFIRMED,
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "execute-execution-graph",
      ),
      false,
    );

    execute_calls.length = 0;
    const stale_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: {
          ...reloaded_recommendation,
          _semantic_plan_ref: {
            ...semantic_plan_ref,
            _version: "stale-version",
          },
        },
      },
    });
    assert.equal(stale_execute_res._ok, false);
    assert.equal(
      stale_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_PLAN_STALE,
    );

    execute_calls.length = 0;
    const malformed_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: {
          _title: "Add Shopping Item CRUD",
          _reason: "Malformed on purpose.",
          _type: "crud",
          _priority: 100,
          _action: {
            _prompt: "Add Shopping Item CRUD.",
          },
        },
      },
    });
    assert.equal(malformed_execute_res._ok, false);
    assert.equal(
      malformed_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
    );
    assert.deepEqual(
      malformed_execute_res._result._meta._missing_fields,
      ["_action._execution_payload"],
    );

    const server_xvm = new NodePackage.ServerXVMModule();
    const normalized_memory = (server_xvm as any).normalize_project_memory({
      _version: 1,
      _stage: "building",
      _vision: "",
      _goal: "Build a personal shopping list app",
      _confirmed_initial_plan: shopping_list_plan(),
      _semantic_generation_plan: {
        _type: "xvibe-semantic-generation-plan",
        _source: "confirmed_initial_plan",
        _entities: [{ _entity_id: "shopping_item", _title: "Shopping Item" }],
      },
      _current_focus: "Working Shopping List",
      _completed: [],
      _achievements: [],
      _milestones: [
        {
          _id: "working-shopping-list",
          _title: "Working Shopping List",
          _items: [
            {
              _id: "shopping-item-model",
              _title: "Shopping Item model",
              _completed: false,
              _semantic_type: "entity",
              _artifact_type: "entity",
              _entity_id: "shopping_item",
              _entity_name: "shopping_item",
            },
          ],
        },
      ],
      _parking_lot: [],
      _decisions: [],
      _notes: [],
      _updated_at: "2026-01-01T00:00:00.000Z",
    }, { _touch_updated_at: false });
    assert.deepEqual(normalized_memory._confirmed_initial_plan, shopping_list_plan());
    assert.equal(
      normalized_memory._semantic_generation_plan._type,
      "xvibe-semantic-generation-plan",
    );
    assert.equal(
      normalized_memory._milestones[0]._items[0]._entity_id,
      "shopping_item",
    );

    execute_calls.length = 0;
    mock_guide_recommendation = null;
    mock_guide_state = {
      _available: true,
      _reason: "no_executable_recommendation",
      _message: "No executable build action is available for the current guide focus.",
      _blockers: ["no_executable_recommendation"],
    };
    const empty_guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(empty_guide_res._ok, true);
    assert.equal(empty_guide_res._result._recommendation, null);
    assert.equal(empty_guide_res._result._guide._available, true);
    assert.equal(
      empty_guide_res._result._guide._blocked_reason,
      "no_executable_recommendation",
    );
    assert.equal(
      empty_guide_res._result._guide_state._message,
      "No executable build action is available for the current guide focus.",
    );
  } finally {
    (_x as any).execute = original_execute;
  }
}

function change_plan_test_view(view_id: string, title: string): any {
  return {
    _id: view_id,
    _type: "view",
    _children: [
      {
        _id: `${view_id}-title`,
        _type: "label",
        _text: title,
      },
      {
        _id: `${view_id}-summary`,
        _type: "label",
        _text: "Summary",
      },
      {
        _id: `${view_id}-footer`,
        _type: "label",
        _text: "Footer",
      },
    ],
  };
}

function change_plan_view_hash(view: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(view))
    .digest("hex");
}

function change_plan_structured_edit_action(action: string): string {
  if (action === "hide-object") return "hide";
  if (action === "show-object") return "show";
  return action;
}

async function apply_change_plan_view_edit_with_vibe_executor(input: {
  _server_xvm: any;
  _app_id: string;
  _env: string;
  _cmd: any;
}) {
  const params = input._cmd._params ?? {};
  const view_id = params._view_id;
  const target_id = params._target_id;
  const edit_action = params._edit_action;
  const view = await input._server_xvm._get_view({
    _params: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: view_id,
    },
  });
  const structured_action = change_plan_structured_edit_action(edit_action);
  const deterministic_result = (apply_deterministic_view_edit as any)({
    _resolved_task: {
      _action: "update",
      _artifact_type: "view",
      _target_id: view_id,
      _edit_action: structured_action,
      _edit_target_id: target_id,
      ...(typeof params._property_name === "string"
        ? { _edit_property_name: params._property_name }
        : {}),
      ...(params._property_value !== undefined
        ? { _edit_property_value: params._property_value }
        : {}),
      _explicit_artifact_type: true,
      _explicit_target_id: true,
      _module_ops: [],
      _source: "test.xvibe.apply-view-edit",
      _confidence: 1,
      _warnings: [],
    },
    _current_view: view._result._view,
    _edit_intent: {
      _action: structured_action,
      _target_id: target_id,
      ...(typeof params._property_name === "string"
        ? { _property_name: params._property_name }
        : {}),
      ...(params._property_value !== undefined
        ? { _property_value: params._property_value }
        : {}),
      _structured_apply_view_edit: true,
    },
  });

  if (!deterministic_result._ok || !deterministic_result._view) {
    return {
      _ok: false,
      _error: {
        _code: "E_TEST_APPLY_VIEW_EDIT_FAILED",
        _message: "Deterministic view edit failed",
        _details: deterministic_result,
      },
    };
  }

  const persist_result = await input._server_xvm._push_update({
    _params: {
      _app_id: input._app_id,
      _env: input._env,
      _view: deterministic_result._view,
    },
  });

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: view_id,
    _view_id: view_id,
    _deterministic: true,
    _edit_action: deterministic_result._mutation._action,
    _mutation_action: deterministic_result._mutation._action,
    _target_id: target_id,
    _property_name: deterministic_result._mutation._property_name,
    _mutation: deterministic_result._mutation,
    _persist_result: persist_result,
  };
}

function generated_view_operation(input: {
  _id: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _kind?: "view.create" | "view.replace";
  _title: string;
  _precondition?: Record<string, any>;
  _set_default_view?: boolean;
}): any {
  return {
    _type: "xvibe-generated-operation",
    _contract_version: 1,
    _id: input._id,
    _source_step_id: `${input._id}-step`,
    _kind: input._kind ?? "view.replace",
    _target: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    },
    _artifact: {
      _artifact_type: "view",
      _contract_version: 1,
      _view: change_plan_test_view(input._view_id, input._title),
    },
    _validation: {
      _state: "generated",
      _validated_at: "2026-01-01T00:00:00.000Z",
      _validator: "xvibe.view-artifact",
    },
    ...(input._precondition ? { _precondition: input._precondition } : {}),
      ...(input._set_default_view ? { _set_default_view: true } : {}),
  };
}

function generated_primary_experience_operation(input: {
  _id: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _view: any;
}): any {
  return {
    _type: "xvibe-generated-operation",
    _contract_version: 1,
    _id: input._id,
    _source_step_id: `${input._id}-step`,
    _kind: "view.create",
    _target: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    },
    _artifact: {
      _artifact_type: "view",
      _contract_version: 1,
      _view: input._view,
    },
    _validation: {
      _state: "generated",
      _validated_at: "2026-01-01T00:00:00.000Z",
      _validator: "xvibe.primary-experience",
    },
    _set_default_view: true,
  };
}

async function with_entity_manager_register_stub<T>(fn: () => Promise<T>): Promise<T> {
  const original_execute = (_x as any).execute;
  try {
    (_x as any).execute = async (cmd: any) => {
      if (
        cmd?._module === "entity-manager" &&
        (cmd?._op === "register" || cmd?._op === "unregister")
      ) {
        return { _ok: true, _result: { _registered: cmd._op === "register" } };
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };

    return await fn();
  } finally {
    (_x as any).execute = original_execute;
  }
}

async function load_dashboard_starter_view(view_id: string, title: string) {
  const starter_view_path = path.resolve(
    process.cwd(),
    "system-xapps",
    "app-starters",
    "dashboard",
    "views",
    "main.json",
  );
  const view = JSON.parse(await readFile(starter_view_path, "utf-8"));
  view._id = view_id;
  view._semantic_id = `${view_id}:dashboard-starter`;

  const toolbar_title = find_json_object_by_id(view, "dashboard-toolbar-title");
  if (toolbar_title) {
    toolbar_title._text = title;
  }

  return view;
}

function semantic_entity(input: {
  _entity_id: string;
  _title: string;
  _fields: string[];
}) {
  return {
    _id: input._entity_id,
    _semantic_id: `${input._entity_id}:entity`,
    _title: input._title,
    _schema: input._fields.reduce<Record<string, any>>((schema, field) => {
      schema[field] = { _type: "String" };
      return schema;
    }, {}),
  };
}

function semantic_create_flow(input: {
  _flow_id: string;
  _entity_id: string;
  _title: string;
}) {
  return {
    _id: input._flow_id,
    _semantic_id: `${input._flow_id}:flow`,
    _title: input._title,
    _steps: [
      {
        _id: "create-record",
        _semantic_id: `${input._flow_id}:create-record`,
        _command: {
          _module: "entity-manager",
          _op: "add",
          _params: {
            _entity: input._entity_id,
            data: {
              title: "$event.title",
              status: "$event.status",
            },
          },
        },
        _output: {
          _to: {
            _type: "xdata",
            _key: `${input._entity_id}.last_created`,
          },
          _value: "$step.create-record._result",
        },
      },
    ],
  };
}

function semantic_primary_view(input: {
  _case_id: string;
  _view_id: string;
  _title: string;
  _entity_id: string;
  _flow_id: string;
}) {
  return {
    _id: input._view_id,
    _type: "view",
    _semantic_id: `${input._case_id}:primary-view`,
    _children: [
      {
        _id: `${input._case_id}-summary`,
        _type: "section",
        _semantic_id: `${input._case_id}:summary`,
        _entity: input._entity_id,
        _data_source: {
          _type: "entity-summary",
          _entity_id: input._entity_id,
        },
        _children: [
          {
            _id: `${input._case_id}-title`,
            _type: "label",
            _semantic_id: `${input._case_id}:title`,
            _text: input._title,
          },
        ],
      },
      {
        _id: `${input._case_id}-create-button`,
        _type: "button",
        _semantic_id: `${input._case_id}:create-action`,
        _text: "Create",
        _flow_event: "click",
        _flow: {
          _id: input._flow_id,
          _payload: {
            title: "$xdata.form.title",
            status: "$xdata.form.status",
          },
        },
      },
      {
        _id: `${input._case_id}-records`,
        _type: "table",
        _semantic_id: `${input._case_id}:records-table`,
        _entity_id: input._entity_id,
        _data_source: {
          _type: "entity-list",
          _entity_id: input._entity_id,
        },
        _columns: [
          { _key: "title", _title: "Title" },
          { _key: "status", _title: "Status" },
        ],
      },
    ],
  };
}

function shopping_item_entity_schema() {
  return {
    _id: "shopping_item",
    _semantic_id: "shopping_item:entity",
    _title: "Shopping Item",
    _storage: {
      _provider: "xdb",
      _scope: "app",
    },
    _schema: {
      name: { _type: "String", _required: true },
      quantity: { _type: "Number", _required: true },
      status: { _type: "String", _default: "open" },
      purchased: { _type: "Boolean", _default: false },
      lifecycle: { _type: "String", _default: "active" },
    },
  };
}

function shopping_item_flow(input: {
  _id: string;
  _op: "create" | "find" | "edit" | "purchase" | "delete";
}) {
  const output_key = `shopping_item.${input._op}`;
  const command =
    input._op === "create"
      ? {
        _module: "entity-manager",
        _op: "add",
        _params: {
          _entity: "shopping_item",
          _data: {
            name: "$event.name",
            quantity: "$event.quantity",
            status: "open",
            purchased: false,
            lifecycle: "active",
          },
        },
      }
      : input._op === "find"
        ? {
          _module: "entity-manager",
          _op: "find",
          _params: {
            _entity: "shopping_item",
            _filter: "$event.filter",
          },
        }
        : input._op === "edit"
          ? {
            _module: "entity-manager",
            _op: "update",
            _params: {
              _entity: "shopping_item",
              _filter: { _id: "$event._id" },
              _updates: {
                name: "$event.name",
                quantity: "$event.quantity",
              },
            },
          }
          : input._op === "purchase"
            ? {
              _module: "entity-manager",
              _op: "update",
              _params: {
                _entity: "shopping_item",
                _filter: { _id: "$event._id" },
                _updates: {
                  status: "purchased",
                  purchased: true,
                  lifecycle: "completed",
                },
              },
            }
            : {
              _module: "entity-manager",
              _op: "delete",
              _params: {
                _entity: "shopping_item",
                _filter: { _id: "$event._id" },
              },
            };

  return {
    _id: input._id,
    _semantic_id: `shopping_item:${input._op}:flow`,
    _steps: [
      {
        _id: `${input._op}-shopping-item`,
        _semantic_id: `shopping_item:${input._op}:step`,
        _command: command,
        _output: {
          _to: {
            _type: "xdata",
            _key: output_key,
          },
          _value: input._op === "find"
            ? `$step.${input._op}-shopping-item._result._records._data`
            : `$step.${input._op}-shopping-item._result`,
        },
      },
    ],
  };
}

function shopping_item_list_view() {
  return {
    _id: "shopping-list",
    _type: "view",
    _semantic_id: "shopping_item:list:view",
    _children: [
      {
        _id: "shopping-list-table",
        _type: "table",
        _semantic_id: "shopping_item:list:table",
        _entity_id: "shopping_item",
        _data_source: {
          _type: "entity-list",
          _entity_id: "shopping_item",
        },
        _columns: [
          { _key: "name", _title: "Item" },
          { _key: "quantity", _title: "Quantity" },
          { _key: "status", _title: "Status" },
        ],
      },
    ],
  };
}

function shopping_item_form_view() {
  return {
    _id: "shopping-form",
    _type: "view",
    _semantic_id: "shopping_item:form:view",
    _children: [
      {
        _id: "shopping-form-submit",
        _type: "button",
        _semantic_id: "shopping_item:form:create",
        _text: "Add item",
        _flow_event: "click",
        _flow: {
          _id: "create-shopping-item",
          _payload: {
            name: "$xdata.shopping_item.form.name",
            quantity: "$xdata.shopping_item.form.quantity",
          },
        },
      },
    ],
  };
}

function tracker_entry_entity_schema() {
  return {
    _id: "tracker_entry",
    _title: "Tracker Entry",
    _storage: {
      _provider: "xdb",
      _scope: "app",
    },
    _schema: {
      description: { _type: "String", _required: true },
      amount: { _type: "Number", _required: true },
      occurred_at: { _type: "String" },
    },
  };
}

function tracker_entry_flow(input: {
  _id: string;
  _op: "add" | "delete";
}) {
  if (input._op === "add") {
    return {
      _id: input._id,
      _steps: [
        {
          _id: "add-tracker-entry",
          _command: {
            _module: "entity-manager",
            _op: "add",
            _params: {
              _entity: "tracker_entry",
              _data: {
                description: "$event.description",
                amount: "$event.amount",
                occurred_at: "$event.occurred_at",
              },
            },
          },
          _output: {
            _to: { _type: "xdata", _key: "tracker_entry:add" },
            _value: "$step.add-tracker-entry._result",
          },
        },
      ],
    };
  }

  return {
    _id: input._id,
    _steps: [
      {
        _id: "delete-tracker-entry",
        _command: {
          _module: "entity-manager",
          _op: "delete",
          _params: {
            _entity: "tracker_entry",
            _id: "$event._id",
          },
        },
        _output: {
          _to: { _type: "xdata", _key: "tracker_entry:delete" },
          _value: "$step.delete-tracker-entry._result",
        },
      },
      {
        _id: "refresh-tracker-entry-records",
        _command: {
          _module: "entity-manager",
          _op: "find",
          _params: {
            _entity: "tracker_entry",
            _filter: {},
          },
        },
        _output: {
          _to: { _type: "xdata", _key: "tracker_entry:records" },
          _value: "$step.refresh-tracker-entry-records._result._records._data",
        },
      },
    ],
  };
}

function composed_shopping_main_view() {
  return {
    _id: "main",
    _type: "view",
    _semantic_id: "shopping_item:main:view",
    _children: [
      {
        _id: "shopping-main-title",
        _type: "label",
        _semantic_id: "shopping_item:main:title",
        _text: "Shopping List",
      },
      {
        _id: "shopping-main-form-ref",
        _type: "xvm-view",
        _semantic_id: "shopping_item:main:form-ref",
        _view_id: "shopping-form",
      },
      {
        _id: "shopping-main-list-ref",
        _type: "xvm-view",
        _semantic_id: "shopping_item:main:list-ref",
        _view_id: "shopping-list",
      },
    ],
  };
}

function flow_output(result: any, key: string) {
  return result?._result?._flow?._outputs?.[key];
}

async function run_server_xvm_composed_semantic_runtime_acceptance_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-composed-runtime-"));
  const env = "test";
  const app_id = "shopping-runtime";
  const isolated_app_id = "shopping-runtime-isolated";
  let server_xvm: any;
  let entity_manager: XEntityManager = new XEntityManager();
  let flow_manager: FlowManagerModule = new FlowManagerModule();
  const original_execute = (_x as any).execute;

  const install_runtime = (next_server_xvm: any, next_entity_manager: XEntityManager) => {
    server_xvm = next_server_xvm;
    entity_manager = next_entity_manager;
    flow_manager = new FlowManagerModule();
  };

  const reload_runtime = async () => {
    const next_server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    const next_entity_manager = new XEntityManager();
    install_runtime(next_server_xvm, next_entity_manager);
    await server_xvm.init_on_boot();
  };

  const run_flow = async (_app_id: string, _env: string, _flow_id: string, _event_payload: Record<string, any>) => {
    const result = await (flow_manager as any)._run({
      _params: {
        _app_id,
        _env,
        _flow_id,
        _event_payload,
      },
    });
    assert.equal(
      result._ok,
      true,
      `flow ${_flow_id} failed: ${JSON.stringify(result)}`,
    );
    return result;
  };

  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();

    install_runtime(
      new NodePackage.ServerXVMModule({ _work_folder: work_folder }),
      new XEntityManager(),
    );

    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "server-xvm") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof server_xvm?.[method] !== "function") {
          throw new Error(`Unexpected server-xvm op ${cmd._op}`);
        }
        return server_xvm[method](cmd);
      }
      if (cmd?._module === "entity-manager") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof (entity_manager as any)?.[method] !== "function") {
          throw new Error(`Unexpected entity-manager op ${cmd._op}`);
        }
        return (entity_manager as any)[method](cmd);
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };

    await server_xvm._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "main",
        _config: {
          _start: { _view_id: "main" },
        },
      },
    });
    await server_xvm._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: shopping_item_entity_schema(),
      },
    });
    for (const flow of [
      shopping_item_flow({ _id: "create-shopping-item", _op: "create" }),
      shopping_item_flow({ _id: "find-shopping-items", _op: "find" }),
      shopping_item_flow({ _id: "edit-shopping-item", _op: "edit" }),
      shopping_item_flow({ _id: "mark-shopping-item-purchased", _op: "purchase" }),
      shopping_item_flow({ _id: "delete-shopping-item", _op: "delete" }),
    ]) {
      await server_xvm._set_flow({
        _params: {
          _app_id: app_id,
          _env: env,
          _flow: flow,
        },
      });
    }
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: shopping_item_list_view(),
      },
    });
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: shopping_item_form_view(),
      },
    });

    const version_before_main = (await server_xvm._get_app({
      _params: { _app_id: app_id, _env: env },
    }))._result._app._meta._version;
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: composed_shopping_main_view(),
      },
    });
    const version_after_main = (await server_xvm._get_app({
      _params: { _app_id: app_id, _env: env, _include_views: true, _include_flows: true },
    }))._result._app._meta._version;
    assert.equal(version_after_main > version_before_main, true);

    await reload_runtime();
    const composed_app = await server_xvm._get_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _include_views: true,
        _include_flows: true,
      },
    });
    assert.equal(composed_app._result._app._meta._entry_view_id, "main");
    assert.equal(composed_app._result._app._config._start._view_id, "main");
    assert.deepEqual(
      composed_app._result._view_ids.sort(),
      ["main", "shopping-form", "shopping-list"],
    );
    assert.equal(
      find_json_object_by_id(composed_app._result._views.main, "shopping-main-list-ref")._view_id,
      "shopping-list",
    );
    assert.deepEqual(
      (await (entity_manager as any)._list({
        _params: { _app_id: app_id, _env: env },
      }))._result.entities,
      ["shopping_item"],
    );

    const create_result = await run_flow(app_id, env, "create-shopping-item", {
      name: "Milk",
      quantity: 2,
    });
    const created_record = flow_output(create_result, "shopping_item.create")._record;
    assert.equal(created_record.name, "Milk");
    assert.equal(created_record.quantity, 2);
    assert.equal(typeof created_record.quantity, "number");

    await reload_runtime();
    const find_after_create = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    let records = flow_output(find_after_create, "shopping_item.find");
    assert.equal(records.length, 1);
    assert.equal(records[0].quantity, 2);
    assert.equal(typeof records[0].quantity, "number");

    await run_flow(app_id, env, "edit-shopping-item", {
      _id: created_record._id,
      name: "Oat milk",
      quantity: 3,
    });
    await reload_runtime();
    const find_after_edit = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    records = flow_output(find_after_edit, "shopping_item.find");
    assert.equal(records[0].name, "Oat milk");
    assert.equal(records[0].quantity, 3);
    assert.equal(typeof records[0].quantity, "number");

    await run_flow(app_id, env, "mark-shopping-item-purchased", {
      _id: created_record._id,
    });
    await reload_runtime();
    const find_after_purchase = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    records = flow_output(find_after_purchase, "shopping_item.find");
    assert.equal(records[0].status, "purchased");
    assert.equal(records[0].purchased, true);
    assert.equal(records[0].lifecycle, "completed");

    await server_xvm._create_app({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _entry_view_id: "main",
      },
    });
    await server_xvm._set_entity({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _entity: shopping_item_entity_schema(),
      },
    });
    await server_xvm._set_flow({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _flow: shopping_item_flow({ _id: "create-shopping-item", _op: "create" }),
      },
    });
    await server_xvm._set_flow({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _flow: shopping_item_flow({ _id: "find-shopping-items", _op: "find" }),
      },
    });
    const isolated_create = await run_flow(isolated_app_id, "isolated", "create-shopping-item", {
      name: "Bread",
      quantity: 1,
    });
    assert.notEqual(
      flow_output(isolated_create, "shopping_item.create")._record._id,
      created_record._id,
    );
    const isolated_find = await run_flow(isolated_app_id, "isolated", "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(isolated_find, "shopping_item.find").length, 1);
    const original_find_for_isolation = await run_flow(app_id, env, "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(original_find_for_isolation, "shopping_item.find").length, 1);

    await run_flow(app_id, env, "delete-shopping-item", {
      _id: created_record._id,
    });
    await reload_runtime();
    const find_after_delete = await run_flow(app_id, env, "find-shopping-items", {
      filter: {},
    });
    assert.deepEqual(flow_output(find_after_delete, "shopping_item.find"), []);

    const isolated_after_original_delete = await run_flow(isolated_app_id, "isolated", "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(isolated_after_original_delete, "shopping_item.find").length, 1);
    assert.deepEqual(
      (await (entity_manager as any)._list({
        _params: { _app_id: app_id, _env: env },
      }))._result.entities,
      ["shopping_item"],
    );
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_tracker_delete_flow_regression_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-tracker-delete-"));
  const env = "test";
  const app_id = "tracker-delete-runtime";
  let server_xvm: any = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
  let entity_manager: XEntityManager = new XEntityManager();
  let flow_manager: FlowManagerModule = new FlowManagerModule();
  const original_execute = (_x as any).execute;
  const delete_params: any[] = [];

  const run_flow = async (_flow_id: string, _event_payload: Record<string, any>) => {
    const result = await (flow_manager as any)._run({
      _params: {
        _app_id: app_id,
        _env: env,
        _flow_id,
        _event_payload,
      },
    });
    assert.equal(
      result._ok,
      true,
      `tracker flow ${_flow_id} failed: ${JSON.stringify(result)}`,
    );
    return result;
  };

  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();

    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "server-xvm") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof server_xvm?.[method] !== "function") {
          throw new Error(`Unexpected server-xvm op ${cmd._op}`);
        }
        return server_xvm[method](cmd);
      }
      if (cmd?._module === "entity-manager") {
        if (cmd._op === "delete") delete_params.push(JSON.parse(JSON.stringify(cmd._params ?? {})));
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof (entity_manager as any)?.[method] !== "function") {
          throw new Error(`Unexpected entity-manager op ${cmd._op}`);
        }
        return (entity_manager as any)[method](cmd);
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };

    await server_xvm._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "tracker_main",
      },
    });
    await server_xvm._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: tracker_entry_entity_schema(),
      },
    });
    for (const flow of [
      tracker_entry_flow({ _id: "add_tracker_entry", _op: "add" }),
      tracker_entry_flow({ _id: "delete_tracker_entry", _op: "delete" }),
    ]) {
      await server_xvm._set_flow({
        _params: {
          _app_id: app_id,
          _env: env,
          _flow: flow,
        },
      });
    }

    const first = flow_output(
      await run_flow("add_tracker_entry", {
        description: "First",
        amount: 10,
        occurred_at: "2026-09-04T08:00",
      }),
      "tracker_entry:add",
    )._record;
    const second = flow_output(
      await run_flow("add_tracker_entry", {
        description: "Second",
        amount: 20,
        occurred_at: "2026-09-04T09:00",
      }),
      "tracker_entry:add",
    )._record;

    const delete_result = await run_flow("delete_tracker_entry", {
      _id: second._id,
    });
    assert.equal(delete_params.length, 1);
    assert.equal(delete_params[0]._id, second._id);
    assert.equal(flow_output(delete_result, "tracker_entry:delete")._deleted, 1);
    const refreshed = flow_output(delete_result, "tracker_entry:records");
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]._id, first._id);
    assert.equal(refreshed[0].description, "First");
    assert.equal(
      refreshed.some((record: any) => record._id === second._id),
      false,
    );
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_entity_manager_scoped_runtime_entity_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-entity-scope-"));
  const env_default = "default";
  const original_execute = (_x as any).execute;
  let server_xvm: any = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
  let entity_manager: XEntityManager = new XEntityManager();

  const install_execute_stub = () => {
    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "entity-manager") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof (entity_manager as any)?.[method] !== "function") {
          throw new Error(`Unexpected entity-manager op ${cmd._op}`);
        }
        return (entity_manager as any)[method](cmd);
      }
      if (cmd?._module === "server-xvm") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof server_xvm?.[method] !== "function") {
          throw new Error(`Unexpected server-xvm op ${cmd._op}`);
        }
        return server_xvm[method](cmd);
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };
  };

  const entity_artifact = (fields: Record<string, any>) => ({
    _id: "shopping_item",
    _title: "Shopping Item",
    _schema: fields,
  });

  const set_entity = async (_app_id: string, _env: string, fields: Record<string, any>) => {
    const result = await server_xvm._set_entity({
      _params: {
        _app_id,
        _env,
        _entity: entity_artifact(fields),
      },
    });
    assert.equal(result._ok, true);
  };

  const add_record = async (_app_id: string, _env: string, data: Record<string, any>) => {
    const result = await (entity_manager as any)._add({
      _params: {
        _app_id,
        _env,
        _entity: "shopping_item",
        _data: data,
      },
    });
    assert.equal(result._ok, true, JSON.stringify(result));
    return result._result._record;
  };

  const find_records = async (_app_id: string, _env: string) => {
    const result = await (entity_manager as any)._find({
      _params: {
        _app_id,
        _env,
        _entity: "shopping_item",
        _filter: {},
      },
    });
    assert.equal(result._ok, true, JSON.stringify(result));
    return result._result._records._data;
  };

  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    install_execute_stub();

    for (const [_app_id, _env] of [
      ["ap5", env_default],
      ["ap6", env_default],
      ["ap5", "staging"],
    ]) {
      await server_xvm._create_app({
        _params: {
          _app_id,
          _env,
          _entry_view_id: "main",
        },
      });
    }

    await set_entity("ap5", env_default, {
      name: { _type: "String", _required: true },
      quantity: { _type: "Number", _required: true },
    });
    await set_entity("ap6", env_default, {
      title: { _type: "String", _required: true },
      aisle: { _type: "String", _required: true },
    });
    await set_entity("ap5", "staging", {
      sku: { _type: "String", _required: true },
      done: { _type: "Boolean", _default: false },
    });

    const ap5_default_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap6_default_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap6",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap5_staging_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap5",
        _env: "staging",
        _entity: "shopping_item",
      },
    });

    assert.equal(ap5_default_diag._ok, true);
    assert.equal(ap5_default_diag._result._diagnostic._entity, "shopping_item");
    assert.equal(ap5_default_diag._result._diagnostic._storage_scope, "app");
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      ap6_default_diag._result._diagnostic._physical_entity_name,
    );
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      ap5_staging_diag._result._diagnostic._physical_entity_name,
    );
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      "shopping_item",
    );

    const ap5_record = await add_record("ap5", env_default, {
      name: "Milk",
      quantity: 2,
    });
    const ap6_record = await add_record("ap6", env_default, {
      title: "Coffee",
      aisle: "3",
    });
    const staging_record = await add_record("ap5", "staging", {
      sku: "S-1",
    });

    assert.deepEqual((await find_records("ap5", env_default)).map((record: any) => record._id), [ap5_record._id]);
    assert.deepEqual((await find_records("ap6", env_default)).map((record: any) => record._id), [ap6_record._id]);
    assert.deepEqual((await find_records("ap5", "staging")).map((record: any) => record._id), [staging_record._id]);

    const ap5_schema = await (entity_manager as any)._get_schema({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap6_schema = await (entity_manager as any)._get_schema({
      _params: {
        _app_id: "ap6",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    assert.equal(ap5_schema._result.entity._schema.quantity._type, "Number");
    assert.equal(ap6_schema._result.entity._schema.aisle._type, "String");
    assert.equal(ap6_schema._result.entity._schema.quantity, undefined);

    const repeat = await (entity_manager as any)._register({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: entity_artifact({
          name: { _type: "String", _required: true },
          quantity: { _type: "Number", _required: true },
        }),
      },
    });
    assert.equal(repeat._ok, true);
    assert.equal(repeat._result._already_exists, true);

    const unscoped_find = await (entity_manager as any)._find({
      _params: {
        _entity: "shopping_item",
        _filter: {},
      },
    });
    assert.equal(unscoped_find._ok, false);
    assert.match(JSON.stringify(unscoped_find), /_app_id/);

    const cross_update = await (entity_manager as any)._update({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
        _filter: { _id: ap6_record._id },
        _updates: { name: "Wrong" },
      },
    });
    assert.equal(cross_update._ok, true);
    assert.equal(cross_update._result._updated, 0);
    assert.equal((await find_records("ap6", env_default))[0].title, "Coffee");

    const server_ap5_entities = await server_xvm._list_entities({
      _params: {
        _app_id: "ap5",
        _env: env_default,
      },
    });
    const server_ap6_entities = await server_xvm._list_entities({
      _params: {
        _app_id: "ap6",
        _env: env_default,
      },
    });
    assert.deepEqual(server_ap5_entities._result._entities, ["shopping_item"]);
    assert.deepEqual(server_ap6_entities._result._entities, ["shopping_item"]);

    const runtime_list = await (entity_manager as any)._list({
      _params: {
        _app_id: "ap5",
        _env: env_default,
      },
    });
    assert.deepEqual(runtime_list._result.entities, ["shopping_item"]);

    const persisted_entity = JSON.parse(await readFile(
      path.join(work_folder, "xvm", "apps", env_default, "ap5", "entities", "shopping_item.json"),
      "utf-8",
    ));
    assert.equal(persisted_entity._id, "shopping_item");
    assert.equal(JSON.stringify(persisted_entity).includes("ap5::shopping_item"), false);

    const storage_entities = await readdir(path.join(work_folder, "xdb", "entities"));
    assert.equal(storage_entities.includes("shopping_item"), false);
    assert.equal(storage_entities.includes(ap5_default_diag._result._diagnostic._physical_entity_name), true);
    assert.equal(storage_entities.includes(ap6_default_diag._result._diagnostic._physical_entity_name), true);
    assert.equal(storage_entities.includes(ap5_staging_diag._result._diagnostic._physical_entity_name), true);

    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    entity_manager = new XEntityManager();
    install_execute_stub();
    await server_xvm.init_on_boot();
    assert.deepEqual((await find_records("ap5", env_default)).map((record: any) => record._id), [ap5_record._id]);
    assert.deepEqual((await find_records("ap6", env_default)).map((record: any) => record._id), [ap6_record._id]);
    assert.deepEqual((await find_records("ap5", "staging")).map((record: any) => record._id), [staging_record._id]);

    const global_register = await (entity_manager as any)._register({
      _params: {
        _entity_scope: "global",
        _entity: {
          _id: "system_setting",
          _storage: {
            _provider: "memory",
            _scope: "global",
          },
          _schema: {
            key: { _type: "String", _required: true },
          },
        },
      },
    });
    assert.equal(global_register._ok, true);
    const global_add = await (entity_manager as any)._add({
      _params: {
        _entity_scope: "global",
        _entity: "system_setting",
        _data: { key: "theme" },
      },
    });
    assert.equal(global_add._ok, true);
    const global_find = await (entity_manager as any)._find({
      _params: {
        _entity_scope: "global",
        _entity: "system_setting",
        _filter: {},
      },
    });
    assert.equal(global_find._result._records._data.length, 1);
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }

  const legacy_work_folder = await mkdtemp(path.join(tmpdir(), "xnode-entity-legacy-"));
  server_xvm = new NodePackage.ServerXVMModule({ _work_folder: legacy_work_folder });
  entity_manager = new XEntityManager();
  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(legacy_work_folder, "xdb"),
      }),
      workFolder: legacy_work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    install_execute_stub();

    const legacy_entity = NodePackage.XDB.create({
      _type: (NodePackage.XDBEntity as any)._xtype,
      _id: "legacy_item",
      _name: "legacy_item",
      _schema: {
        name: { _type: "String", _required: true },
      },
    }) as any;
    await legacy_entity.add({ name: "Legacy Milk" });

    await server_xvm._create_app({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entry_view_id: "main",
      },
    });
    const legacy_set = await server_xvm._set_entity({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: {
          _id: "legacy_item",
          _title: "Legacy Item",
          _schema: {
            name: { _type: "String", _required: true },
          },
        },
      },
    });
    assert.equal(legacy_set._ok, true);

    const blocked = await (entity_manager as any)._find({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: "legacy_item",
        _filter: {},
      },
    });
    assert.equal(blocked._ok, false);
    assert.match(JSON.stringify(blocked), /legacy global entity/);

    const dry_run = await (entity_manager as any)._storage_migration_dry_run({
      _params: {
        _entity: "legacy_item",
        _target_app_id: "legacy-app",
        _target_env: env_default,
        _target_entity_id: "legacy_item",
      },
    });
    assert.equal(dry_run._ok, true);
    assert.equal(dry_run._result._migration._status, "ready");

    const migrated = await (entity_manager as any)._storage_migrate({
      _params: {
        _mode: "copy",
        _entity: "legacy_item",
        _target_app_id: "legacy-app",
        _target_env: env_default,
        _target_entity_id: "legacy_item",
      },
    });
    assert.equal(migrated._ok, true);
    assert.equal(migrated._result._migration._status, "copied");

    const after_migration = await (entity_manager as any)._find({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: "legacy_item",
        _filter: {},
      },
    });
    assert.equal(after_migration._ok, true);
    assert.equal(after_migration._result._records._data[0].name, "Legacy Milk");
  } finally {
    (_x as any).execute = original_execute;
    await rm(legacy_work_folder, { recursive: true, force: true });
  }
}

async function run_server_xvm_semantic_runtime_composition_tests() {
  const cases = [
    {
      _case_id: "shopping-list",
      _app_id: "semantic-shopping-list",
      _title: "Shopping List",
      _entity_id: "shopping_item",
      _entity_title: "Shopping Item",
      _flow_id: "create-shopping-item",
      _fields: ["title", "status", "quantity"],
    },
    {
      _case_id: "crm",
      _app_id: "semantic-crm",
      _title: "CRM",
      _entity_id: "customer",
      _entity_title: "Customer",
      _flow_id: "create-customer",
      _fields: ["title", "status", "owner"],
    },
    {
      _case_id: "scheduler",
      _app_id: "semantic-scheduler",
      _title: "Scheduler",
      _entity_id: "schedule_event",
      _entity_title: "Schedule Event",
      _flow_id: "create-schedule-event",
      _fields: ["title", "status", "starts_at"],
    },
  ];

  for (const scenario of cases) {
    const work_folder = await mkdtemp(path.join(tmpdir(), `xnode-semantic-${scenario._case_id}-`));
    try {
      await with_entity_manager_register_stub(async () => {
        const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
        const env = "test";
        const starter_view = await load_dashboard_starter_view(
          "main",
          `${scenario._title} Starter`,
        );

        await (server_xvm as any)._create_app({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _name: scenario._title,
            _entry_view_id: "main",
            _config: {
              _start: { _view_id: "main" },
            },
          },
        });
        await (server_xvm as any)._push_update({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _view: starter_view,
          },
        });
        await (server_xvm as any)._set_entity({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _entity: semantic_entity({
              _entity_id: scenario._entity_id,
              _title: scenario._entity_title,
              _fields: scenario._fields,
            }),
          },
        });
        await (server_xvm as any)._set_flow({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _flow: semantic_create_flow({
              _flow_id: scenario._flow_id,
              _entity_id: scenario._entity_id,
              _title: `Create ${scenario._entity_title}`,
            }),
          },
        });

        const primary_view = semantic_primary_view({
          _case_id: scenario._case_id,
          _view_id: "primary",
          _title: scenario._title,
          _entity_id: scenario._entity_id,
          _flow_id: scenario._flow_id,
        });
        const generate_result = await (server_xvm as any)._apply_generated_operation({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _operation: generated_primary_experience_operation({
              _id: `${scenario._case_id}-primary`,
              _app_id: scenario._app_id,
              _env: env,
              _view_id: "primary",
              _view: primary_view,
            }),
          },
        });

        assert.equal(generate_result._ok, true);
        assert.equal(generate_result._result._view_id, "primary");

        const reloaded = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
        await (reloaded as any).init_on_boot();
        const app = await (reloaded as any)._get_app({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _include_views: true,
            _include_flows: true,
          },
        });
        const view = await (reloaded as any)._get_view({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _view_id: "primary",
          },
        });
        const flow = await (reloaded as any)._get_flow({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _flow_id: scenario._flow_id,
          },
        });
        const entity = await (reloaded as any)._get_entity({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _entity_id: scenario._entity_id,
          },
        });

        assert.equal(app._result._app._meta._entry_view_id, "primary");
        assert.equal(app._result._app._config._start._view_id, "primary");
        assert.deepEqual(app._result._view_ids.sort(), ["main", "primary"]);
        assert.deepEqual(app._result._flow_ids, [scenario._flow_id]);
        assert.deepEqual(app._result._entity_ids, [scenario._entity_id]);
        assert.equal(entity._result._entity._semantic_id, `${scenario._entity_id}:entity`);
        assert.equal(flow._result._flow._steps[0]._command._params._entity, scenario._entity_id);

        const create_button = find_json_object_by_id(
          view._result._view,
          `${scenario._case_id}-create-button`,
        );
        const records_table = find_json_object_by_id(
          view._result._view,
          `${scenario._case_id}-records`,
        );

        assert.equal(create_button._flow._id, scenario._flow_id);
        assert.equal(records_table._entity_id, scenario._entity_id);
        assert.equal(records_table._data_source._entity_id, scenario._entity_id);

        const persisted_view = JSON.parse(await readFile(
          path.join(work_folder, "xvm", "apps", env, scenario._app_id, "views", "primary.json"),
          "utf-8",
        ));
        assert.deepEqual(persisted_view, view._result._view);
      });
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }
}

async function run_server_xvm_semantic_validation_tests() {
  async function create_server_fixture() {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-semantic-validation-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    await (server_xvm as any)._create_app({
      _params: {
        _app_id: "validation-app",
        _env: "test",
        _entry_view_id: "main",
      },
    });
    return { work_folder, server_xvm };
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: semantic_primary_view({
              _case_id: "missing-entity",
              _view_id: "main",
              _title: "Missing Entity",
              _entity_id: "missing_entity",
              _flow_id: "create-record",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_ENTITY_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await with_entity_manager_register_stub(async () => {
        await (fixture.server_xvm as any)._set_entity({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _entity: semantic_entity({
              _entity_id: "record",
              _title: "Record",
              _fields: ["title"],
            }),
          },
        });
      });
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: semantic_primary_view({
              _case_id: "missing-flow",
              _view_id: "main",
              _title: "Missing Flow",
              _entity_id: "record",
              _flow_id: "missing-flow",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_FLOW_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                {
                  _id: "missing-subview-ref",
                  _type: "xvm-view",
                  _view_id: "missing-subview",
                },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_VIEW_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _view: {
            _id: "subview",
            _type: "view",
            _children: [],
          },
        },
      });
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                {
                  _id: "wrong-env-subview-ref",
                  _type: "xvm-view",
                  _view_id: "subview",
                  _env: "other",
                },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_INVALID_VIEW_REFERENCE_TARGET",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                { _id: "a", _type: "label", _semantic_id: "duplicate" },
                { _id: "b", _type: "label", _semantic_id: "duplicate" },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_DUPLICATE_SEMANTIC_ID",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: ["invalid-child"],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_GENERATED_OPERATION_XUI_INVALID",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }
}

function dynamic_target_flow(input: {
  _flow_id?: string;
  _app_id: string;
  _env?: string;
  _op?: string;
}) {
  return {
    _id: input._flow_id ?? "dynamic-target-flow",
    _steps: [
      {
        _id: "load-target-app",
        _command: {
          _module: "server-xvm",
          _op: input._op ?? "get_app",
          _params: {
            _app_id: input._app_id,
            _env: input._env ?? "$event._env",
          },
        },
        _output: {
          _to: {
            _type: "xdata",
            _key: "dynamic.target.app_id",
          },
          _value: "$step.load-target-app._result._app._app_id",
        },
      },
    ],
  };
}

function response_has_error_code(value: unknown, code: string): boolean {
  return JSON.stringify(value).includes(code);
}

async function write_system_app_fixture(input: {
  _system_apps_root: string;
  _app_id: string;
  _env?: string;
  _flow: Record<string, any>;
}) {
  const app_dir = path.join(input._system_apps_root, input._app_id);
  await mkdir(path.join(app_dir, "flows"), { recursive: true });
  await writeFile(
    path.join(app_dir, "app.json"),
    JSON.stringify({
      _app_id: input._app_id,
      _env: input._env ?? "default",
      _meta: {
        _name: input._app_id,
        _version: 1,
        _entry_view_id: "main",
      },
      _config: {},
    }, null, 2),
  );
  await writeFile(
    path.join(app_dir, "flows", `${input._flow._id}.json`),
    JSON.stringify(input._flow, null, 2),
  );
}

async function run_server_xvm_dynamic_reference_validation_tests() {
  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-system-flow-"));
    const system_apps_root = path.join(work_folder, "system-xapps");
    try {
      await write_system_app_fixture({
        _system_apps_root: system_apps_root,
        _app_id: "vibe-system",
        _flow: dynamic_target_flow({
          _flow_id: "flow-create-app-from-starter",
          _app_id: "$event._app_id",
          _env: "$event._env",
          _op: "create_app",
        }),
      });

      const server_xvm = new NodePackage.ServerXVMModule({
        _work_folder: path.join(work_folder, "work"),
        _system_xapps_path: system_apps_root,
      });
      const boot = await (server_xvm as any).init_on_boot();
      assert.equal(boot._apps_loaded, 1);
      assert.equal(boot._flows_loaded, 1);
      const flow = await (server_xvm as any)._get_flow({
        _params: {
          _app_id: "vibe-system",
          _env: "default",
          _flow_id: "flow-create-app-from-starter",
        },
      });
      assert.equal(flow._ok, true);
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }

  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-static-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    try {
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _entry_view_id: "main",
        },
      });

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "other-app",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_INVALID_ACTION_REFERENCE_TARGET",
      );

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "$event",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MALFORMED_DYNAMIC_REFERENCE",
      );

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "$input._app_id",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_UNSUPPORTED_DYNAMIC_REFERENCE",
      );

      const dynamic_ok = await (server_xvm as any)._set_flow({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _flow: dynamic_target_flow({
            _app_id: "$event._app_id",
            _env: "$event._env",
          }),
        },
      });
      assert.equal(dynamic_ok._ok, true);
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }

  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-runtime-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    const flow_manager = new FlowManagerModule();
    const original_execute = (_x as any).execute;
    let target_step_dispatches = 0;
    try {
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _entry_view_id: "main",
        },
      });
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "runtime-target",
          _env: "test",
          _entry_view_id: "main",
        },
      });
      await (server_xvm as any)._set_flow({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow: dynamic_target_flow({
            _app_id: "$event._app_id",
            _env: "$event._env",
          }),
        },
      });

      (_x as any).execute = async (cmd: any) => {
        if (cmd?._module === "server-xvm") {
          const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
          if (cmd?._op === "get_app" && cmd?._params?._app_id !== "runtime-source") {
            target_step_dispatches += 1;
          }
          if (typeof (server_xvm as any)[method] !== "function") {
            throw new Error(`Unexpected server-xvm op ${cmd._op}`);
          }
          return (server_xvm as any)[method](cmd);
        }
        return typeof original_execute === "function"
          ? original_execute.call(_x, cmd)
          : { _ok: true };
      };

      const valid_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "runtime-target",
            _env: "test",
          },
        },
      });
      assert.equal(valid_runtime._ok, true);
      assert.equal(
        valid_runtime._result._flow._outputs["dynamic.target.app_id"],
        "runtime-target",
      );
      assert.equal(target_step_dispatches, 1);

      const empty_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "",
            _env: "test",
          },
        },
      });
      assert.equal(empty_runtime._ok, false);
      assert.equal(response_has_error_code(empty_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);

      const invalid_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "../bad",
            _env: "test",
          },
        },
      });
      assert.equal(invalid_runtime._ok, false);
      assert.equal(response_has_error_code(invalid_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);

      const invalid_env_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "runtime-target",
            _env: "../bad",
          },
        },
      });
      assert.equal(invalid_env_runtime._ok, false);
      assert.equal(response_has_error_code(invalid_env_runtime, "E_FLOW_INVALID_TARGET_ENV"), true);

      const dispatches_before_unresolved = target_step_dispatches;
      const unresolved_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "$event.other",
            _env: "test",
          },
        },
      });
      assert.equal(unresolved_runtime._ok, false);
      assert.equal(response_has_error_code(unresolved_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);
      assert.equal(target_step_dispatches, dispatches_before_unresolved);
    } finally {
      (_x as any).execute = original_execute;
      await rm(work_folder, { recursive: true, force: true });
    }
  }
}

async function run_server_xvm_default_app_contract_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-default-app-"));
  const system_root = path.join(work_folder, "system-xapps");

  try {
    await write_system_app_fixture({
      _system_apps_root: system_root,
      _app_id: "vibe-system",
      _flow: {
        _id: "noop",
        _steps: [],
      },
    });

    const server: any = new NodePackage.ServerXVMModule({
      _work_folder: work_folder,
      _system_xapps_path: system_root,
    });
    await server.init_on_boot();

    await server._create_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });
    await server._create_app({
      _params: {
        _app_id: "other-app",
        _env: "default",
      },
    });
    await server._create_app({
      _params: {
        _app_id: "stage-app",
        _env: "stage",
      },
    });
    await server._create_app({
      _params: {
        _app_id: "trashed-app",
        _env: "default",
      },
    });

    const empty_default = await server._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(empty_default._ok, true);
    assert.equal(empty_default._result._app_id, null);
    assert.equal(empty_default._result._has_default, false);

    const set_default = await server._set_default_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });
    assert.equal(set_default._ok, true);
    assert.equal(set_default._result._app_id, "prod-app");
    assert.equal(set_default._result._persisted, true);

    const set_stage_default = await server._set_default_app({
      _params: {
        _app_id: "stage-app",
        _env: "stage",
      },
    });
    assert.equal(set_stage_default._ok, true);

    const default_app = await server._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(default_app._result._app_id, "prod-app");
    assert.equal(default_app._result._has_default, true);

    const stage_default_app = await server._get_default_app({
      _params: {
        _env: "stage",
      },
    });
    assert.equal(stage_default_app._result._app_id, "stage-app");

    const settings_after_set = JSON.parse(
      await readFile(path.join(work_folder, "settings", "server-settings.json"), "utf-8"),
    );
    assert.deepEqual(settings_after_set._default_apps, {
      default: "prod-app",
      stage: "stage-app",
    });
    assert.equal(settings_after_set._active_apps, undefined);

    await server._set_active_app({
      _params: {
        _app_id: "other-app",
        _env: "default",
      },
    });
    const default_after_active = await server._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(default_after_active._result._app_id, "prod-app");
    const active_after_set = await server._get_active_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(active_after_set._result._app_id, "other-app");

    const restarted: any = new NodePackage.ServerXVMModule({
      _work_folder: work_folder,
      _system_xapps_path: system_root,
    });
    await restarted.init_on_boot();
    const restarted_default = await restarted._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(restarted_default._result._app_id, "prod-app");
    const restarted_stage_default = await restarted._get_default_app({
      _params: {
        _env: "stage",
      },
    });
    assert.equal(restarted_stage_default._result._app_id, "stage-app");
    const restarted_active = await restarted._get_active_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(restarted_active._result._app_id, "other-app");

    await assert.rejects(
      async () => restarted._set_default_app({
        _params: {
          _app_id: "missing-app",
          _env: "default",
        },
      }),
      (err: any) => err?._code === "E_XVM_APP_NOT_FOUND",
    );

    await assert.rejects(
      async () => restarted._set_default_app({
        _params: {
          _app_id: "vibe-system",
          _env: "default",
        },
      }),
      (err: any) => err?._code === "E_XVM_DEFAULT_SYSTEM_APP_FORBIDDEN",
    );

    await restarted._trash_app({
      _params: {
        _app_id: "trashed-app",
        _env: "default",
      },
    });
    await assert.rejects(
      async () => restarted._set_default_app({
        _params: {
          _app_id: "trashed-app",
          _env: "default",
        },
      }),
      (err: any) => err?._code === "E_XVM_DEFAULT_APP_TRASHED",
    );

    const trash_default = await restarted._trash_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });
    assert.equal(trash_default._ok, true);
    const default_after_trash = await restarted._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(default_after_trash._result._app_id, null);
    assert.equal(default_after_trash._result._has_default, false);
    const settings_after_trash = JSON.parse(
      await readFile(path.join(work_folder, "settings", "server-settings.json"), "utf-8"),
    );
    assert.equal(settings_after_trash._default_apps?.default, undefined);
    assert.equal(settings_after_trash._default_apps?.stage, "stage-app");

    await restarted._restore_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });
    const default_after_restore = await restarted._get_default_app({
      _params: {
        _env: "default",
      },
    });
    assert.equal(default_after_restore._result._app_id, null);

    const clear_stage = await restarted._clear_default_app({
      _params: {
        _env: "stage",
      },
    });
    assert.equal(clear_stage._ok, true);
    assert.equal(clear_stage._result._previous_app_id, "stage-app");
    assert.equal(clear_stage._result._cleared, true);
    const stage_after_clear = await restarted._get_default_app({
      _params: {
        _env: "stage",
      },
    });
    assert.equal(stage_after_clear._result._app_id, null);
  } finally {
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_xweb_bootstrap_routing_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-xweb-bootstrap-"));
  const system_root = path.join(work_folder, "system-xapps");
  const settings_file = path.join(work_folder, "settings", "server-settings.json");

  try {
    await write_system_app_fixture({
      _system_apps_root: system_root,
      _app_id: "vibe-system",
      _flow: {
        _id: "noop",
        _steps: [],
      },
    });

    const server: any = new NodePackage.ServerXVMModule({
      _work_folder: work_folder,
      _system_xapps_path: system_root,
    });
    await server.init_on_boot();
    await server._create_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });
    await server._create_app({
      _params: {
        _app_id: "trashed-app",
        _env: "default",
      },
    });
    await server._set_default_app({
      _params: {
        _app_id: "prod-app",
        _env: "default",
      },
    });

    await with_xweb_bootstrap_server(work_folder, server, async (base_url) => {
      const root = await read_http_bytes(`${base_url}/`);
      assert.equal(root._status, 200);
      assert.equal(root._headers["x-xpell-bootstrap-mode"], "runtime");
      assert.equal(root._headers["x-xpell-bootstrap-app-id"], "prod-app");
      assert.equal(root._headers["x-xpell-bootstrap-env"], "default");
      assert.equal(root._headers["cache-control"], "no-store");
      const bootstrap = read_xweb_bootstrap(root);
      assert.deepEqual(bootstrap, {
        _mode: "runtime",
        _admin: false,
        _app_id: "prod-app",
        _env: "default",
      });

      const admin_default_before = await server._get_default_app({
        _params: {
          _env: "default",
        },
      });
      const unauth_admin = await read_http_bytes(`${base_url}/admin`);
      assert.equal(unauth_admin._status, 200);
      assert.equal(unauth_admin._headers["x-xpell-bootstrap-mode"], "admin-login");
      assert.equal(unauth_admin._headers["x-xpell-bootstrap-app-id"], undefined);
      const unauth_bootstrap = read_xweb_bootstrap(unauth_admin);
      assert.deepEqual(unauth_bootstrap, {
        _mode: "admin-login",
        _admin: true,
        _app_id: null,
        _env: "default",
        _authenticated: false,
        _required_clearance_level: 100,
        _reason: "missing_session",
      });
      assert.equal(JSON.stringify(unauth_bootstrap).includes("vibe-system"), false);

      const login_response = await post_http_bytes(
        `${base_url}/xauth/login`,
        Buffer.from(JSON.stringify({
          email: "admin@local.dev",
          password: "admin",
        })),
        {
          "content-type": "application/json",
        },
      );
      assert.equal(login_response._status, 200);
      const login_body = read_json_response(login_response);
      assert.equal(login_body._ok, true);
      assert.equal(login_body._authenticated, true);
      assert.equal(login_body._session._clearance_level, 100);
      assert.equal(JSON.stringify(login_body).includes("_token"), false);
      const admin_cookie = cookie_header_from_set_cookie(login_response._headers["set-cookie"]);
      assert.match(admin_cookie, /^xauth_session=/);

      const admin = await read_http_bytes(`${base_url}/admin`, {
        _headers: {
          cookie: admin_cookie,
        },
      });
      assert.equal(admin._status, 200);
      assert.equal(admin._headers["x-xpell-bootstrap-mode"], "admin");
      assert.equal(admin._headers["x-xpell-bootstrap-app-id"], "vibe-system");
      assert.deepEqual(read_xweb_bootstrap(admin), {
        _mode: "admin",
        _admin: true,
        _app_id: "vibe-system",
        _env: "default",
      });

      const unauth_set_default = await post_wormholes_call(
        base_url,
        "server-xvm",
        "set-default-app",
        { _app_id: "prod-app", _env: "default" },
      );
      assert.equal(read_wormholes_error_code(unauth_set_default), "E_WH_UNAUTHORIZED");

      const spoofed_auth = await post_wormholes_call(
        base_url,
        "server-xvm",
        "set-default-app",
        {
          _app_id: "prod-app",
          _env: "default",
          _auth: {
            _authenticated: true,
            _clearance_level: 100,
          },
        },
      );
      assert.equal(read_wormholes_error_code(spoofed_auth), "E_WH_UNAUTHORIZED");

      const low_clearance_token = NodePackage.sign_jwt({
        _user_id: "low-user",
        _account_id: "low-account",
        _clearance_level: 99,
        _auth_type: "jwt",
      });
      const denied_admin = await read_http_bytes(`${base_url}/admin`, {
        _headers: {
          cookie: `xauth_session=${encodeURIComponent(low_clearance_token)}`,
        },
      });
      assert.equal(denied_admin._status, 200);
      assert.equal(denied_admin._headers["x-xpell-bootstrap-mode"], "admin-denied");
      assert.equal(denied_admin._headers["x-xpell-bootstrap-app-id"], undefined);
      const denied_bootstrap = read_xweb_bootstrap(denied_admin);
      assert.deepEqual(denied_bootstrap, {
        _mode: "admin-denied",
        _admin: true,
        _app_id: null,
        _env: "default",
        _authenticated: true,
        _clearance_level: 99,
        _required_clearance_level: 100,
      });
      assert.equal(JSON.stringify(denied_bootstrap).includes("vibe-system"), false);

      const low_clearance_set_default = await post_wormholes_call(
        base_url,
        "server-xvm",
        "set-default-app",
        { _app_id: "prod-app", _env: "default" },
        { cookie: `xauth_session=${encodeURIComponent(low_clearance_token)}` },
      );
      assert.equal(read_wormholes_error_code(low_clearance_set_default), "E_WH_FORBIDDEN");

      const public_runtime_get_app = await post_wormholes_call(
        base_url,
        "server-xvm",
        "get-app",
        { _app_id: "prod-app", _env: "default", _include_views: false },
      );
      assert.equal(public_runtime_get_app._payload._ok, true);
      assert.equal(read_wormholes_result(public_runtime_get_app)._app._app_id, "prod-app");

      const admin_set_default = await post_wormholes_call(
        base_url,
        "server-xvm",
        "set-default-app",
        { _app_id: "prod-app", _env: "default" },
        { cookie: admin_cookie },
      );
      assert.equal(admin_set_default._payload._ok, true);
      assert.equal(read_wormholes_result(admin_set_default)._app_id, "prod-app");

      const super_admin_token = NodePackage.sign_jwt({
        _user_id: "super-admin",
        _account_id: "super-account",
        _clearance_level: 101,
        _auth_type: "jwt",
      });
      const super_admin_list_trash = await post_wormholes_call(
        base_url,
        "server-xvm",
        "list-trashed-apps",
        { _env: "default" },
        { cookie: `xauth_session=${encodeURIComponent(super_admin_token)}` },
      );
      assert.equal(super_admin_list_trash._payload._ok, true);

      const protected_ops = [
        ["server-xvm", "export-app"],
        ["server-xvm", "upload-app-package"],
        ["server-xvm", "inspect-app-package"],
        ["server-xvm", "preview-app-import"],
        ["server-xvm", "import-app"],
        ["server-xvm", "trash-app"],
        ["server-xvm", "restore-app"],
        ["server-xvm", "create_app"],
        ["server-xvm", "push_update"],
        ["server-xvm", "save_view_json"],
        ["server-xvm", "set_flow"],
        ["server-xvm", "set_entity"],
        ["server-xvm", "delete_entity"],
        ["server-xvm", "load_app_from_disk"],
        ["server-xvm", "reload_app"],
        ["server-xvm", "apply_generated_operation"],
        ["server-xvm", "apply_change_plan_operations"],
        ["server-xvm", "save_project_memory"],
        ["server-xvm", "patch_project_memory"],
        ["server-xvm", "list_apps"],
        ["server-xvm", "list_generated_modules"],
        ["studio", "generate-view"],
        ["module-creator", "create-module-spec"],
        ["xvibe", "apply-view-edit"],
      ];
      for (const [module_name, op_name] of protected_ops) {
        const blocked = await post_wormholes_call(base_url, module_name, op_name, {});
        assert.equal(
          read_wormholes_error_code(blocked),
          "E_WH_UNAUTHORIZED",
          `${module_name}.${op_name} should require admin auth`,
        );
      }

      const original_expires = process.env.XAUTH_JWT_EXPIRES_IN;
      const original_date_now = Date.now;
      try {
        process.env.XAUTH_JWT_EXPIRES_IN = "1s";
        Date.now = () => 1_000_000;
        const expired_token = NodePackage.sign_jwt({
          _user_id: "expired-user",
          _account_id: "expired-account",
          _clearance_level: 100,
          _auth_type: "jwt",
        });
        Date.now = () => 3_000_000;
        const expired_admin = await read_http_bytes(`${base_url}/admin`, {
          _headers: {
            cookie: `xauth_session=${encodeURIComponent(expired_token)}`,
          },
        });
        assert.equal(expired_admin._status, 200);
        assert.equal(expired_admin._headers["x-xpell-bootstrap-mode"], "admin-login");
        const expired_bootstrap = read_xweb_bootstrap(expired_admin);
        assert.equal(expired_bootstrap._mode, "admin-login");
        assert.equal(expired_bootstrap._reason, "expired_session");
        assert.equal(JSON.stringify(expired_bootstrap).includes("vibe-system"), false);

        const expired_wormholes = await post_wormholes_call(
          base_url,
          "server-xvm",
          "set-default-app",
          { _app_id: "prod-app", _env: "default" },
          { cookie: `xauth_session=${encodeURIComponent(expired_token)}` },
        );
        assert.equal(read_wormholes_error_code(expired_wormholes), "E_WH_UNAUTHORIZED");
      } finally {
        Date.now = original_date_now;
        restore_env("XAUTH_JWT_EXPIRES_IN", original_expires);
      }

      const admin_default_after = await server._get_default_app({
        _params: {
          _env: "default",
        },
      });
      assert.equal(admin_default_before._result._app_id, "prod-app");
      assert.equal(admin_default_after._result._app_id, "prod-app");
    }, { _enable_wormholes: true });

    const restarted: any = new NodePackage.ServerXVMModule({
      _work_folder: work_folder,
      _system_xapps_path: system_root,
    });
    await restarted.init_on_boot();
    await with_xweb_bootstrap_server(work_folder, restarted, async (base_url) => {
      const root_after_restart = await read_http_bytes(`${base_url}/`);
      assert.equal(root_after_restart._status, 200);
      assert.equal(read_xweb_bootstrap(root_after_restart)._app_id, "prod-app");
    });

    await restarted._clear_default_app({
      _params: {
        _env: "default",
      },
    });
    await with_xweb_bootstrap_server(work_folder, restarted, async (base_url) => {
      const missing_default = await read_http_bytes(`${base_url}/`);
      assert.equal(missing_default._status, 503);
      assert.equal(read_json_response(missing_default)._result._code, "E_XWEB_DEFAULT_APP_NOT_CONFIGURED");
    });

    await restarted._trash_app({
      _params: {
        _app_id: "trashed-app",
        _env: "default",
      },
    });
    await writeFile(
      settings_file,
      JSON.stringify({ _default_apps: { default: "trashed-app" } }, null, 2),
    );
    NodeCorePackage._xs.load(settings_file);
    await with_xweb_bootstrap_server(work_folder, restarted, async (base_url) => {
      const trashed_default = await read_http_bytes(`${base_url}/`);
      assert.equal(trashed_default._status, 409);
      assert.equal(read_json_response(trashed_default)._result._code, "E_XWEB_DEFAULT_APP_TRASHED");
    });

    await writeFile(
      settings_file,
      JSON.stringify({ _default_apps: { default: "missing-app" } }, null, 2),
    );
    NodeCorePackage._xs.load(settings_file);
    await with_xweb_bootstrap_server(work_folder, restarted, async (base_url) => {
      const missing_app = await read_http_bytes(`${base_url}/`);
      assert.equal(missing_app._status, 503);
      assert.equal(read_json_response(missing_app)._result._code, "E_XWEB_DEFAULT_APP_UNAVAILABLE");
    });
  } finally {
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_xweb_raw_json_body_tests() {
  const sensitive_marker = "raw-json-must-not-leak";
  const captured_logs: unknown[][] = [];
  const original_log = NodePackage._xlog.log;
  const original_warn = NodePackage._xlog.warn;
  const original_error = NodePackage._xlog.error;
  (NodePackage._xlog as any).log = (...args: unknown[]) => captured_logs.push(args);
  (NodePackage._xlog as any).warn = (...args: unknown[]) => captured_logs.push(args);
  (NodePackage._xlog as any).error = (...args: unknown[]) => captured_logs.push(args);

  try {
    await with_xweb_raw_json_server(async (base_url, work_folder) => {
      const assert_preserved_json = async (
        payload: Buffer,
        expected_body: unknown,
      ) => {
        const response = await post_http_bytes(
          `${base_url}/__xweb_test/inspect-json`,
          payload,
          { "content-type": "application/json" },
        );
        assert.equal(response._status, 200);
        const result = read_json_response(response);
        assert.deepEqual(result._body, expected_body);
        assert.equal(result._raw_body_is_buffer, true);
        assert.deepEqual(Buffer.from(result._raw_body_base64, "base64"), payload);
      };

      const valid_payload = Buffer.from('{"event":"created","count":2}', "utf8");
      await assert_preserved_json(valid_payload, { event: "created", count: 2 });

      const whitespace_payload = Buffer.from(
        '{\n  "event": "created",\n\t"data": { "count": 2 }\n}\n',
        "utf8",
      );
      await assert_preserved_json(whitespace_payload, {
        event: "created",
        data: { count: 2 },
      });

      const unicode_payload = Buffer.from(
        '{"message":"שלום 🌍","combining":"é"}',
        "utf8",
      );
      await assert_preserved_json(unicode_payload, {
        message: "שלום 🌍",
        combining: "é",
      });

      const normal_payload = Buffer.from(
        '{  "existing": true, "nested": { "value": 7 } }',
        "utf8",
      );
      const normal_response = await post_http_bytes(
        `${base_url}/__xweb_test/normal-json`,
        normal_payload,
        { "content-type": "application/json" },
      );
      assert.equal(normal_response._status, 200);
      assert.deepEqual(read_json_response(normal_response), {
        existing: true,
        nested: { value: 7 },
      });
      assert.equal(normal_response._bytes.includes(Buffer.from("rawBody")), false);

      const non_json_response = await post_http_bytes(
        `${base_url}/__xweb_test/non-json`,
        Buffer.from("binary-or-streaming-body", "utf8"),
        { "content-type": "application/octet-stream" },
      );
      assert.equal(non_json_response._status, 200);
      assert.deepEqual(read_json_response(non_json_response), {
        _has_raw_body: false,
      });

      const malformed_payload = Buffer.from(
        `{"malformed_marker":"${sensitive_marker}",`,
        "utf8",
      );
      const malformed_response = await post_http_bytes(
        `${base_url}/__xweb_test/inspect-json`,
        malformed_payload,
        { "content-type": "application/json" },
      );
      assert.equal(malformed_response._status, 400);
      assert.equal(
        read_json_response(malformed_response)._result._code,
        "E_XWEB_BAD_JSON",
      );
      assert.equal(malformed_response._bytes.includes(malformed_payload), false);

      const oversized_payload = Buffer.concat([
        Buffer.from('{"value":"', "utf8"),
        Buffer.alloc(10 * 1024 * 1024, "x"),
        Buffer.from('"}', "utf8"),
      ]);
      const oversized_response = await post_http_bytes(
        `${base_url}/__xweb_test/inspect-json`,
        oversized_payload,
        { "content-type": "application/json" },
      );
      assert.equal(oversized_response._status, 413);
      assert.equal(
        read_json_response(oversized_response)._result._code,
        "E_XWEB_REQUEST_TOO_LARGE",
      );

      const persisted_entries = await readdir(work_folder, { recursive: true });
      for (const relative_path of persisted_entries) {
        const absolute_path = path.join(work_folder, relative_path.toString());
        if (!(await stat(absolute_path)).isFile()) continue;
        const persisted_bytes = await readFile(absolute_path);
        assert.equal(persisted_bytes.includes(valid_payload), false);
        assert.equal(persisted_bytes.includes(whitespace_payload), false);
        assert.equal(persisted_bytes.includes(unicode_payload), false);
        assert.equal(persisted_bytes.includes(malformed_payload), false);
      }
    });

    const log_contains_marker = (
      value: unknown,
      seen = new WeakSet<object>(),
    ): boolean => {
      if (typeof value === "string") return value.includes(sensitive_marker);
      if (Buffer.isBuffer(value)) {
        return value.includes(Buffer.from(sensitive_marker, "utf8"));
      }
      if (typeof value !== "object" || value === null) return false;
      if (seen.has(value)) return false;
      seen.add(value);
      return Object.values(value).some((nested) => log_contains_marker(nested, seen));
    };
    assert.equal(captured_logs.some((entry) => log_contains_marker(entry)), false);
  } finally {
    (NodePackage._xlog as any).log = original_log;
    (NodePackage._xlog as any).warn = original_warn;
    (NodePackage._xlog as any).error = original_error;
  }
}

async function run_studio_runtime_skill_sync_contract_tests() {
  const { XStudioModule } = await import("./XStudio/XStudioModule.js");
  const original_execute = (_x as any).execute;
  const studio = new XStudioModule() as any;
  const params = {
    _app_id: "plantkeeper",
    _env: "default",
    _mode: "runtime",
    _skills: {
      _skills: [],
      _objects: [
        { _id: "xgallery", _type: "view-skill", _exports: { _xui_objects: ["xgallery"] } },
      ],
      _modules: [
        { _name: "xui", _objects: [{ _id: "xlist", _type: "view-skill" }] },
      ],
    },
  };

  try {
    let forwarded: any = null;
    (_x as any).execute = async (cmd: any) => {
      forwarded = cmd;
      return {
        _ok: true,
        _result: {
          _synced: true,
          _scope: "default::plantkeeper::runtime",
          _skills_count: 1,
        },
      };
    };

    const ok_result = await studio._sync_client_skills({ _params: params });
    assert.equal(ok_result._ok, true);
    assert.equal(ok_result._result._synced, true);
    assert.equal(forwarded._module, "xvibe");
    assert.equal(forwarded._op, "sync-skills");
    assert.deepEqual(forwarded._params, params);

    const sanitized_result = await studio._sync_client_skills({
      _params: {
        ...params,
        _auth: {
          _authenticated: true,
          _clearance_level: 100,
        },
        _wid: "transport-wid",
        _sid: "transport-sid",
      },
    });
    assert.equal(sanitized_result._ok, true);
    assert.equal(forwarded._params._auth, undefined);
    assert.equal(forwarded._params._wid, undefined);
    assert.equal(forwarded._params._sid, undefined);

    const large_runtime_snapshot = {
      _skills: [],
      _objects: new Array(108).fill(null).map((_, index) => ({
        _id: `runtime-type-${index}`,
        _type: "view-skill",
        _exports: { _xui_objects: [`runtime-type-${index}`] },
        _design: {
          _palette: {
            _title: `Runtime Type ${index}`,
            _category: "Data Display",
            _default_object: { _type: `runtime-type-${index}` },
          },
          _inspector: {
            _fields: [
              { _key: "_data_source", _label: "Data Source", _input: "text" },
              { _key: "_items", _label: "Items", _input: "json" },
            ],
          },
        },
      })),
      _modules: new Array(12).fill(null).map((_, index) => ({
        _name: `runtime-module-${index}`,
        _skills: [
          {
            _id: `runtime-module-${index}`,
            _type: "client-module-api",
            _exports: {
              _modules: [
                { _name: `runtime-module-${index}`, _scope: "client", _ops: [] },
              ],
            },
          },
        ],
      })),
    };
    const large_result = await studio._sync_client_skills({
      _params: {
        ...params,
        _skills: large_runtime_snapshot,
      },
    });
    assert.equal(large_result._ok, true);
    assert.equal(forwarded._params._skills._objects.length, 108);
    assert.equal(forwarded._params._skills._modules.length, 12);

    const invalid_mode_result = await studio._sync_client_skills({
      _params: {
        ...params,
        _mode: "build",
      },
    });
    assert.equal(invalid_mode_result._ok, false);
    assert.equal(invalid_mode_result._result._synced, false);
    assert.equal(invalid_mode_result._result._forwarded_to_xvibe, false);
    assert.equal(invalid_mode_result._result._error._code, "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC");

    const direct_oversized_result = await studio._sync_client_skills({
      _params: {
        ...params,
        _skills: {
          _skills: [],
          _objects: new Array(300).fill(null).map((_, index) => ({
            _id: `oversized-type-${index}`,
            _type: "view-skill",
            _description: "x".repeat(8_000),
          })),
          _modules: [],
        },
      },
    });
    assert.equal(direct_oversized_result._ok, false);
    assert.equal(direct_oversized_result._result._forwarded_to_xvibe, false);
    assert.equal(direct_oversized_result._result._error._details._limit, "max_json_bytes");
    assert.equal(direct_oversized_result._result._error._details._configured_limit, 2_000_000);

    (_x as any).execute = async () => ({
      _ok: false,
      _result: {
        _code: "E_XVIBE_SYNC_SKILLS_FAILED",
        _message: "XVibe unavailable",
        _stack: "internal stack must not leak",
      },
    });
    const failed_result = await studio._sync_client_skills({ _params: params });
    assert.equal(failed_result._ok, false);
    assert.equal(failed_result._result._synced, false);
    assert.equal(failed_result._result._error._code, "E_STUDIO_SYNC_CLIENT_SKILLS_FAILED");
    assert.equal(failed_result._result._error._xvibe._code, "E_XVIBE_SYNC_SKILLS_FAILED");
    assert.equal(JSON.stringify(failed_result).includes("_stack"), false);
    assert.equal(JSON.stringify(failed_result).includes("internal stack"), false);

    (_x as any).execute = async () => {
      throw new Error("XVibe threw");
    };
    const thrown_result = await studio._sync_client_skills({ _params: params });
    assert.equal(thrown_result._ok, false);
    assert.equal(thrown_result._result._synced, false);
    assert.equal(thrown_result._result._error._xvibe._message, "XVibe threw");
  } finally {
    (_x as any).execute = original_execute;
  }
}

async function run_wormholes_runtime_studio_skill_sync_authorization_tests() {
  const web = new NodePackage.XWebServer() as any;
  const make_runtime_object = (id: string) => ({
    _id: id,
    _type: "view-skill",
    _xtype: id,
    _xui_type: id,
    _object_type: id,
    _exports: {
      _xui_objects: [id],
    },
    _design: {
      _palette: {
        _title: id,
        _category: "Data Display",
        _default_object: { _type: id },
      },
      _inspector: {
        _fields: [
          { _key: "_data_source", _label: "Data Source", _input: "text" },
          { _key: "_items", _label: "Items", _input: "json" },
        ],
      },
      _children: {
        _allowed: false,
        _insert_modes: ["before", "after"],
      },
    },
  });
  const make_legitimate_runtime_skills = (count = 108) => ({
    _runtime: {
      _engine_id: "client-runtime",
      _version: "0.0.1",
    },
    _skills: [],
    _objects: new Array(count).fill(null).map((_, index) => make_runtime_object(`runtime-type-${index}`)),
    _modules: new Array(12).fill(null).map((_, index) => ({
      _name: `runtime-module-${index}`,
      _skills: [
        {
          _id: `runtime-module-${index}`,
          _type: "client-module-api",
          _exports: {
            _modules: [
              {
                _name: `runtime-module-${index}`,
                _scope: "client",
                _ops: [
                  { _name: "describe", _scope: "module" },
                ],
              },
            ],
          },
        },
      ],
    })),
  });
  const expect_runtime_skill_forbidden = (skills: any, assert_meta?: (meta: any) => void) => {
    try {
      web.authorizeWormholesReq(
        {
          _module: "studio",
          _op: "sync-client-skills",
          _params: {
            _app_id: "plantkeeper",
            _env: "default",
            _mode: "runtime",
            _skills: skills,
          },
        },
        subscribed_runtime_ctx,
      );
      assert.fail("Expected runtime skill payload rejection");
    } catch (error: any) {
      assert.equal(error?._code, "E_WH_FORBIDDEN");
      assert_meta?.(error?._meta ?? {});
    }
  };
  const valid_skills = {
    _runtime: {
      _engine_id: "client-runtime",
      _version: "0.0.1",
    },
    _skills: [],
    _objects: [
      {
        _id: "xcustom-card",
        _type: "view-skill",
        _exports: {
          _xui_objects: ["xcustom-card"],
        },
      },
    ],
    _modules: [
      {
        _name: "xui",
        _objects: [
          {
            _id: "xcustom-list",
            _type: "view-skill",
            _exports: {
              _xui_objects: ["xcustom-list"],
            },
          },
        ],
      },
    ],
  };
  const valid_params = {
    _app_id: "plantkeeper",
    _env: "default",
    _mode: "runtime",
    _skills: valid_skills,
  };

  const subscribed_runtime_ctx = {
    _sid: "runtime-sid",
    _auth: {
      _authenticated: true,
      _clearance_level: 1,
      _user_id: "runtime-user",
      _account_id: "runtime-account",
      _auth_type: "jwt",
    },
    _meta: {
      _wid: "runtime-wid",
      _app_id: "plantkeeper",
      _env: "default",
    },
  };

  assert.doesNotThrow(() => {
    web.authorizeWormholesReq(
      {
        _module: "studio",
        _op: "sync-client-skills",
        _params: valid_params,
      },
      subscribed_runtime_ctx,
    );
  });

  const legitimate_runtime_skills = make_legitimate_runtime_skills();
  assert.doesNotThrow(() => {
    web.authorizeWormholesReq(
      {
        _module: "studio",
        _op: "sync-client-skills",
        _params: {
          _app_id: "plantkeeper",
          _env: "default",
          _mode: "runtime",
          _skills: legitimate_runtime_skills,
        },
      },
      subscribed_runtime_ctx,
    );
  });
  assert.equal(legitimate_runtime_skills._objects.length, 108);
  assert.equal(legitimate_runtime_skills._modules.length, 12);
  assert.equal(Buffer.byteLength(JSON.stringify(legitimate_runtime_skills), "utf8") < 2_000_000, true);

  assert.throws(
    () => web.authorizeWormholesReq(
      {
        _module: "studio",
        _op: "sync-client-skills",
        _params: valid_params,
      },
      {
        ...subscribed_runtime_ctx,
        _auth: { _authenticated: false },
      },
    ),
    (error: any) => error?._code === "E_WH_UNAUTHORIZED",
  );

  assert.throws(
    () => web.authorizeWormholesReq(
      {
        _module: "studio",
        _op: "sync-client-skills",
        _params: valid_params,
      },
      {
        ...subscribed_runtime_ctx,
        _meta: { _wid: "runtime-wid" },
      },
    ),
    (error: any) => error?._code === "E_WH_FORBIDDEN",
  );

  for (const params of [
    { ...valid_params, _app_id: "other-app" },
    { ...valid_params, _env: "stage" },
    { ...valid_params, _mode: "build" },
    { ...valid_params, _skills: { _modules: [] } },
    {
      ...valid_params,
      _skills: {
        _modules: new Array(129).fill(null).map((_, index) => ({ _name: `m${index}` })),
        _skills: [],
        _objects: [],
      },
    },
    {
      ...valid_params,
      _auth: {
        _authenticated: true,
        _clearance_level: 100,
      },
      _skills: {
        ...valid_skills,
        _auth: {
          _authenticated: true,
          _clearance_level: 100,
        },
      },
    },
  ]) {
    assert.throws(
      () => web.authorizeWormholesReq(
        {
          _module: "studio",
          _op: "sync-client-skills",
          _params: params,
        },
        subscribed_runtime_ctx,
      ),
      (error: any) => error?._code === "E_WH_FORBIDDEN",
    );
  }

  expect_runtime_skill_forbidden(
    {
      _skills: [],
      _objects: new Array(300).fill(null).map((_, index) => ({
        ...make_runtime_object(`oversized-type-${index}`),
        _description: "x".repeat(8_000),
      })),
      _modules: [],
    },
    (meta) => {
      assert.equal(meta._limit, "max_json_bytes");
      assert.equal(meta._configured_limit, 2_000_000);
      assert.equal(meta._payload_bytes > meta._configured_limit, true);
    },
  );

  const deep_value = { _leaf: "ok" };
  let deep_payload: any = deep_value;
  for (let index = 0; index < 14; index += 1) {
    deep_payload = { _nested: deep_payload };
  }
  expect_runtime_skill_forbidden(
    {
      ...valid_skills,
      _objects: [{ ...make_runtime_object("deep-object"), _design: deep_payload }],
    },
    (meta) => {
      assert.equal(meta._limit, "max_depth");
      assert.equal(meta._configured_limit, 12);
    },
  );

  expect_runtime_skill_forbidden(
    {
      ...valid_skills,
      _objects: [{ ...make_runtime_object("large-string"), _description: "x".repeat(16_385) }],
    },
    (meta) => {
      assert.equal(meta._limit, "max_string_length");
      assert.equal(meta._configured_limit, 16_384);
      assert.equal(meta._string_length, 16_385);
    },
  );

  expect_runtime_skill_forbidden(
    {
      ...valid_skills,
      _objects: [
        {
          ...make_runtime_object("large-array"),
          _exports: { _xui_objects: new Array(2_049).fill("large-array") },
        },
      ],
    },
    (meta) => {
      assert.equal(meta._limit, "max_array_length");
      assert.equal(meta._configured_limit, 2_048);
      assert.equal(meta._array_length, 2_049);
    },
  );

  for (const op of ["get-skills", "generate-view"]) {
    assert.throws(
      () => web.authorizeWormholesReq(
        {
          _module: "studio",
          _op: op,
          _params: {},
        },
        subscribed_runtime_ctx,
      ),
      (error: any) => error?._code === "E_WH_FORBIDDEN",
    );
  }
}

async function run_server_xvm_app_trash_restore_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-app-trash-"));
  const system_root = path.join(work_folder, "system-xapps");
  const original_execute = (_x as any).execute;
  const entity_register_calls: any[] = [];
  const entity_unregister_calls: any[] = [];
  let flow_server: any;

  (_x as any).execute = async (cmd: any) => {
    if (cmd?._module === "entity-manager" && cmd?._op === "register") {
      entity_register_calls.push(cmd);
      return { _ok: true };
    }
    if (cmd?._module === "entity-manager" && cmd?._op === "unregister") {
      entity_unregister_calls.push(cmd);
      return { _ok: true };
    }
    if (cmd?._module === "server-xvm" && flow_server) {
      const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
      if (typeof flow_server[method] === "function") {
        return flow_server[method](cmd);
      }
    }
    return typeof original_execute === "function"
      ? original_execute.call(_x, cmd)
      : { _ok: true };
  };

  try {
    const app_id = "trashable-app";
    const env = "default";
    const server: any = new NodePackage.ServerXVMModule({ _work_folder: work_folder });

    await server._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "main",
      },
    });
    await server._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: "task",
          _schema: {
            title: { _type: "String" },
          },
        },
      },
    });
    await server._set_flow({
      _params: {
        _app_id: app_id,
        _env: env,
        _flow: {
          _id: "inspect_main",
          _steps: [
            {
              _id: "read-main",
              _command: {
                _module: "server-xvm",
                _op: "get_view",
                _params: {
                  _view_id: "main",
                },
              },
              _output: {
                _to: { _type: "xdata", _key: "trash.restore.title" },
                _value: "$step.read-main._result._view._children.0._text",
              },
            },
          ],
        },
      },
    });
    await server._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: {
          _id: "main",
          _type: "view",
          _children: [{ _id: "title", _type: "text", _text: "Restored title" }],
        },
      },
    });
    await server._set_active_app({
      _params: {
        _app_id: app_id,
        _env: env,
      },
    });

    const app_dir = path.join(work_folder, "xvm", "apps", env, app_id);
    const trash_dir = path.join(work_folder, "xvm", "trash", env, app_id);
    await mkdir(path.join(app_dir, "conversations", "conv-1"), { recursive: true });
    await writeFile(path.join(app_dir, "conversations", "conv-1", "messages.jsonl"), "{\"_id\":\"m1\"}\n");
    await writeFile(path.join(app_dir, "project-memory.json"), "{\"_current_focus\":\"keep\"}");
    await mkdir(path.join(app_dir, "old_views"), { recursive: true });
    await writeFile(path.join(app_dir, "old_views", "main.1.json"), "{\"_id\":\"main\"}");
    await mkdir(path.join(app_dir, "vibe-runs", "run-1"), { recursive: true });
    await writeFile(path.join(app_dir, "vibe-runs", "run-1", "summary.json"), "{\"_status\":\"done\"}");
    await mkdir(path.join(app_dir, "xdb"), { recursive: true });
    await writeFile(path.join(app_dir, "xdb", "sentinel.json"), "{\"_app_local\":true}");
    await mkdir(path.join(work_folder, "xdb", "entities"), { recursive: true });
    await writeFile(path.join(work_folder, "xdb", "entities", "runtime-sentinel.json"), "{\"_runtime\":true}");
    await mkdir(path.join(work_folder, "public", app_id, "assets"), { recursive: true });
    await writeFile(path.join(work_folder, "public", app_id, "assets", "logo.svg"), "<svg>keep</svg>");

    const active_tree_before = hash_tree_sync(app_dir);
    const external_xdb_before = hash_tree_sync(path.join(work_folder, "xdb"));
    const public_before = hash_tree_sync(path.join(work_folder, "public", app_id));

    const trash_result = await server._trash_app({
      _params: {
        _app_id: app_id,
        _env: env,
      },
    });
    assert.equal(trash_result._ok, true);
    assert.equal(trash_result._result._status, "trashed");
    assert.equal(JSON.stringify(trash_result._result).includes(work_folder), false);
    assert.equal(fs.existsSync(app_dir), false);
    assert.equal(fs.existsSync(trash_dir), true);
    assert.deepEqual(hash_tree_sync(trash_dir), active_tree_before);
    assert.deepEqual(hash_tree_sync(path.join(work_folder, "xdb")), external_xdb_before);
    assert.deepEqual(hash_tree_sync(path.join(work_folder, "public", app_id)), public_before);
    assert.ok(entity_unregister_calls.some((cmd) => cmd._params?._entity_id === "task"));

    const active_list_after_trash = await server._list_apps({
      _params: {
        _env: env,
      },
    });
    assert.equal(active_list_after_trash._result._app_ids.includes(app_id), false);
    const trashed_list = await server._list_trashed_apps({
      _params: {
        _env: env,
      },
    });
    assert.deepEqual(trashed_list._result._app_ids, [app_id]);
    const active_after_trash = await server._get_active_app({
      _params: { _env: env },
    });
    assert.equal(active_after_trash._result._app_id, "vibe-system");
    const settings_after_trash = JSON.parse(
      await readFile(path.join(work_folder, "settings", "server-settings.json"), "utf-8"),
    );
    assert.notEqual(settings_after_trash._active_apps?.[env], app_id);

    await assert.rejects(
      async () => server._trash_app({
        _params: {
          _app_id: app_id,
          _env: env,
        },
      }),
      (err: any) => err?._code === "E_XVM_APP_ALREADY_TRASHED",
    );

    const restarted: any = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    await restarted.init_on_boot();
    const restarted_active_list = await restarted._list_apps({
      _params: {
        _env: env,
      },
    });
    assert.equal(restarted_active_list._result._app_ids.includes(app_id), false);
    const restarted_trash_list = await restarted._list_trashed_apps({
      _params: {
        _env: env,
      },
    });
    assert.deepEqual(restarted_trash_list._result._app_ids, [app_id]);

    const restore_result = await restarted._restore_app({
      _params: {
        _app_id: app_id,
        _env: env,
      },
    });
    assert.equal(restore_result._ok, true);
    assert.equal(restore_result._result._status, "restored");
    assert.equal(JSON.stringify(restore_result._result).includes(work_folder), false);
    assert.equal(fs.existsSync(app_dir), true);
    assert.equal(fs.existsSync(trash_dir), false);
    assert.deepEqual(hash_tree_sync(app_dir), active_tree_before);
    assert.deepEqual(hash_tree_sync(path.join(work_folder, "xdb")), external_xdb_before);
    assert.deepEqual(hash_tree_sync(path.join(work_folder, "public", app_id)), public_before);
    assert.ok(entity_register_calls.some((cmd) => cmd._params?._app_id === app_id && cmd._params?._entity?._id === "task"));

    const restored_active_list = await restarted._list_apps({
      _params: {
        _env: env,
      },
    });
    assert.equal(restored_active_list._result._app_ids.includes(app_id), true);
    const restored_app = await restarted._get_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _include_views: true,
        _include_flows: true,
      },
    });
    assert.equal(restored_app._result._views.main._children[0]._text, "Restored title");

    flow_server = restarted;
    const flow_result = await new FlowManagerModule()._run({
      _params: {
        _app_id: app_id,
        _env: env,
        _flow_id: "inspect_main",
      },
    } as any);
    assert.equal(flow_result._ok, true);
    assert.equal(flow_result._result._flow._outputs["trash.restore.title"], "Restored title");

    await restarted._create_app({
      _params: {
        _app_id: app_id,
        _env: "stage",
      },
    });
    const stage_trash = await restarted._trash_app({
      _params: {
        _app_id: app_id,
        _env: "stage",
      },
    });
    assert.equal(stage_trash._ok, true);
    assert.equal(fs.existsSync(path.join(work_folder, "xvm", "apps", env, app_id, "app.json")), true);
    assert.equal(fs.existsSync(path.join(work_folder, "xvm", "trash", "stage", app_id, "app.json")), true);

    await restarted._create_app({
      _params: {
        _app_id: "restore-collision",
        _env: env,
      },
    });
    await restarted._trash_app({
      _params: {
        _app_id: "restore-collision",
        _env: env,
      },
    });
    await restarted._create_app({
      _params: {
        _app_id: "restore-collision",
        _env: env,
      },
    });
    await assert.rejects(
      async () => restarted._restore_app({
        _params: {
          _app_id: "restore-collision",
          _env: env,
        },
      }),
      (err: any) => err?._code === "E_XVM_APP_RESTORE_COLLISION",
    );

    await write_system_app_fixture({
      _system_apps_root: system_root,
      _app_id: "vibe-system",
      _flow: {
        _id: "noop",
        _steps: [],
      },
    });
    const system_server: any = new NodePackage.ServerXVMModule({
      _work_folder: path.join(work_folder, "system-work"),
      _system_xapps_path: system_root,
    });
    await system_server.init_on_boot();
    await assert.rejects(
      async () => system_server._trash_app({
        _params: {
          _app_id: "vibe-system",
          _env: "default",
        },
      }),
      (err: any) => err?._code === "E_XVM_SYSTEM_APP_TRASH_FORBIDDEN",
    );
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }
}

function deterministic_visibility_operation(input: {
  _id?: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _target_id: string;
  _edit_action?: string;
  _property_name?: string;
  _property_value?: boolean;
  _precondition?: Record<string, any>;
}): any {
  return {
    _type: "deterministic",
    ...(input._id ? { _id: input._id } : {}),
    _primitive: {
      _module: "xvibe",
      _op: "apply-view-edit",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _view_id: input._view_id,
        _edit_action: input._edit_action ?? "hide-object",
        _target_id: input._target_id,
        ...(input._property_name !== undefined
          ? { _property_name: input._property_name }
          : {}),
        ...(input._property_value !== undefined
          ? { _property_value: input._property_value }
          : {}),
        ...(input._precondition ? { _precondition: input._precondition } : {}),
      },
    },
  };
}

async function create_change_plan_server_fixture(input: {
  _app_id: string;
  _initial_title?: string;
}) {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-change-plan-"));
  const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
  const app_id = input._app_id;
  const env = "test";

  await (server_xvm as any)._create_app({
    _params: {
      _app_id: app_id,
      _env: env,
      _entry_view_id: "main",
    },
  });
  await (server_xvm as any)._push_update({
    _params: {
      _app_id: app_id,
      _env: env,
      _view: change_plan_test_view("main", input._initial_title ?? "Starter"),
    },
  });
  await (server_xvm as any)._set_flow({
    _params: {
      _app_id: app_id,
      _env: env,
      _flow: {
        _id: "save_item",
        _steps: [],
      },
    },
  });
  const original_execute = (_x as any).execute;
  try {
    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "entity-manager" && cmd?._op === "register") {
        return { _ok: true, _result: { _registered: true } };
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };
    await (server_xvm as any)._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: "item",
          _schema: {
            name: { _type: "string" },
          },
        },
      },
    });
  } finally {
    (_x as any).execute = original_execute;
  }
  await (server_xvm as any)._save_project_memory({
    _params: {
      _app_id: app_id,
      _env: env,
      _memory: {
        _version: 1,
        _stage: "building",
        _vision: "Build a generated operation app",
        _goal: "Apply safe Change Plan operations",
        _current_focus: "Main",
        _completed: [],
        _achievements: [],
        _milestones: [
          {
            _id: "main",
            _title: "Main",
            _items: [
              {
                _id: "main",
                _title: "Main",
                _completed: false,
                _artifact_type: "view",
                _view_id: "main",
              },
            ],
          },
        ],
        _parking_lot: [],
        _decisions: [],
        _notes: [],
        _updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  return {
    server_xvm,
    work_folder,
    app_id,
    env,
  };
}

async function run_server_xvm_change_plan_operation_tests() {
  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "generated-view-op",
    });
    try {
      const operation = generated_view_operation({
        _id: "replace-main",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Generated Main",
      });
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._operation._id, "replace-main");
      assert.equal(result._result._refresh._views.main._children[0]._text, "Generated Main");
      assert.deepEqual(
        result._result._project_memory._last_change_plan_execution._operations[0],
        operation,
      );
      assert.ok(
        result._result._project_memory._achievements.some(
          (achievement: any) => achievement._id === "first-suggested-action-applied",
        ),
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._entities,
        [{ _id: "item" }],
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "mixed-plan-order",
    });
    const original_execute = (_x as any).execute;
    const execution_order: string[] = [];
    try {
      (_x as any).execute = async (cmd: any) => {
        execution_order.push(`${cmd._module}.${cmd._op}`);
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            {
              _type: "generated",
              _operation: generated_view_operation({
                _id: "generated-after-deterministic",
                _app_id: fixture.app_id,
                _env: fixture.env,
                _view_id: "main",
                _title: "Generated After Deterministic",
              }),
            },
            {
              _type: "deterministic",
              _id: "deterministic-first",
              _primitive: {
                _module: "xvibe",
                _op: "apply-view-edit",
                _params: {
                  _app_id: fixture.app_id,
                  _env: fixture.env,
                  _view_id: "main",
                  _edit_action: "hide-object",
                  _target_id: "main-summary",
                },
              },
            },
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.deepEqual(execution_order, ["xvibe.apply-view-edit"]);
      assert.equal(result._result._operations[0]._type, "deterministic");
      assert.equal(result._result._operations[1]._type, "generated");
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(view._result._view._children[0]._text, "Generated After Deterministic");
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "stale-target",
    });
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      const operation = generated_view_operation({
        _id: "stale-main",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Should Not Apply",
        _precondition: {
          _target_hash: change_plan_view_hash(initial._result._view),
        },
      });
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view: change_plan_test_view("main", "Changed Elsewhere"),
        },
      });
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_STALE_CONTEXT");
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(view._result._view._children[0]._text, "Changed Elsewhere");
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "duplicate-safe",
    });
    try {
      const operation = generated_view_operation({
        _id: "replace-main-once",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Idempotent Main",
      });
      const first = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });
      const second = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });
      assert.equal(first._ok, true);
      assert.equal(second._ok, true);
      assert.equal(second._result._already_completed, true);

      const duplicate_create = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: generated_view_operation({
            _id: "create-main-duplicate",
            _app_id: fixture.app_id,
            _env: fixture.env,
            _view_id: "main",
            _kind: "view.create",
            _title: "Different Main",
          }),
        },
      });
      assert.equal(duplicate_create._ok, false);
      assert.equal(duplicate_create._result._code, "E_XVM_GENERATED_OPERATION_DUPLICATE_ARTIFACT");
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "rollback-plan",
    });
    const original_execute = (_x as any).execute;
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      (_x as any).execute = async (cmd: any) => {
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            {
              _type: "deterministic",
              _primitive: {
                _module: "xvibe",
                _op: "apply-view-edit",
                _params: {
                  _app_id: fixture.app_id,
                  _env: fixture.env,
                  _view_id: "main",
                  _edit_action: "hide-object",
                  _target_id: "main-summary",
                },
              },
            },
            {
              _type: "generated",
              _operation: generated_view_operation({
                _id: "stale-after-deterministic",
                _app_id: fixture.app_id,
                _env: fixture.env,
                _view_id: "main",
                _title: "Should Roll Back",
                _precondition: {
                  _target_hash: change_plan_view_hash(initial._result._view),
                },
              }),
            },
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._rollback._ok, true);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.deepEqual(view._result._view, initial._result._view);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "hide-one-object",
    });
    const original_execute = (_x as any).execute;
    const executed: any[] = [];
    let update_events = 0;
    const listener_id = NodePackage._xem.on("server-xvm:update", (payload: any) => {
      if (payload?._app_id === fixture.app_id && payload?._view_id === "main") {
        update_events += 1;
      }
    });
    try {
      (_x as any).execute = async (cmd: any) => {
        executed.push(cmd);
        if (cmd?._module === "entity-manager" && cmd?._op === "register") {
          return { _ok: true, _result: { _registered: true } };
        }
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _id: "hide-summary",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
            }),
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._results[0]._status, "updated");
      assert.equal(executed.length, 1);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._hidden, undefined);
      assert.equal(find_json_object_by_id(view._result._view, "main-title")._text, "Starter");
      assert.ok(result._result._project_memory._last_change_plan_execution);
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
      assert.equal(update_events >= 1, true);

      const backup_dir = path.join(
        fixture.work_folder,
        "xvm",
        "apps",
        fixture.env,
        fixture.app_id,
        "old_views",
      );
      assert.equal((await readdir(backup_dir)).length >= 1, true);

      const reloaded = new NodePackage.ServerXVMModule({ _work_folder: fixture.work_folder });
      await (reloaded as any).init_on_boot();
      const reloaded_view = await (reloaded as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(reloaded_view._result._view, "main-summary")._visible, false);
    } finally {
      NodePackage._xem.remove(listener_id);
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "hide-several-objects",
    });
    const original_execute = (_x as any).execute;
    try {
      (_x as any).execute = async (cmd: any) => {
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _id: "hide-summary",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
            }),
            deterministic_visibility_operation({
              _id: "hide-footer",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-footer",
            }),
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.deepEqual(
        result._result._results.map((item: any) => item._status),
        ["updated", "updated"],
      );
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-footer")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-title")._text, "Starter");
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "already-hidden-object",
    });
    const original_execute = (_x as any).execute;
    let executed = 0;
    try {
      (_x as any).execute = async (cmd: any) => {
        executed += 1;
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const operation = deterministic_visibility_operation({
        _id: "hide-summary",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _target_id: "main-summary",
      });
      const first = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [operation],
        },
      });
      const second = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [operation],
        },
      });

      assert.equal(first._ok, true);
      assert.equal(second._ok, true);
      assert.equal(second._result._results[0]._status, "already_hidden");
      assert.equal(second._result._results[0]._result._already_hidden, true);
      assert.equal(executed, 1);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-target-missing",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "missing-object",
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_TARGET_OBJECT_NOT_FOUND");
      assert.equal(executed, false);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, undefined);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-stale-view",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view: change_plan_test_view("main", "Changed Elsewhere"),
        },
      });
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
              _precondition: {
                _view_hash: change_plan_view_hash(initial._result._view),
              },
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_STALE_CONTEXT");
      assert.equal(executed, false);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-invalid-property",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
              _edit_action: "set-property",
              _property_name: "style",
              _property_value: false,
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_INVALID_PROPERTY");
      assert.equal(executed, false);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "runtime-refresh",
    });
    try {
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: generated_view_operation({
            _id: "create-details",
            _app_id: fixture.app_id,
            _env: fixture.env,
            _view_id: "details",
            _kind: "view.create",
            _title: "Details",
            _set_default_view: true,
          }),
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._refresh._default_view_id, "details");
      assert.deepEqual(
        result._result._refresh._view_ids.sort(),
        ["details", "main"],
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
      assert.ok(result._result._project_memory._last_change_plan_execution);
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "idempotent-default-view",
    });
    try {
      const create_details = generated_view_operation({
        _id: "create-details-without-default",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "details",
        _kind: "view.create",
        _title: "Details",
      });
      const first = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: create_details,
        },
      });
      assert.equal(first._ok, true);
      assert.equal(first._result._refresh._default_view_id, "main");

      const set_default = {
        ...create_details,
        _id: "create-details-idempotent-default",
        _set_default_view: true,
      };
      const second = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: set_default,
          _set_default_view: true,
        },
      });
      assert.equal(second._ok, true);
      assert.equal(second._result._already_completed, true);
      assert.equal(second._result._changed, true);
      assert.equal(second._result._default_view_changed, true);
      assert.equal(second._result._refresh._default_view_id, "details");

      const bundle = (fixture.server_xvm as any).get_bundle(fixture.app_id, fixture.env);
      bundle._app._meta._entry_view_id = "details";
      bundle._app._config = {};
      (fixture.server_xvm as any).persist_bundle(bundle);
      const third = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: set_default,
          _set_default_view: true,
        },
      });
      assert.equal(third._ok, true);
      assert.equal(third._result._already_completed, true);
      assert.equal(third._result._changed, true);
      assert.equal(third._result._default_view_changed, true);
      assert.equal(third._result._refresh._default_view_id, "details");

      const app = await (fixture.server_xvm as any)._get_app({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
        },
      });
      assert.equal(app._result._app._meta._entry_view_id, "details");
      assert.equal(app._result._app._config._start._view_id, "details");
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }
}

function xapp_manifest_for_test(files: Array<{ _path: string; _bytes: Buffer; _kind: any }>): {
  _manifest: XAppManifest;
  _files: Array<{ _path: string; _bytes: Buffer }>;
} {
  const manifest: XAppManifest = {
    _format: "xpell-app",
    _format_version: "1.0",
    _app: {
      _app_id: "pkg-app",
      _name: "Package App",
      _version: "1.0.0",
    },
    _content: {
      _files: files.map((file) => ({
        _path: file._path,
        _kind: file._kind,
        _size: file._bytes.length,
        _sha256: sha256_buffer(file._bytes),
      })),
    },
    _build: {
      _created_at: "1970-01-01T00:00:00.000Z",
      _source_app_id: "pkg-app",
      _source_env: "default",
    },
  };
  const finalized = finalize_xapp_manifest(manifest);
  return {
    _manifest: finalized._manifest,
    _files: [
      ...files,
      { _path: "manifest.json", _bytes: finalized._bytes },
    ],
  };
}

async function run_xapp_package_v1_tests() {
  const original_execute = (_x as any).execute;
  const register_calls: any[] = [];
  const unregister_calls: any[] = [];
  (_x as any).execute = async (cmd: any) => {
    if (cmd?._module === "entity-manager" && cmd?._op === "register") {
      register_calls.push(cmd);
      return { _ok: true };
    }
    if (cmd?._module === "entity-manager" && cmd?._op === "unregister") {
      unregister_calls.push(cmd);
      return { _ok: true };
    }
    return typeof original_execute === "function"
      ? original_execute.call(_x, cmd)
      : { _ok: true };
  };

  const server_a_work = await mkdtemp(path.join(tmpdir(), "xapp-server-a-"));
  const server_b_work = await mkdtemp(path.join(tmpdir(), "xapp-server-b-"));
  const server_upload_work = await mkdtemp(path.join(tmpdir(), "xapp-server-upload-"));
  const server_env_work = await mkdtemp(path.join(tmpdir(), "xapp-server-env-"));
  const server_c_work = await mkdtemp(path.join(tmpdir(), "xapp-server-c-"));
  const app_id = "pkg-app";
  const env = "default";

  try {
    const server_a: any = new NodePackage.ServerXVMModule({ _work_folder: server_a_work });
    await server_a._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "main",
        _name: "Package App",
      },
    });
    await server_a._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: "todo_item",
          _title: "Todo Item",
          _schema: {
            title: { _type: "String", _required: true },
          },
        },
      },
    });
    await server_a._set_flow({
      _params: {
        _app_id: app_id,
        _env: env,
        _flow: {
          _id: "save_todo",
          _steps: [
            {
              _id: "create",
              _command: {
                  _module: "entity-manager",
                  _op: "add",
                  _params: {
                  _app_id: app_id,
                  _env: env,
                  _entity: "todo_item",
                },
              },
            },
          ],
        },
      },
    });
    await server_a._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: {
          _id: "main",
          _type: "view",
          _children: [
            {
              _id: "logo",
              _type: "image",
              src: `/public/${app_id}/assets/logo.svg`,
            },
            {
              _id: "panel",
              _type: "panel",
              className: `/public/${app_id}/style/custom.css`,
              _flow_id: "save_todo",
              _entity: "todo_item",
            },
          ],
        },
      },
    });

    await mkdir(path.join(server_a_work, "public", app_id, "assets"), { recursive: true });
    await mkdir(path.join(server_a_work, "public", app_id, "style"), { recursive: true });
    await writeFile(path.join(server_a_work, "public", app_id, "assets", "logo.svg"), "<svg></svg>");
    await writeFile(path.join(server_a_work, "public", app_id, "style", "custom.css"), ".pkg{color:red}");
    await writeFile(path.join(server_a_work, "xvm", "apps", env, app_id, "project-memory.json"), "{}");
    await mkdir(path.join(server_a_work, "xvm", "apps", env, app_id, "old_views"), { recursive: true });
    await writeFile(path.join(server_a_work, "xvm", "apps", env, app_id, "old_views", "main.1.json"), "{}");
    await mkdir(path.join(server_a_work, "xdb", "entities"), { recursive: true });
    await writeFile(path.join(server_a_work, "xdb", "entities", "sentinel.txt"), "do-not-package");

    const package_path = path.join(server_a_work, "exports", "pkg-app.xapp");
    const export_result = await server_a._export_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _output_path: package_path,
      },
    });
    assert.equal(export_result._ok, true);
    assert.ok(export_result._result._sha256);
    assert.equal(export_result._result._filename, `${app_id}.xapp`);
    assert.equal(export_result._result._content_type, NodePackage.XAPP_CONTENT_TYPE);
    assert.equal(export_result._result._package_type, "xapp");
    assert.equal(export_result._result._size, (await stat(package_path)).size);
    assert.equal(typeof export_result._result._download?._url, "string");
    assert.equal(typeof export_result._result._download?._path, "string");
    assert.equal(export_result._result._download_url, export_result._result._download._url);
    assert.equal(export_result._result._download_path, export_result._result._download._path);
    assert.equal("_package_path" in export_result._result, false);
    assert.equal(JSON.stringify(export_result._result).includes(server_a_work), false);
    assert.equal(JSON.stringify(export_result._result).includes(package_path), false);
    assert.equal(export_result._result._manifest._format, "xpell-app");
    const exported_paths = export_result._result._manifest._content._files.map((file: any) => file._path);
    assert.ok(exported_paths.includes("app.json"));
    assert.ok(exported_paths.includes("views/main.json"));
    assert.ok(exported_paths.includes("flows/save_todo.json"));
    assert.ok(exported_paths.includes("entities/todo_item.json"));
    assert.ok(exported_paths.includes("assets/logo.svg"));
    assert.ok(exported_paths.includes("style/custom.css"));
    assert.equal(exported_paths.includes("project-memory.json"), false);
    assert.equal(exported_paths.some((item: string) => item.includes("old_views")), false);
    assert.equal(exported_paths.some((item: string) => item.startsWith("xdb/")), false);

    await with_xapp_transfer_server(server_a_work, async (base_url) => {
      const package_bytes = await readFile(package_path);
      const download_url = `${base_url}${export_result._result._download._url}`;
      const downloaded = await read_http_bytes(download_url);
      assert.equal(downloaded._status, 200);
      assert.equal(downloaded._headers["content-type"], NodePackage.XAPP_CONTENT_TYPE);
      assert.equal(downloaded._headers["content-length"], String(package_bytes.length));
      assert.equal(downloaded._headers["x-xapp-sha256"], export_result._result._sha256);
      assert.ok(String(downloaded._headers["content-disposition"] ?? "").includes(`filename="${app_id}.xapp"`));
      assert.equal(downloaded._bytes.subarray(0, 2).toString("latin1"), "PK");
      assert.deepEqual(downloaded._bytes, package_bytes);
      assert.equal(createHash("sha256").update(downloaded._bytes).digest("hex"), export_result._result._sha256);

      const dev_origin = "http://localhost:5173";
      const browser_downloaded = await read_http_bytes(download_url, {
        _headers: {
          origin: dev_origin,
          cookie: "xapp_session=ignored",
        },
      });
      assert.equal(browser_downloaded._status, 200);
      assert.equal(browser_downloaded._headers["access-control-allow-origin"], dev_origin);
      assert.equal(browser_downloaded._headers["access-control-allow-credentials"], "true");
      assert.ok(String(browser_downloaded._headers["access-control-expose-headers"] ?? "").includes("Content-Disposition"));
      assert.equal(browser_downloaded._headers["content-length"], String(package_bytes.length));
      assert.equal(browser_downloaded._headers["x-xapp-sha256"], export_result._result._sha256);
      assert.deepEqual(browser_downloaded._bytes, package_bytes);
      assert.equal(createHash("sha256").update(browser_downloaded._bytes).digest("hex"), export_result._result._sha256);
      assert.equal(browser_downloaded._bytes.subarray(0, 2).toString("latin1"), "PK");

      const preflight = await read_http_bytes(download_url, {
        _method: "OPTIONS",
        _headers: {
          origin: dev_origin,
          "access-control-request-method": "GET",
        },
      });
      assert.equal(preflight._status, 204);
      assert.equal(preflight._headers["access-control-allow-origin"], dev_origin);
      assert.equal(preflight._headers["access-control-allow-credentials"], "true");
      assert.ok(String(preflight._headers["access-control-allow-methods"] ?? "").includes("GET"));

      const blocked_origin = await read_http_bytes(download_url, {
        _headers: { origin: "https://blocked.example.test" },
      });
      assert.equal(blocked_origin._status, 200);
      assert.equal(blocked_origin._headers["access-control-allow-origin"], undefined);

      const arbitrary = await read_http_bytes(`${base_url}${NodePackage.XAPP_DOWNLOAD_ROUTE}/${encodeURIComponent("../package.json")}`, {
        _headers: { origin: dev_origin },
      });
      assert.equal(arbitrary._status, 404);
      assert.equal(arbitrary._headers["access-control-allow-origin"], dev_origin);
      assert.equal(read_json_response(arbitrary)._result._code, "E_XAPP_DOWNLOAD_NOT_FOUND");

      const missing = await read_http_bytes(`${base_url}${NodePackage.XAPP_DOWNLOAD_ROUTE}/missing-token-missing-token-missing-token12`, {
        _headers: { origin: dev_origin },
      });
      assert.equal(missing._status, 404);
      assert.equal(missing._headers["access-control-allow-origin"], dev_origin);
      assert.equal(read_json_response(missing)._result._code, "E_XAPP_DOWNLOAD_NOT_FOUND");

      const expired_transfer = register_xapp_download({
        _file_path: package_path,
        _filename: "expired.xapp",
        _content_type: NodePackage.XAPP_CONTENT_TYPE,
        _sha256: export_result._result._sha256,
        _ttl_ms: -1,
      });
      const expired = await read_http_bytes(`${base_url}${expired_transfer._url}`, {
        _headers: { origin: dev_origin },
      });
      assert.equal(expired._status, 410);
      assert.equal(expired._headers["access-control-allow-origin"], dev_origin);
      assert.equal(read_json_response(expired)._result._code, "E_XAPP_DOWNLOAD_EXPIRED");
    });

    await with_xapp_transfer_server(server_a_work, async (base_url) => {
      const package_bytes = await readFile(package_path);
      const custom_origin = "https://studio.example.test";
      const custom_transfer = register_xapp_download({
        _file_path: package_path,
        _filename: `${app_id}.xapp`,
        _content_type: NodePackage.XAPP_CONTENT_TYPE,
        _sha256: export_result._result._sha256,
      });
      const custom_downloaded = await read_http_bytes(`${base_url}${custom_transfer._url}`, {
        _headers: {
          origin: custom_origin,
          cookie: "xapp_session=ignored",
        },
      });
      assert.equal(custom_downloaded._status, 200);
      assert.equal(custom_downloaded._headers["access-control-allow-origin"], custom_origin);
      assert.equal(custom_downloaded._headers["access-control-allow-credentials"], "true");
      assert.equal(custom_downloaded._headers["content-length"], String(package_bytes.length));
      assert.deepEqual(custom_downloaded._bytes, package_bytes);
    }, { _cors_origins: ["http://localhost:5173", "https://studio.example.test"] });

    await with_xapp_transfer_server(server_a_work, async (base_url) => {
      const base = new URL(base_url);
      const modules = (_x as any)._modules ?? {};
      const previous_server_xvm = modules["server-xvm"];
      try {
        modules["server-xvm"] = server_a;
        const public_export = await _x.execute({
          _module: "server-xvm",
          _op: "export-app",
          _ctx: {
            _meta: {
              _protocol: base.protocol.replace(":", ""),
              _host: base.host,
            },
          },
          _params: {
            _app_id: app_id,
            _env: env,
          },
        } as any);

        assert.equal(public_export._ok, true);
        assert.equal(public_export._result._filename, `${app_id}.xapp`);
        assert.equal(public_export._result._download_url.startsWith(base_url), true);
        assert.equal(public_export._result._download._url, public_export._result._download_url);
        assert.equal(public_export._result._download._path.startsWith(`${NodePackage.XAPP_DOWNLOAD_ROUTE}/`), true);
        assert.equal(public_export._result._download_path, public_export._result._download._path);

        const transferred = await read_http_bytes(public_export._result._download_url);
        assert.equal(transferred._status, 200);
        assert.equal(transferred._headers["content-type"], NodePackage.XAPP_CONTENT_TYPE);
        assert.equal(transferred._headers["content-length"], String(public_export._result._size));
        assert.equal(transferred._headers["x-xapp-sha256"], public_export._result._sha256);
        assert.ok(String(transferred._headers["content-disposition"] ?? "").includes(`filename="${app_id}.xapp"`));
        assert.equal(transferred._bytes.subarray(0, 2).toString("latin1"), "PK");
        assert.equal(transferred._bytes.length, public_export._result._size);
        assert.equal(createHash("sha256").update(transferred._bytes).digest("hex"), public_export._result._sha256);

        const roundtrip_server: any = new NodePackage.ServerXVMModule({ _work_folder: server_upload_work });
        modules["server-xvm"] = roundtrip_server;
        const roundtrip_upload = await _x.execute({
          _module: "server-xvm",
          _op: "upload-app-package",
          _params: {
            _filename: public_export._result._filename,
            _bytes_base64: transferred._bytes.toString("base64"),
          },
        });
        assert.equal(roundtrip_upload._ok, true);
        assert.equal(roundtrip_upload._result._size, transferred._bytes.length);
        assert.equal(roundtrip_upload._result._sha256, public_export._result._sha256);

        const roundtrip_inspect = await _x.execute({
          _module: "server-xvm",
          _op: "inspect-app-package",
          _params: {
            _package_ref: roundtrip_upload._result._package_ref,
          },
        });
        assert.equal(roundtrip_inspect._ok, true);
        assert.equal(roundtrip_inspect._result._manifest._format, "xpell-app");
        assert.equal(roundtrip_inspect._result._manifest._app._app_id, app_id);
        assert.ok(roundtrip_inspect._result._manifest._content._files.some((file: any) => file._path === "manifest.json"));
      } finally {
        if (previous_server_xvm) {
          modules["server-xvm"] = previous_server_xvm;
        } else {
          delete modules["server-xvm"];
        }
      }
    });

    await with_xapp_transfer_server(server_upload_work, async (base_url) => {
      const package_bytes = await readFile(package_path);
      const upload_body = multipart_xapp_upload("../../unsafe/pipio.xapp", package_bytes);
      const upload_response = await post_http_bytes(
        `${base_url}${NodePackage.XAPP_UPLOAD_ROUTE}`,
        upload_body._body,
        { "content-type": upload_body._content_type },
      );
      assert.equal(upload_response._status, 200);
      const upload_result = read_json_response(upload_response)._result;
      assert.equal(typeof upload_result._package_ref, "string");
      assert.equal(upload_result._filename, "pipio.xapp");
      assert.equal(upload_result._size, package_bytes.length);
      assert.equal(upload_result._sha256, createHash("sha256").update(package_bytes).digest("hex"));
      assert.equal(JSON.stringify(upload_result).includes(server_upload_work), false);
      assert.equal(JSON.stringify(upload_result).includes(package_path), false);

      const upload_server: any = new NodePackage.ServerXVMModule({ _work_folder: server_upload_work });
      const upload_inspect = await upload_server._inspect_app_package({
        _params: { _package_ref: upload_result._package_ref },
      });
      assert.equal(upload_inspect._ok, true);
      assert.equal(upload_inspect._result._package_ref, upload_result._package_ref);
      assert.equal("_package_path" in upload_inspect._result, false);
      assert.equal(upload_inspect._result._sha256, upload_result._sha256);

      const upload_preview = await upload_server._preview_app_import({
        _params: {
          _package_ref: upload_result._package_ref,
          _target_app_id: app_id,
          _env: env,
        },
      });
      assert.equal(upload_preview._ok, true);
      assert.deepEqual(upload_preview._result._changes._views._added, ["main"]);
      assert.deepEqual(upload_preview._result._changes._flows._added, ["save_todo"]);
      assert.deepEqual(upload_preview._result._changes._entities._added, ["todo_item"]);

      const upload_import = await upload_server._import_app({
        _params: {
          _package_ref: upload_result._package_ref,
          _target_app_id: app_id,
          _env: env,
          _mode: "create",
        },
      });
      assert.equal(upload_import._ok, true);
      const upload_imported_app = await upload_server._get_app({
        _params: {
          _app_id: app_id,
          _env: env,
          _include_views: true,
          _include_flows: true,
        },
      });
      assert.equal(upload_imported_app._result._views.main._children[0].src, `/public/${app_id}/assets/logo.svg`);
      await assert.rejects(
        async () => upload_server._inspect_app_package({
          _params: { _package_ref: upload_result._package_ref },
        }),
        (err: any) => err?._code === "E_XAPP_PACKAGE_REF_NOT_FOUND",
      );

      await assert.rejects(
        async () => upload_server._inspect_app_package({
          _params: { _package_ref: package_path },
        }),
        (err: any) => err?._code === "E_XAPP_PACKAGE_REF_NOT_FOUND",
      );

      const missing_ref = `xapp-upload:${"a".repeat(43)}`;
      await assert.rejects(
        async () => upload_server._inspect_app_package({
          _params: { _package_ref: missing_ref },
        }),
        (err: any) => err?._code === "E_XAPP_PACKAGE_REF_NOT_FOUND",
      );

      const expired_upload = store_xapp_upload({
        _work_folder: server_upload_work,
        _filename: "expired.xapp",
        _bytes: package_bytes,
        _ttl_ms: -1,
      });
      await assert.rejects(
        async () => upload_server._inspect_app_package({
          _params: { _package_ref: expired_upload._package_ref },
        }),
        (err: any) => err?._code === "E_XAPP_PACKAGE_REF_EXPIRED",
      );
    });

    {
      const package_bytes = await readFile(package_path);
      const previous_server_xvm = ((_x as any)._modules ?? {})["server-xvm"];
      const dispatcher_server: any = new NodePackage.ServerXVMModule({ _work_folder: server_upload_work });
      try {
        delete ((_x as any)._modules ?? {})["server-xvm"];
        await (_x as any).loadModuleAsync(dispatcher_server);
        const dispatcher_upload = await _x.execute({
          _module: "server-xvm",
          _op: "upload-app-package",
          _params: {
            _filename: "../../unsafe/pipio.xapp",
            _bytes_base64: package_bytes.toString("base64"),
          },
        });

        assert.equal(dispatcher_upload._ok, true);
        assert.equal(typeof dispatcher_upload._result._package_ref, "string");
        assert.equal(dispatcher_upload._result._filename, "pipio.xapp");
        assert.equal(dispatcher_upload._result._size, package_bytes.length);
        assert.equal(dispatcher_upload._result._sha256, createHash("sha256").update(package_bytes).digest("hex"));
        assert.equal(JSON.stringify(dispatcher_upload._result).includes(server_upload_work), false);
        assert.equal(JSON.stringify(dispatcher_upload._result).includes(package_path), false);
      } finally {
        if (previous_server_xvm) {
          ((_x as any)._modules ?? {})["server-xvm"] = previous_server_xvm;
        } else {
          delete ((_x as any)._modules ?? {})["server-xvm"];
        }
      }
    }

    await with_xapp_transfer_server(server_upload_work, async (base_url) => {
      const oversized = await post_http_bytes(
        `${base_url}${NodePackage.XAPP_UPLOAD_ROUTE}`,
        Buffer.from("too-large"),
        { "content-type": "application/octet-stream", "x-xapp-filename": "../oversized.xapp" },
      );
      assert.equal(oversized._status, 413);
      assert.equal(read_json_response(oversized)._result._code, "E_XAPP_UPLOAD_TOO_LARGE");
    }, { _max_upload_bytes: 4 });

    await assert.rejects(
      async () => server_a._inspect_app_package({
        _params: {
          _package_path: package_path,
          _from: { _client: "ws" },
        },
      }),
      (err: any) => err?._code === "E_XAPP_PACKAGE_REF_REQUIRED",
    );

    const inspect_result = await server_a._inspect_app_package({
      _params: { _package_path: package_path },
    });
    assert.equal(inspect_result._ok, true);
    assert.equal(inspect_result._result._file_count, exported_paths.length);

    const server_b: any = new NodePackage.ServerXVMModule({ _work_folder: server_b_work });
    await mkdir(path.join(server_b_work, "xdb", "entities"), { recursive: true });
    await writeFile(path.join(server_b_work, "xdb", "entities", "record.json"), "{\"_id\":\"keep\"}");
    const preview = await server_b._preview_app_import({
      _params: {
        _package_path: package_path,
        _target_app_id: app_id,
        _env: env,
      },
    });
    assert.equal(preview._ok, true);
    assert.deepEqual(preview._result._changes._views._added, ["main"]);
    assert.deepEqual(preview._result._changes._flows._added, ["save_todo"]);
    assert.deepEqual(preview._result._changes._entities._added, ["todo_item"]);
    assert.deepEqual(preview._result._changes._public_files._added.sort(), ["assets/logo.svg", "style/custom.css"]);
    assert.equal(fs.existsSync(path.join(server_b_work, "xvm", "apps", env, app_id, "app.json")), false);

    const import_result = await server_b._import_app({
      _params: {
        _package_path: package_path,
        _target_app_id: app_id,
        _env: env,
        _mode: "create",
      },
    });
    assert.equal(import_result._ok, true);
    const imported_app = await server_b._get_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _include_views: true,
        _include_flows: true,
      },
    });
    assert.equal(imported_app._result._views.main._children[0].src, `/public/${app_id}/assets/logo.svg`);
    assert.equal(imported_app._result._views.main._children[1].className, `/public/${app_id}/style/custom.css`);
    assert.ok(imported_app._result._flows.save_todo);
    assert.ok(imported_app._result._entities.todo_item);
    assert.equal(fs.existsSync(path.join(server_b_work, "public", app_id, "assets", "logo.svg")), true);
    assert.equal(fs.existsSync(path.join(server_b_work, "public", app_id, "style", "custom.css")), true);
    assert.equal(fs.existsSync(path.join(server_b_work, "xdb", "entities", "record.json")), true);
    assert.ok(register_calls.some((cmd) => cmd._params?._app_id === app_id && cmd._params?._entity?._id === "todo_item"));

    const set_imported_default = await server_b._set_default_app({
      _params: {
        _app_id: app_id,
        _env: env,
      },
    });
    assert.equal(set_imported_default._ok, true);
    const imported_default = await server_b._get_default_app({
      _params: {
        _env: env,
      },
    });
    assert.equal(imported_default._result._app_id, app_id);

    const server_env: any = new NodePackage.ServerXVMModule({ _work_folder: server_env_work });
    const env_import = await server_env._import_app({
      _params: {
        _package_path: package_path,
        _target_app_id: app_id,
        _env: "test",
        _mode: "create",
      },
    });
    assert.equal(env_import._ok, true);
    const env_flow = await server_env._get_flow({
      _params: {
        _app_id: app_id,
        _env: "test",
        _flow_id: "save_todo",
      },
    });
    assert.equal(env_flow._result._flow._steps[0]._command._params._app_id, app_id);
    assert.equal(env_flow._result._flow._steps[0]._command._params._env, "test");
    assert.equal(
      JSON.parse(await readFile(path.join(server_env_work, "xvm", "apps", "test", app_id, "app.json"), "utf-8"))._env,
      "test",
    );

    await server_b._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: {
          _id: "temp",
          _type: "view",
          _children: [{ _id: "temp-label", _type: "text", text: "delete me" }],
        },
      },
    });
    await server_b._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: "archived_item",
          _title: "Archived Item",
          _schema: {
            title: { _type: "String" },
          },
        },
      },
    });

    const server_b_app_dir = path.join(server_b_work, "xvm", "apps", env, app_id);
    await mkdir(path.join(server_b_app_dir, "conversations", "conv-1", "attachments"), { recursive: true });
    await writeFile(path.join(server_b_app_dir, "conversations", "index.json"), "{\"_ids\":[\"conv-1\"]}");
    await writeFile(path.join(server_b_app_dir, "conversations", "conv-1", "conversation.json"), "{\"_id\":\"conv-1\"}");
    await writeFile(path.join(server_b_app_dir, "conversations", "conv-1", "messages.jsonl"), "{\"_id\":\"m1\",\"_text\":\"keep\"}\n");
    await writeFile(path.join(server_b_app_dir, "conversations", "conv-1", "attachments", "note.txt"), "attachment sentinel");
    await writeFile(path.join(server_b_app_dir, "project-memory.json"), "{\"_current_focus\":\"keep-memory\"}");
    await mkdir(path.join(server_b_app_dir, "old_views"), { recursive: true });
    await writeFile(path.join(server_b_app_dir, "old_views", "main.1.json"), "{\"_id\":\"old-main\"}");
    await mkdir(path.join(server_b_app_dir, "vibe-runs", "run-1"), { recursive: true });
    await writeFile(path.join(server_b_app_dir, "vibe-runs", "run-1", "summary.json"), "{\"_status\":\"keep-run\"}");

    const excluded_state_before = {
      _conversations: hash_tree_sync(path.join(server_b_app_dir, "conversations")),
      _project_memory: hash_file_sync(path.join(server_b_app_dir, "project-memory.json")),
      _old_views: hash_tree_sync(path.join(server_b_app_dir, "old_views")),
      _vibe_runs: hash_tree_sync(path.join(server_b_app_dir, "vibe-runs")),
      _xdb: hash_tree_sync(path.join(server_b_work, "xdb")),
    };

    const replacement_files = xapp_manifest_for_test([
      {
        _path: "app.json",
        _kind: "app",
        _bytes: stable_json_buffer({
          _app_id: app_id,
          _env: "ignored-source-env",
          _meta: {
            _version: 2,
            _entry_view_id: "main",
          },
          _config: {},
        }),
      },
      {
        _path: "views/main.json",
        _kind: "view",
        _bytes: stable_json_buffer({
          _id: "main",
          _type: "view",
          _children: [
            {
              _id: "replacement-title",
              _type: "text",
              _text: "replacement view",
            },
          ],
        }),
      },
      {
        _path: "flows/inspect_main.json",
        _kind: "flow",
        _bytes: stable_json_buffer({
          _id: "inspect_main",
          _steps: [
            {
              _id: "read-main",
              _command: {
                _module: "server-xvm",
                _op: "get_view",
                _params: {
                  _view_id: "main",
                },
              },
              _output: {
                _to: { _type: "xdata", _key: "replacement.title" },
                _value: "$step.read-main._result._view._children.0._text",
              },
            },
          ],
        }),
      },
      {
        _path: "entities/todo_item.json",
        _kind: "entity",
        _bytes: stable_json_buffer({
          _id: "todo_item",
          _title: "Todo Item Replacement",
          _schema: {
            title: { _type: "String", _required: true },
            priority: { _type: "String" },
          },
        }),
      },
      {
        _path: "assets/logo.svg",
        _kind: "asset",
        _bytes: Buffer.from("<svg>replacement</svg>"),
      },
    ]);
    const replacement_path = path.join(server_a_work, "exports", "pkg-app-replacement.xapp");
    await writeFile(replacement_path, create_xapp_zip(replacement_files._files));
    const replace_preview = await server_b._preview_app_import({
      _params: {
        _package_path: replacement_path,
        _target_app_id: app_id,
        _env: env,
      },
    });
    assert.equal(replace_preview._ok, true);
    assert.deepEqual(replace_preview._result._changes._views._deleted, ["temp"]);
    assert.deepEqual(replace_preview._result._changes._views._modified, ["main"]);
    assert.deepEqual(replace_preview._result._changes._flows._added, ["inspect_main"]);
    assert.deepEqual(replace_preview._result._changes._flows._deleted, ["save_todo"]);
    assert.deepEqual(replace_preview._result._changes._entities._deleted, ["archived_item"]);
    assert.deepEqual(replace_preview._result._changes._entities._modified, ["todo_item"]);
    assert.ok(
      replace_preview._result._warnings.some((warning: string) =>
        warning.includes("todo_item") && warning.includes("preserved")
      ),
    );
    assert.ok(
      replace_preview._result._warnings.some((warning: string) =>
        warning.includes("archived_item") && warning.includes("preserved")
      ),
    );
    const replace_result = await server_b._import_app({
      _params: {
        _package_path: replacement_path,
        _target_app_id: app_id,
        _env: env,
        _mode: "replace",
      },
    });
    assert.equal(replace_result._ok, true);
    assert.equal(replace_result._result._mode, "replace");
    const replaced_app = await server_b._get_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _include_views: true,
        _include_flows: true,
      },
    });
    assert.deepEqual(replaced_app._result._view_ids.sort(), ["main"]);
    assert.deepEqual(replaced_app._result._flow_ids, ["inspect_main"]);
    assert.deepEqual(replaced_app._result._entity_ids, ["todo_item"]);
    assert.equal(replaced_app._result._views.main._children[0]._text, "replacement view");
    assert.equal(replaced_app._result._entities.todo_item._title, "Todo Item Replacement");
    assert.equal(fs.existsSync(path.join(server_b_app_dir, "views", "temp.json")), false);
    assert.equal(fs.existsSync(path.join(server_b_app_dir, "entities", "archived_item.json")), false);
    assert.equal(fs.existsSync(path.join(server_b_app_dir, "flows", "save_todo.json")), false);
    assert.equal(fs.existsSync(path.join(server_b_work, "public", app_id, "assets", "logo.svg")), true);
    assert.equal(await readFile(path.join(server_b_work, "public", app_id, "assets", "logo.svg"), "utf-8"), "<svg>replacement</svg>");
    assert.equal(fs.existsSync(path.join(server_b_work, "public", app_id, "style", "custom.css")), false);
    assert.deepEqual(hash_tree_sync(path.join(server_b_app_dir, "conversations")), excluded_state_before._conversations);
    assert.equal(hash_file_sync(path.join(server_b_app_dir, "project-memory.json")), excluded_state_before._project_memory);
    assert.deepEqual(hash_tree_sync(path.join(server_b_app_dir, "old_views")), excluded_state_before._old_views);
    assert.deepEqual(hash_tree_sync(path.join(server_b_app_dir, "vibe-runs")), excluded_state_before._vibe_runs);
    assert.deepEqual(hash_tree_sync(path.join(server_b_work, "xdb")), excluded_state_before._xdb);
    assert.ok(unregister_calls.some((cmd) => cmd._params?._entity_id === "archived_item"));
    const default_after_replace = await server_b._get_default_app({
      _params: {
        _env: env,
      },
    });
    assert.equal(default_after_replace._result._app_id, app_id);

    const other_import = await server_b._import_app({
      _params: {
        _package_path: package_path,
        _target_app_id: "pkg-app-other",
        _env: env,
        _mode: "create",
      },
    });
    assert.equal(other_import._ok, true);
    const default_after_other_import = await server_b._get_default_app({
      _params: {
        _env: env,
      },
    });
    assert.equal(default_after_other_import._result._app_id, app_id);

    const reload_result = await server_b._reload_app({
      _params: {
        _app_id: app_id,
        _env: env,
      },
    });
    assert.equal(reload_result._ok, true);

    const previous_flow_execute = (_x as any).execute;
    try {
      (_x as any).execute = async (cmd: any) => {
        if (cmd?._module === "server-xvm") {
          const normalized_op = String(cmd._op ?? "").replaceAll("-", "_");
          if (normalized_op === "get_flow") return server_b._get_flow(cmd);
          if (normalized_op === "get_view") return server_b._get_view(cmd);
        }
        return previous_flow_execute.call(_x, cmd);
      };
      const flow_manager = new FlowManagerModule();
      const flow_result = await flow_manager._run({
        _params: {
          _app_id: app_id,
          _env: env,
          _flow_id: "inspect_main",
        },
      } as any);
      assert.equal(flow_result._ok, true);
      assert.equal(flow_result._result._flow._outputs["replacement.title"], "replacement view");
    } finally {
      (_x as any).execute = previous_flow_execute;
    }

    const invalid_base_files = [
      {
        _path: "app.json",
        _kind: "app",
        _bytes: stable_json_buffer({
          _app_id: "pkg-app",
          _env: "default",
          _meta: { _version: 1, _entry_view_id: "main" },
          _config: {},
        }),
      },
      {
        _path: "views/main.json",
        _kind: "view",
        _bytes: stable_json_buffer({
          _id: "main",
          _type: "view",
          _children: [],
        }),
      },
    ];

    const invalid_version = xapp_manifest_for_test(invalid_base_files);
    invalid_version._manifest._format_version = "9.0" as any;
    invalid_version._files[invalid_version._files.length - 1] = {
      _path: "manifest.json",
      _bytes: stable_json_buffer(invalid_version._manifest),
    };
    const invalid_version_path = path.join(server_a_work, "exports", "invalid-version.xapp");
    await writeFile(invalid_version_path, create_xapp_zip(invalid_version._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: invalid_version_path } }))._ok, false);

    const missing_app = xapp_manifest_for_test(invalid_base_files.slice(1));
    const missing_app_path = path.join(server_a_work, "exports", "missing-app.xapp");
    await writeFile(missing_app_path, create_xapp_zip(missing_app._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: missing_app_path } }))._ok, false);

    const wrong_hash = xapp_manifest_for_test(invalid_base_files);
    const app_entry = wrong_hash._manifest._content._files.find((file) => file._path === "app.json");
    assert.ok(app_entry);
    app_entry!._sha256 = "f".repeat(64);
    wrong_hash._files[wrong_hash._files.length - 1] = {
      _path: "manifest.json",
      _bytes: stable_json_buffer(wrong_hash._manifest),
    };
    const wrong_hash_path = path.join(server_a_work, "exports", "wrong-hash.xapp");
    await writeFile(wrong_hash_path, create_xapp_zip(wrong_hash._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: wrong_hash_path } }))._ok, false);

    const unexpected_entry = xapp_manifest_for_test(invalid_base_files);
    unexpected_entry._files.push({ _path: "generated/module.js", _bytes: Buffer.from("export {}") });
    const unexpected_path = path.join(server_a_work, "exports", "unexpected.xapp");
    await writeFile(unexpected_path, create_xapp_zip(unexpected_entry._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: unexpected_path } }))._ok, false);

    const traversal_entry = xapp_manifest_for_test(invalid_base_files);
    traversal_entry._files.push({ _path: "../evil.txt", _bytes: Buffer.from("evil") });
    const traversal_path = path.join(server_a_work, "exports", "traversal.xapp");
    await writeFile(traversal_path, create_xapp_zip(traversal_entry._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: traversal_path } }))._ok, false);

    const duplicate_entry = xapp_manifest_for_test(invalid_base_files);
    duplicate_entry._files.push({ _path: "app.json", _bytes: invalid_base_files[0]._bytes });
    const duplicate_path = path.join(server_a_work, "exports", "duplicate.xapp");
    await writeFile(duplicate_path, create_xapp_zip(duplicate_entry._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: duplicate_path } }))._ok, false);

    const oversized_file = Buffer.alloc(26 * 1024 * 1024, 1);
    const oversized = xapp_manifest_for_test([
      ...invalid_base_files,
      {
        _path: "assets/big.bin",
        _kind: "asset",
        _bytes: oversized_file,
      },
    ]);
    const oversized_path = path.join(server_a_work, "exports", "oversized.xapp");
    await writeFile(oversized_path, create_xapp_zip(oversized._files));
    assert.equal((await server_a._inspect_app_package({ _params: { _package_path: oversized_path } }))._ok, false);

    const server_c: any = new NodePackage.ServerXVMModule({ _work_folder: server_c_work });
    await server_c._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "main",
      },
    });
    await server_c._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: {
          _id: "main",
          _type: "view",
          _children: [{ _id: "previous", _type: "text", text: "previous" }],
        },
      },
    });
    await mkdir(path.join(server_c_work, "public", app_id, "assets"), { recursive: true });
    await writeFile(path.join(server_c_work, "public", app_id, "assets", "old.svg"), "<svg>old</svg>");
    const original_load = server_c._load_app_from_disk;
    server_c._load_app_from_disk = async () => {
      throw new Error("forced reload failure");
    };
    await assert.rejects(
      async () => server_c._import_app({
        _params: {
          _package_path: package_path,
          _target_app_id: app_id,
          _env: env,
          _mode: "replace",
        },
      }),
      (err: any) => err?._code === "E_XAPP_IMPORT_FAILED",
    );
    server_c._load_app_from_disk = original_load;
    const restored_app_json = JSON.parse(
      await readFile(path.join(server_c_work, "xvm", "apps", env, app_id, "views", "main.json"), "utf-8"),
    );
    assert.equal(restored_app_json._children[0]._id, "previous");
    assert.equal(fs.existsSync(path.join(server_c_work, "public", app_id, "assets", "old.svg")), true);
  } finally {
    (_x as any).execute = original_execute;
    await rm(server_a_work, { recursive: true, force: true });
    await rm(server_b_work, { recursive: true, force: true });
    await rm(server_upload_work, { recursive: true, force: true });
    await rm(server_env_work, { recursive: true, force: true });
    await rm(server_c_work, { recursive: true, force: true });
  }
}

async function run_xai_multimodal_contract_tests() {
  const text_inputs: any[] = [];
  const xai_text: any = new NodePackage.XAIModule();
  xai_text.registerProvider("mock", {
    _provider_id: "mock",
    generate: async (input: any) => {
      text_inputs.push(input);
      return {
        text: "text ok",
      };
    },
  });

  const text_result = await xai_text._generate({
    _params: {
      _prompt: "hello",
      _idempotency_key: "xai-text-idem",
    },
  });
  assert.equal(text_result._ok, true);
  assert.equal(text_result._text, "text ok");
  assert.equal(text_inputs[0].prompt, "hello");
  assert.equal(text_inputs[0].metadata._idempotency_key, "xai-text-idem");
  assert.deepEqual(text_inputs[0].messages, [
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: "hello",
        },
      ],
    },
  ]);

  await assert.rejects(
    () => xai_text._generate({
      _params: {
        _prompt: "hello",
        _messages: {
          _role: "user",
        },
      },
    }),
    /E_XAI_MESSAGES_INVALID/
  );

  const image_inputs: any[] = [];
  const xai_image: any = new NodePackage.XAIModule();
  xai_image.registerProvider("mock", {
    _provider_id: "mock",
    generate: async (input: any) => {
      image_inputs.push(input);
      return {
        text: "image ok",
      };
    },
  });

  const image_result = await xai_image._generate({
    _params: {
      _messages: [
        {
          _role: "user",
          _content: [
            {
              _type: "text",
              _text: "read label",
            },
            {
              _type: "image",
              _mime_type: "image/jpeg",
              _data_base64: Buffer.from("image bytes").toString("base64"),
            },
          ],
        },
      ],
    },
  });
  assert.equal(image_result._ok, true);
  assert.equal(image_result._text, "image ok");
  assert.equal(image_inputs[0].prompt, "read label");
  assert.equal(image_inputs[0].messages[0]._content[1]._type, "image");

  const object_inputs: any[] = [];
  const xai_object: any = new NodePackage.XAIModule();
  xai_object.registerProvider("mock", {
    _provider_id: "mock",
    generate: async (input: any) => {
      object_inputs.push(input);
      return {
        text: JSON.stringify({ ok: true }),
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          reasoning_tokens: 2,
          cached_input_tokens: 5,
          usage_source: "mock-provider",
        },
      };
    },
  });

  const object_result = await xai_object._generate_object({
    _params: {
      _prompt: "return json",
      schema: {
        type: "object",
        properties: {
          ok: {
            type: "boolean",
          },
        },
      },
    },
  });
  assert.equal(object_result._ok, true);
  assert.deepEqual(object_result._object, { ok: true });
  assert.deepEqual(object_result._usage, {
    input_tokens: 11,
    output_tokens: 3,
    total_tokens: 14,
    reasoning_tokens: 2,
    cached_input_tokens: 5,
    usage_source: "mock-provider",
  });
  assert.equal(object_inputs[0].response_format.type, "json_object");
  assert.equal(object_inputs[0].schema.properties.ok.type, "boolean");
  assert.equal(object_inputs[0].prompt.includes("Return only a JSON object that conforms to this schema."), true);
  assert.equal(object_inputs[0].messages[0]._content[0]._text.includes("\"ok\""), true);

  const recovery_inputs: any[] = [];
  const xai_recovery: any = new NodePackage.XAIModule();
  xai_recovery.registerProvider("mock", {
    _provider_id: "mock",
    generate: async () => ({ text: "unused" }),
    recoverGeneration: async (input: any) => {
      recovery_inputs.push(input);
      return {
        _state: "missing",
        _idempotency_key: input._idempotency_key,
      };
    },
  });

  const recovery_result = await xai_recovery._recover_generation({
    _params: {
      _provider: "mock",
      _idempotency_key: "xai-recover-idem",
    },
  });
  assert.equal(recovery_result._state, "missing");
  assert.equal(recovery_inputs.length, 1);
  assert.equal(recovery_inputs[0]._idempotency_key, "xai-recover-idem");
}

async function run_xai_tool_calling_contract_tests() {
  const tools = [
    {
      _name: "get_sales_summary",
      _description: "Return a sales summary for a date.",
      _input_schema: {
        type: "object",
        properties: {
          date: { type: "string" },
        },
        required: ["date"],
      },
    },
  ];
  const tool_calls = [
    {
      _id: "call-sales-1",
      _name: "get_sales_summary",
      _arguments: { date: "today" },
    },
    {
      _id: "call-sales-2",
      _name: "get_sales_summary",
      _arguments: { date: "yesterday" },
    },
  ];
  const provider_inputs: any[] = [];
  const xai: any = new NodePackage.XAIModule();
  xai.registerProvider("mock-tools", {
    _provider_id: "mock-tools",
    generate: async (input: any) => {
      provider_inputs.push(input);
      if (provider_inputs.length === 1) {
        return {
          text: "",
          tool_calls,
          finish_reason: "tool_calls",
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12,
          },
        };
      }

      return {
        text: "Today's sales total is 1,234.",
        finish_reason: "stop",
      };
    },
  });

  const first = await xai._generate({
    _params: {
      _provider: "mock-tools",
      _messages: [
        {
          _role: "user",
          _content: [
            {
              _type: "text",
              _text: "What's today's sales total?",
            },
          ],
        },
      ],
      _tools: tools,
      _tool_choice: { _name: "get_sales_summary" },
    },
  });

  assert.equal(first._text, "");
  assert.equal(first._finish_reason, "tool_calls");
  assert.deepEqual(first._tool_calls, tool_calls);
  assert.deepEqual(provider_inputs[0].tools, tools);
  assert.deepEqual(provider_inputs[0].tool_choice, {
    _name: "get_sales_summary",
  });
  assert.deepEqual(first._usage, {
    input_tokens: 8,
    output_tokens: 4,
    total_tokens: 12,
  });

  const follow_up_messages = [
    provider_inputs[0].messages[0],
    {
      _role: "assistant",
      _content: [],
      _tool_calls: first._tool_calls,
    },
    {
      _role: "tool",
      _tool_call_id: "call-sales-1",
      _content: [
        {
          _type: "text",
          _text: JSON.stringify({ total: 1234 }),
        },
      ],
    },
    {
      _role: "tool",
      _tool_call_id: "call-sales-2",
      _content: [
        {
          _type: "text",
          _text: JSON.stringify({ total: 980 }),
        },
      ],
    },
  ];

  const second = await xai._generate({
    _params: {
      _provider: "mock-tools",
      _messages: follow_up_messages,
      _tools: tools,
      _tool_choice: "auto",
    },
  });

  assert.equal(second._text, "Today's sales total is 1,234.");
  assert.equal(second._finish_reason, "stop");
  assert.equal(second._tool_calls, undefined);
  assert.deepEqual(provider_inputs[1].messages, follow_up_messages);
  assert.equal(
    provider_inputs[1].messages[2]._tool_call_id,
    provider_inputs[1].messages[1]._tool_calls[0]._id
  );

  await assert.rejects(
    () => xai._generate({
      _params: {
        _prompt: "invalid tool choice",
        _tools: tools,
        _tool_choice: { _name: "unknown_tool" },
      },
    }),
    /E_XAI_TOOL_CHOICE_NAME_UNKNOWN/
  );
}

async function run_xai_document_extraction_contract_tests() {
  const default_inputs: any[] = [];
  const selected_inputs: any[] = [];

  const extraction_result = (provider: string) => ({
    provider,
    model_or_processor: "neutral-document-model",
    text: "שלום\nHello",
    page_count: 2,
    pages: [
      {
        page_number: 1,
        text: "שלום",
        width: 600,
        height: 800,
        confidence: 0.98,
        language: "he",
      },
      {
        page_number: 2,
        text: "Hello",
        confidence: 0.91,
        language: "en",
      },
    ],
    spans: [
      {
        page_number: 1,
        text: "שלום",
        start_index: 0,
        end_index: 4,
        confidence: 0.97,
        bounding_polygon: {
          unit: "normalized",
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.1 },
            { x: 0.5, y: 0.2 },
            { x: 0.1, y: 0.2 },
          ],
        },
      },
    ],
    usage: {
      unit: "page",
      input_pages: 2,
      billable_pages: 2,
    },
    raw_provider_reference: {
      artifact_id: `${provider}-artifact`,
    },
  });

  const xai_document: any = new NodePackage.XAIModule();
  xai_document.registerProvider("default-doc", {
    _provider_id: "default-doc",
    generate: async () => ({ text: "default generate" }),
    extractDocument: async (input: any) => {
      default_inputs.push(input);
      return extraction_result("default-doc");
    },
  });
  xai_document.registerProvider("selected-doc", {
    _provider_id: "selected-doc",
    generate: async () => ({ text: "selected generate" }),
    extractDocument: async (input: any) => {
      selected_inputs.push(input);
      return extraction_result("selected-doc");
    },
  });

  const pdf_result = await xai_document._extract_document({
    _params: {
      document: {
        _mime_type: "application/pdf",
        _filename: "sample.pdf",
        _size_bytes: 8,
        _data_base64: Buffer.from("%PDF-1.7").toString("base64"),
      },
      options: {
        languages: ["he", "en"],
        pages: [1, 2],
        include_geometry: true,
        include_raw_provider_artifact: true,
      },
      metadata: {
        _app_id: "contract-app",
        _env: "test",
        _caller_module: "xai-test",
        _caller_op: "extract_document",
        _purpose: "contract",
      },
      project: "google-project-should-not-pass",
      location: "us",
      processor: "processor-should-not-pass",
      credentials: { private_key: "secret-should-not-pass" },
    },
  });

  assert.equal(pdf_result._ok, true);
  assert.equal(pdf_result._capability, NodePackage.XAI_DOCUMENT_EXTRACTION_CAPABILITY);
  assert.equal(pdf_result._provider, "default-doc");
  assert.equal(default_inputs.length, 1);
  assert.equal(default_inputs[0].document._mime_type, "application/pdf");
  assert.deepEqual(default_inputs[0].options.languages, ["he", "en"]);
  assert.deepEqual(default_inputs[0].options.pages, [1, 2]);
  assert.equal(default_inputs[0].options.include_geometry, true);
  assert.equal(default_inputs[0].metadata._app_id, "contract-app");
  assert.equal("project" in default_inputs[0], false);
  assert.equal("location" in default_inputs[0], false);
  assert.equal("processor" in default_inputs[0], false);
  assert.equal("credentials" in default_inputs[0], false);
  assert.equal(JSON.stringify(default_inputs[0]).includes("secret-should-not-pass"), false);
  assert.equal(pdf_result._result.text, "שלום\nHello");
  assert.equal(pdf_result._result.model_or_processor, "neutral-document-model");
  assert.equal(pdf_result._result.page_count, 2);
  assert.equal(pdf_result._result.pages[0].language, "he");
  assert.equal(pdf_result._result.pages[0].confidence, 0.98);
  assert.equal(pdf_result._result.spans[0].bounding_polygon.points[0].x, 0.1);
  assert.deepEqual(pdf_result._result.usage, {
    unit: "page",
    input_pages: 2,
    billable_pages: 2,
  });
  assert.equal(pdf_result._result.raw_provider_reference.artifact_id, "default-doc-artifact");

  for (const mime_type of ["image/png", "image/jpeg", "image/webp"]) {
    const image_result = await xai_document._extract_document({
      _params: {
        _provider: "selected-doc",
        document: {
          _mime_type: mime_type,
          _data_base64: Buffer.from(`${mime_type} bytes`).toString("base64"),
        },
      },
    });
    assert.equal(image_result._ok, true);
    assert.equal(image_result._provider, "selected-doc");
  }
  assert.equal(selected_inputs.length, 3);
  assert.equal(selected_inputs[0]._provider, "selected-doc");
  assert.equal(selected_inputs[0].document._mime_type, "image/png");

  const file_ref_result = await xai_document._extract_document({
    _params: {
      _provider: "selected-doc",
      file_ref: {
        _type: "xpell-file-ref",
        _version: 1,
        _id: "file-ref-1",
        _scope: "temp",
        _app_id: "contract-app",
        _env: "test",
        _filename: "invoice.pdf",
        _mime_type: "application/pdf",
        _size_bytes: 1024,
        _sha256: "abc123",
      },
    },
  });
  assert.equal(file_ref_result._ok, true);
  assert.equal(selected_inputs[3].file_ref._id, "file-ref-1");

  const xai_unsupported: any = new NodePackage.XAIModule();
  let generate_called = false;
  xai_unsupported.registerProvider("text-only", {
    _provider_id: "text-only",
    generate: async () => {
      generate_called = true;
      return { text: "should not be called" };
    },
  });

  const unsupported = await xai_unsupported._extract_document({
    _params: {
      document: {
        _mime_type: "application/pdf",
        _data_base64: Buffer.from("%PDF-1.7").toString("base64"),
      },
    },
  });
  assert.equal(unsupported._ok, false);
  assert.equal(unsupported._code, "XAI_UNSUPPORTED_CAPABILITY");
  assert.equal(unsupported._capability, NodePackage.XAI_DOCUMENT_EXTRACTION_CAPABILITY);
  assert.equal(unsupported._provider, "text-only");
  assert.equal(generate_called, false);

  await assert.rejects(
    async () => {
      await xai_document._extract_document({
        _params: {
          _provider: "selected-doc",
          _path: "/tmp/local.pdf",
          document: {
            _mime_type: "application/pdf",
            _data_base64: Buffer.from("%PDF-1.7").toString("base64"),
          },
        },
      });
    },
    (err: any) => err?.message === "E_XAI_DOCUMENT_FILESYSTEM_PATH_UNSUPPORTED",
  );
}

await run_node_core_compatibility_tests();
await run_xai_multimodal_contract_tests();
await run_xai_tool_calling_contract_tests();
await run_xai_document_extraction_contract_tests();
await run_operations_starter_image_contract_tests();
await run_xnode_generic_composition_tests();
await run_xauth_session_contract_tests();
await run_xauth_mcp_token_contract_tests();
await run_xnode_planning_contract_tests();
await run_studio_runtime_skill_sync_contract_tests();
await run_wormholes_runtime_studio_skill_sync_authorization_tests();
await run_server_xvm_composed_semantic_runtime_acceptance_tests();
await run_tracker_delete_flow_regression_tests();
await run_entity_manager_scoped_runtime_entity_tests();
await run_server_xvm_semantic_runtime_composition_tests();
await run_server_xvm_semantic_validation_tests();
await run_server_xvm_dynamic_reference_validation_tests();
await run_server_xvm_default_app_contract_tests();
await run_xweb_raw_json_body_tests();
await run_xweb_bootstrap_routing_tests();
await run_server_xvm_app_trash_restore_tests();
await run_server_xvm_change_plan_operation_tests();
await run_xapp_package_v1_tests();
await run_entity_provider_conformance_tests();

console.log("@xpell/node generic tests passed");
