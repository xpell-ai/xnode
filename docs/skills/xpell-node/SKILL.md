---
name: Xpell Node (xnode) Contract
id: xpell-node
version: 2.0.0
updated: 2026-05-01
description: Deterministic server runtime for Xpell 2. Provides module system integration, Wormholes v2 transport gateways, XDB persistence, ServerXVM apps/flows, XAI provider wiring, flow execution, and XSettings file-backed configuration.
requires:
  - xpell-contract
  - xpell-core
---

## 1) Applies to / Scope
- Applies to `@xpell/node` runtime code under `src/`.
- Applies to bootstrap (`XNode`, `XWebServer`), Wormholes transport, XDB persistence, and XSettings.
- Applies to ServerXVM persisted apps/views/flows, XAI provider wiring, and FlowManager execution.
- Applies to host applications that import public API from package entrypoint (`src/index.ts` -> `dist/index.js`).
- Keep this file as the compact contract. Load `SKILL_API_MAP.md` only for exact exports/API names, and `SKILL_CHECKLIST.md` only before merge/review.

## 2) Core identity (what xnode is and is not)
- xnode is a server runtime library built on `@xpell/core`.
- xnode provides ready-to-run HTTP/HTTPS bootstrap helpers (`XWebServer`, `XNode`).
- xnode also exposes transport primitives (`createWormholesRestRouter`, `createWormholesWSServer`) for host-owned servers.
- xnode includes server-side app/view/flow persistence (`ServerXVMModule`), AI provider dispatch (`XAI`), and flow execution (`FlowManagerModule`, boot-loaded but not exported).
- xnode is not a UI runtime and does not expose DOM/browser APIs.
- xnode does not persist through XData; persistence is explicit in file/SQLite stores.

### Transport ownership policy (default vs exception)
- Default: use xnode canonical bootstrap (`XNode` / `XWebServer`) when available.
- Exception: host-owned HTTP transport is allowed only when integrating into an existing server stack; this exception must be explicitly justified in project docs/PR.
- Exception path MUST mount Wormholes v2 through xnode gateways (`createWormholesRestRouter` and `createWormholesWSServer`); do not hand-roll `/wh/v2` envelope handlers.
- Non-negotiables for both default and exception paths:
  - envelope validation is mandatory (`parseEnvelope`/`assertEnvelope` via xnode gateways),
  - server context injection is mandatory (`_wid`, `_sid`, route hints),
  - request allowlist enforcement is mandatory by policy (unknown in generic form; enforce via `_authorize_req` or equivalent gateway policy),
  - external REQ execution must route only through `_x.execute`.
- Do not re-implement `GET /wh/v2/hello` and `POST /wh/v2/call` when xnode bootstrap already mounts Wormholes v2.

## 3) Public API overview
- Package manifest has no `exports` map. Public surface is the top-level entrypoint:
  - `main`: `./dist/index.js`
  - `module`: `./dist/index.js`
  - `types`: `./dist/index.d.ts`
- Top-level exports include:
  - `@xpell/core` re-exports (`_x`, `XModule`, `XCommand`, `_xlog`, `XResponse*`, etc.).
  - Node utilities/events: `XUtils`/`_xu`, `XEventManager`/`_xem`.
  - Settings export alias: `Settings` (aliased from internal `XSettings` singleton).
  - Server helpers: `XWebServer`, `XNode`, `ServerXVMModule`.
  - XAI helpers: `XAIModule`, `XAI`, `_xai`, `XAIRegistry`, and XAI provider types.
  - XDB API: `XDB`, `XDBStorageFS`, `XDBStorageSqlite`, `XDBEngine`, entity/file/vector/temp/cache types.
  - Wormholes API via `export * from "./Wormholes/wh.index.js"`.

## 4) XDB contract
- `XDB` is a singleton `XDBModule` (`_name: "xdb"`).
- Initialization is mandatory before module load:
  - Call `XDB.init({ storage, ... })`.
  - Then load module via `_x.loadModule(XDB)`.
  - `XDB.load()` throws if `init()` was not called with a storage adapter.
- Storage boundary is explicit:
  - `IXDBStorage` defines persistence contract (`open/close`, meta/entities/object store/vectors/files/temp).
  - `XDBStorageFS` implements filesystem layout.
  - `XDBStorageSqlite` stores meta/entity docs/objects in SQLite and delegates vectors/files/temp to blob storage (default `XDBStorageFS`).
- Filesystem default layout (`XDBStorageFS`):
  - `./data/xdb/entities/`
  - `./data/xdb/cache/`
  - `./data/xdb/backup/`
  - `./data/xdb/objects/`
  - Per entity: `_vectors/`, `_files/`, `_temp/`, `_meta.json`, `_schema.json`, `_data.json`, `_indices.json`, etc.
- `XDBEntity` hard-requires ready engine via `assertXdbReady()`.
- Persistence is command-driven and explicit:
  - Entities/files/vectors/temp stage changes and commit through engine.
  - Engine delegates to storage adapter methods.
- `XDB._init` command is intentionally unsupported without a storage registry.

## 5) Wormholes v2 contract
- Public Wormholes entrypoint is `src/Wormholes/wh.index.ts`.
- Envelope protocol is JSON-only with required fields: `_v`, `_id`, `_kind`.
- `parseEnvelope/assertEnvelope` enforces:
  - Protocol version (`WH_VERSION = 2`).
  - Kind membership (`HELLO`, `AUTH`, `REQ`, `RES`, `EVT`, `PING`, `PONG`).
  - `RES` requires valid `_rid`.
- Gateway execution flow:
  - `handleEnvelope(env, ctx, opts)` is transport-agnostic.
  - `REQ` payload must be `{ _module, _op, _params? }`.
  - Gateway injects server metadata into `_params`: `_wid`, `_sid`, `_from`, `_to`, sanitized `_auth`, and attaches `_ctx` to the command object.
  - Gateway routes REQ to `_x.execute(cmd)`.
  - Response is `RES` with `_rid` equal to request `_id`.
- REST transport:
  - `GET /wh/v2/hello`
  - `POST /wh/v2/auth` (expects `AUTH` envelope)
  - `POST /wh/v2/call` (expects `REQ` envelope)
- WS transport:
  - `createWormholesWSServer(server, opts)` defaults to path `/wh/v2`.
  - Sends `HELLO` on connection.
  - Parses inbound envelopes and delegates to `handleEnvelope`.
  - Maintains a connection registry and exposes scoped push helpers (`wsSetScope`, `wsSendToWid`, `wsBroadcastScoped`, `wsBroadcastAll`, etc.).

### Auth policy (production vs dev)
- Production policy: `_require_auth` MUST be `true` for REST and WS gateways.
- Current code fact: `XWebServer._installWormholesV2()` mounts gateways with `_require_auth: false`; treat this as a dev default, not production policy.
- Dev mode may set `_require_auth: false` only with an explicit dev/local config flag and loud warning logs.
- Session policy: after auth policy is enabled, `_sid` must be enforced for authenticated request flow.
- Never treat missing `_sid` as authenticated.
- Bootstrap override API for auth policy in `XNode.start(...)` is unknown from current public options; enforce production auth by explicit gateway mounting/config.

## 6) Transport trust boundary
- Transport input is untrusted and must pass `parseEnvelope/assertEnvelope`.
- Gateway auth policy:
  - `WHGatewayOptions._require_auth` defaults to `true` in gateway.
  - `XWebServer._installWormholesV2()` currently installs gateway with `_require_auth: false` (dev default).
  - Production deployments must override to `_require_auth: true`.
- Optional authorization hook (`_authorize_req`) runs before `_x.execute`.
- Modules do not receive raw transport objects (`req`, `res`, `WebSocket`); they receive command params/context fields.
- REQ/RES correlation is explicit via `_id` (request) and `_rid` (response).

## 7) XSettings contract
- Settings store is file-backed JSON managed by singleton `XSettings` (exported publicly as `Settings`).
- Location:
  - Setup/init root: `<work_folder>/settings/server-settings.json`.
- Behavior:
  - `onSetup(work_folder)` ensures settings folder, sets file path, saves current in-memory object, starts `fs.watch`.
  - `init(work_folder)` loads existing settings file and starts watch.
  - `set(key, value)` mutates in-memory object and persists file synchronously.
  - `get/has/getAll` expose current in-memory state.
  - Emits `update` on save/load; emits `error` on IO/parse failures.
  - `close()` closes watcher.

## 8) Module loading model
- `XNode.start(options)` is idempotent (`_started` guard).
- First boot path:
  - Creates work folders.
  - Calls `_xs.onSetup(work_folder)` and `XWebServer.onSetup(work_folder)`.
  - Writes `<work_folder>/.xpell-initialized`.
- Regular boot path:
  - Calls `_xs.init(work_folder)` and `XWebServer.init(work_folder)`.
- Runtime start flow:
  - `_x.start()`
  - apply optional web overrides/routes
  - `XWebServer.load()` + `XWebServer.start()`
  - load `PingModule`
  - load singleton `XAI`
  - load `ServerXVMModule` and call `init_on_boot()` when present
  - load `FlowManagerModule` (`_name: "flow"`)
- `XDB` is not auto-loaded by `XNode`; host must initialize and load it explicitly.

## 9) Persistence rules
- Persistence is explicit and adapter-driven, not XData-driven.
- Persistent stores in current code:
  - XSettings JSON file.
  - XDB FS/SQLite storage layers.
  - ServerXVM persisted apps/views/flows under `<work_folder>/xvm/apps/<env>/<app_id>/`.
- Writes are synchronous file writes in several components (`XSettings`, `XWebServer` setup copy, ServerXVM persistence, FS adapter writes).
- No hidden persistence mirror to `_xd` is implemented in xnode runtime code.

## 10) Hard forbiddens
- Do not bypass envelope validation for transport input.
- Do not call module operations directly from transport layers; route REQ through `handleEnvelope` -> `_x.execute`.
- Do not expose raw transport objects to modules as runtime dependency.
- Do not persist authoritative state in XData.
- Do not add UI/DOM/browser logic to xnode runtime modules.
- Do not introduce hidden background control loops in modules (`setInterval`/`setTimeout` polling patterns).
- Do not persist function values in ServerXVM app/view JSON.
- Do not persist function values in ServerXVM flow JSON.
- Do not allow unrestricted risky nano-ops (`open-url`, `navigate`) outside policy checks.
- FlowManager may use `_xd` for transient step input/output only; do not treat it as persistent state.

## 11) Error handling contract
- Wormholes protocol/gateway errors are represented with `XError`-based codes (`E_WH_*`).
- `handleEnvelope` normalizes thrown errors into `XResponseData` (`_ok: false`, `_result: XError.toXData()`).
- WS transport:
  - Envelope handling failures without correlation are surfaced as `EVT` named `wh.error` (best effort).
- REST transport:
  - `/auth` and `/call` return HTTP 400 with JSON error body on failures.
  - `/hello` returns HTTP 500 with JSON error body on failures.
- XDB APIs mix explicit `XResponseData` returns and explicit throws for contract violations (for example missing init/storage).
- XSettings emits `error` events instead of throwing to callers in watcher/load/save paths.

## 12) Logging rules
- Logging backend is `@xpell/core` logger (`_xlog`) re-exported by xnode.
- Runtime logs include:
  - server start/setup messages
  - Wormholes connect/disconnect/errors
  - XDB commit/load/storage errors
  - ServerXVM boot/persistence and push updates
  - FlowManager debug logs only when `_debug === true`
- No built-in redaction layer is present in xnode. Callers must avoid logging secrets/tokens.
- Optional verbose transport message logging exists (`WH/WS` message slices when `_log_messages: true`).

## 13) Minimal canonical bootstrap example
```ts
import {
  Settings, XWebServer, createWormholesRestRouter, createWormholesWSServer, whForbidden, whUnauthorized,
} from "@xpell/node";

const web = new XWebServer();
web.onSetup("./work");
Settings.set("xweb", { ...Settings.get("xweb"), "enable-wormhole": false }); // replace dev default installer

const ALLOW = new Set(["ping:ping"]);
const authorize = (cmd: any, ctx: any) => {
  // ctx is injected by gateway before _x.execute
  if (!ctx?._sid) throw whUnauthorized("Missing _sid");
  if (!ALLOW.has(`${cmd._module}:${cmd._op}`)) throw whForbidden("Op not allowlisted");
};

web.useRoutes((app) => app.use(createWormholesRestRouter({ _base_path: "/wh/v2", _require_auth: true, _authorize_req: authorize })));
web.load();
await web.start();
createWormholesWSServer(web._web_server!, { _path: "/wh/v2", _require_auth: true, _authorize_req: authorize });
```
