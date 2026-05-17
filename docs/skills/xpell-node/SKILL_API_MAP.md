# @xpell/node API Map (Code-Derived)

## Package Entry Points
- Package name: `@xpell/node`
- Version: `2.0.0-alpha.34`
- Type: `module` (ESM)
- Entrypoints:
  - `main`: `./dist/index.js`
  - `module`: `./dist/index.js`
  - `types`: `./dist/index.d.ts`
- `exports` map: **not present** in `package.json`.

## Dependency Notes
- `peerDependencies`:
  - `@xpell/core: workspace:*`
- `dependencies` (runtime):
  - `bcryptjs`, `better-sqlite3`, `cors`, `express`, `express-sslify`, `mongoose`, `ws`

## Full Top-Level Export Surface (`src/index.ts`)

### Core Type Exports (from `@xpell/core`)
- `XValue`
- `IXData`
- `XObjectData`
- `XDataXporter`
- `XDataXporterHandler`
- `XObjectOnEventIndex`
- `XObjectOnEventHandler`
- `XEventListener`
- `XNanoCommandPack`
- `XNanoCommand`
- `XCommandData`
- `XModuleData`
- `XErrorOptions`
- `XErrorLevel`
- `XErrorMeta`
- `XResponseData`

### Core Runtime Exports (from `@xpell/core`)
- default export (`@xpell/core` default)
- `Xpell`, `_x`
- `XData`, `_xd`, `_XData`
- `XParser`
- `XCommand`
- `XLogger`, `_xlog`, `_XLogger`
- `XModule`
- `XObject`, `XObjectPack`
- `XObjectManager`
- `XParams`
- `XError`
- `XD_FRAME_NUMBER`, `XD_FPS`
- `XpellEngine`
- `XResponse`, `XResponseOK`, `XResponseError`

### Node/Server Utility Exports
- `XUtils`, `_xu` (from `src/XNUtils/XUtils.ts`)
- `XEventManager`, `_xem`, `_XEventManager`, `XEventListenerOptions` (from `src/XEM/XEventManager.ts`)
- `Settings` (alias of internal `XSettings` singleton, from `src/XSettings/XSettings.ts`)
- `XWebServer` (from `src/XServer/XWebServer.ts`)
- `XNode` (from `src/XServer/XNode.ts`)

### ServerXVM Exports
- `ServerXVMModule`
- `ServerXVMModuleDefault`
- Types:
  - `XVMEnv`
  - `XVMView`
  - `XVMFlow`
  - `XVMAppMeta`
  - `XVMAppFile`
  - `XVMAppBundle`

### XAI Exports
- Runtime:
  - `XAIModule`
  - `XAI`
  - `_xai`
  - `XAIRegistry`
- Types:
  - `XAIProvider`
  - `XAIInput`
  - `XAIResult`

### XDB Exports
- Runtime:
  - `XDB` (default singleton)
  - `XDBModule`
  - `XDBEngine`
  - `XDBEntity`
  - `XDBVector`
  - `XDBFile`
  - `XDBTemp`
  - `XDBCache`
  - `XDBStorageFS`
  - `XDBStorageSqlite`
  - `XpellEmbeddingProvider`
- Types:
  - `XDBModuleInitOptions`
  - `IXDBEmbeddingProvider`
  - `IXDBVectorQueryProvider`
  - `IXDBStorage`
  - `XDBData`
  - `XDBEntityPersisted`
  - `IXDBMaintenance`

### Wormholes Exports (`export * from "./Wormholes/wh.index.js"`)

#### Protocol/Envelope (`wh.types.ts`)
- constants:
  - `WH_VERSION`
- types:
  - `WHVersion`
  - `WHKind`
  - `WHPeer`
  - `WHRoute`
  - `XCmd`
  - `WHHelloPayload`
  - `WHAuthPayload`
  - `WHEventPayload`
  - `WHPingPayload`
  - `WHPongPayload`
  - `WHEnvelope`
  - `WHHello`
  - `WHAuth`
  - `WHReq`
  - `WHRes`
  - `WHEvt`
  - `WHPing`
  - `WHPong`
  - `WHAny`
  - `WHAuthState`
  - `WHConnMeta`
  - `WHContext`

#### Errors (`wh.errors.ts`)
- `WH_ERR`
- `WHErrorCode`
- `whBadEnvelope`
- `whUnsupportedVersion`
- `whUnknownKind`
- `whMissingRid`
- `whUnauthorized`
- `whForbidden`
- `whTimeout`
- `whInternal`

#### Gateway (`wh.gateway.ts`)
- `handleEnvelope`
- `WHGatewayOptions`

#### Session (`wh.session.ts`)
- `WHSession` (default export aliased as `WHSession`)

#### WebSocket Server (`wh.ws.server.ts`)
- `createWormholesWSServer`
- `wsSendEvt`
- `wsBroadcastScoped`
- `wsSetScope`
- `wsGetConn`
- `wsSendToWid`
- `wsGetConnections`
- `wsBroadcastAll`
- `WHWSServerOptions`
- `WHWSConn`

#### WebSocket Client (`wh.ws.client.ts`)
- `WHWSClient` (default export aliased as `WHWSClient`)
- `WHWSClientOptions`
- `WHWSEventHandler`

#### REST Router (`wh.rest.router.ts`)
- `createWormholesRestRouter`
- `WHRestRouterOptions`

## Subsystem Mapping (Source Files)
- Bootstrap/server:
  - `src/XServer/XNode.ts`
  - `src/XServer/XWebServer.ts`
- Settings:
  - `src/XSettings/XSettings.ts`
- Wormholes:
  - `src/Wormholes/wh.index.ts`
  - `src/Wormholes/wh.types.ts`
  - `src/Wormholes/wh.codec.ts`
  - `src/Wormholes/wh.gateway.ts`
  - `src/Wormholes/wh.errors.ts`
  - `src/Wormholes/wh.session.ts`
  - `src/Wormholes/wh.ws.server.ts`
  - `src/Wormholes/wh.ws.client.ts`
  - `src/Wormholes/wh.rest.router.ts`
- XDB core:
  - `src/XDB/XDB.ts`
  - `src/XDB/XDBEngine.ts`
  - `src/XDB/IXDBStorage.ts`
  - `src/XDB/xdbReady.ts`
- XDB object layers:
  - `src/XDB/XDBEntity.ts`
  - `src/XDB/XDBVector.ts`
  - `src/XDB/XDBFile.ts`
  - `src/XDB/XDBTemp.ts`
  - `src/XDB/XDBCache.ts`
  - `src/XDB/XDBObject.ts` (present but not exported from index)
- XDB adapters:
  - `src/XDB/XDBStorageFS.ts`
  - `src/XDB/XDBStorageSqlite.ts`
  - `src/XDB/IXDBMaintenance.ts`
  - `src/XDB/providers/index.ts`
  - `src/XDB/providers/XpellEmbeddingProvider.ts`
- XAI:
  - `src/XAI/XAI.ts`
  - `src/XAI/XAIProvider.ts`
  - `src/XAI/XAIRegistry.ts`
- Flow manager:
  - `src/XFM/FlowManagerModule.ts` (boot-loaded by `XNode`, not exported from `src/index.ts`)
- CDN client:
  - `src/XCDN/XCDNClient.ts` (present in source, not exported from `src/index.ts`)
  - `src/XCDN/cdn-server.ts` (present in source, not exported from `src/index.ts`)

## Gateway-Related Types (Operational Set)
- Envelope and command:
  - `WHEnvelope<T>`
  - `WHAny`
  - `XCmd`
- Execution context:
  - `WHContext`
  - `WHAuthState`
  - `WHConnMeta`
  - `WHRoute`
- Options:
  - `WHGatewayOptions`
  - `WHWSServerOptions`
  - `WHRestRouterOptions`
  - `WHWSClientOptions`
- WS registry/push helpers:
  - `WHWSConn`
  - `wsGetConn(wid)`
  - `wsGetConnections()`
  - `wsSetScope(wid, { _app_id?, _env? })`
  - `wsSendToWid(wid, payload)`
  - `wsBroadcastScoped(app_id, env, payload, opts?)`
  - `wsBroadcastAll(payload, opts?)`
- Correlation:
  - `WHReq` (`_id`)
  - `WHRes` (`_rid`)

## Storage Adapters and Contracts
- Core contract:
  - `IXDBStorage` (required adapter interface)
- Implementations:
  - `XDBStorageFS`
  - `XDBStorageSqlite`
- Optional extension contracts:
  - `IXDBMaintenance` (folder/zip utilities)
  - `IXDBBackup` (backup/restore, implemented by `XDBStorageSqlite`)

## XSettings API (Internal Class `_XSettings`, Public Alias `Settings`)
- Lifecycle:
  - `onSetup(workFolder = ".work")`
  - `init(workFolder = ".work")`
  - `load(jsonFilePath: string)`
  - `close()`
- Accessors/mutation:
  - `get(key: string)`
  - `set(key: string, value: any)`
  - `has(key: string): boolean`
  - `getAll()`
- Events (via inherited event manager):
  - `update` (on save/load)
  - `error` (on IO/parse failure)

## XNode Boot-Loaded Modules
- `PingModule` (`_name: "ping"`)
- Singleton `XAI` (`_name: "xai"`)
- `ServerXVMModule` (`_name: "server-xvm"`) with `init_on_boot()`
- `FlowManagerModule` (`_name: "flow"`)

## ServerXVM Commands
- `_create_app`: creates or returns an app bundle shell.
- `_get_app`: returns app metadata and ids; accepts `_include_views` / `_include_flows`.
- `_get_view`: returns one persisted view.
- `_push_update`: persists a view and broadcasts `xvm:update` to scoped WS clients.
- `_subscribe`: binds the current Wormholes `_wid` to an app/env scope through `_ctx`.
- `_set_flow`: persists a flow JSON file.
- `_get_flow`: returns one persisted flow.
- `_list_flows`: returns persisted flow ids.

## FlowManager Command
- `_run`: loads a ServerXVM flow, executes each step through `_x.execute`, resolves optional step input from transient `_xd`, and writes optional step output back to transient `_xd`.

## XAI Commands
- `_generate`: delegates to the selected/default registered provider.
- `_list_providers`: lists registered provider ids.
- `_set_default`: sets the default provider id.
