# @xpell/node-core Package Investigation

Date: 2026-07-16
Project: `@xpell/node`
Scope: analysis only; no production files moved or modified.

## 1. Executive Summary

`@xpell/node-core` should be a small infrastructure package, not a smaller copy of `@xpell/node`.

Recommended package contents:

- Node event manager adapter: current `src/XEM/XEventManager.ts`, renamed or exported as `XNodeEventManager` while preserving `XEventManager` compatibility.
- File-backed settings: current `src/XSettings/XSettings.ts`, after replacing package-local imports with `@xpell/node-core` internals and keeping the default `settings/server-settings.json` behavior configurable.
- Node utility subset: the Node-specific parts of `src/XNUtils/XUtils.ts`, not the whole inherited `_xu` surface.
- Small path, filesystem, JSON, and environment helpers that are currently duplicated or embedded in higher-level packages.

Everything that composes a running server should stay in `@xpell/node`: `XNode`, `XWebServer`, `Wormholes`, `ServerXVM`, `EntityManager`, `FlowManager` wiring, application lifecycle, auth policy, module loading, runtime bootstrap, and package-level public compatibility exports.

Overall complexity: medium.

The main blocker is not code volume. The blocker is dependency hygiene: `XNUtils` currently blends generic core helpers with Node filesystem helpers, and many higher-level modules import `_xu`, `_xem`, and `_xs` from package-local paths. Extraction should first create clean infrastructure imports, then preserve old `@xpell/node` exports as compatibility re-exports.

## 2. Candidate Modules

### `src/XEM/XEventManager.ts`

Responsibilities:

- Provides a Node adapter over `@xpell/core` `_XEventManager`.
- Keeps the core runtime bus canonical.
- Optionally bridges events to Node `EventEmitter`.
- Exports `_XEventManager`, `XEventManager`, `_xem`, and `XEventListenerOptions`.

Dependencies:

- `@xpell/core`: `_XEventManager`, `XEventListenerOptions`, `_xlog`.
- `node:events`: `EventEmitter`.

Current consumers:

- `src/XServer/XNode.ts`
- `src/XSettings/XSettings.ts`
- `src/XDB/XDB.ts`
- `src/XDB/XDBEntity.ts`
- `src/XEntityManager/XEntityManager.ts`
- `src/XFM/FlowManagerModule.ts`
- `src/XVM/ServerXVMModule.ts`
- `src/XVIBE/**`
- `src/index.ts`
- `src/test.ts`

Decision: move to `@xpell/node-core`.

Rationale: it is reusable Node infrastructure, depends only on `@xpell/core` and Node built-ins, and does not know about `XNode`, `ServerXVM`, `Wormholes`, `XDB`, `XVibe`, or `XAI`.

Recommended shape:

```ts
export class XNodeEventManager extends _XEventManagerBase {}
export const XEventManager = new XNodeEventManager();
export const _xem = XEventManager;
```

`@xpell/node` should temporarily re-export the same names from `@xpell/node-core`.

### `src/XSettings/XSettings.ts`

Responsibilities:

- Owns file-backed JSON settings.
- Creates `<work_folder>/settings/server-settings.json`.
- Loads and saves settings.
- Watches settings file changes.
- Emits `settings:update` and `settings:error`.
- Provides key and dotted-path helpers: `get`, `set`, `getPath`, `setPath`, `ensure`, `ensureDefaults`, `hasPath`, `getAll`, `close`.

Dependencies:

- Local XEM: `../XEM/XEventManager.js`
- Local XNUtils: `../XNUtils/XUtils.js`
- `@xpell/core`: `_xlog`
- Node built-ins: `fs`, `path`

Current consumers:

- `src/XServer/XNode.ts`: setup, init, default module settings, event listeners.
- `src/XServer/XWebServer.ts`: web defaults and runtime web settings.
- `src/XAI/XAI.ts`: provider defaults and API key storage.
- `src/XVM/ServerXVMModule.ts`: active app settings file load/save.
- `src/XEntityManager/MongoConnectionManager.ts`: Mongo connection settings.
- `src/index.ts` and `src/test.ts`.

Decision: move to `@xpell/node-core`.

Rationale: it is reusable Node configuration infrastructure. It does not depend on server composition or business modules. It does depend on XEM and filesystem helpers, which should be colocated in `@xpell/node-core`.

Required cleanup before extraction:

- Replace `_xu.checkFolders` with a local `ensureFolders` helper.
- Replace `_xu.get_path`, `_xu.set_path`, and `_xu.deepMergeDefaults` with direct imports from `@xpell/core` utilities or local wrapper functions.
- Allow the settings filename to be configured while keeping `server-settings.json` as the compatibility default.
- Keep event names unchanged: `settings:update`, `settings:error`.

### `src/XNUtils/XUtils.ts`

Responsibilities:

- Extends `@xpell/core` `_XUtils`.
- Adds Node-specific helpers:
  - `checkFolders`
  - `pathJoin`
  - `copyDirRecursive`
  - `encode`
  - `decode`
  - `normalizePrompt`
- Re-exports a singleton as `XUtils`, `_xu`, and default.

Dependencies:

- `@xpell/core`: `_XUtils`, `_xlog`.
- Node built-ins: `node:fs`, `node:path`, `node:buffer`.

Current consumers:

- Nearly every runtime domain imports `_xu`.
- Measured import edges include `XDB -> XNUtils (9)`, `XVIBE -> XNUtils (13)`, `XVM -> XNUtils (4)`, `XEntityManager -> XNUtils (3)`, `XServer -> XNUtils (2)`, `XAI -> XNUtils (1)`, `XCDN -> XNUtils (1)`, `Wormholes -> XNUtils (1)`.

Observed utility usage:

| Utility | Use count | Classification | Recommendation |
| --- | ---: | --- | --- |
| `is_plain_object` | 637 | inherited from `@xpell/core` | Do not move; import from `@xpell/core` utilities. |
| `normalize_id` | 47 | inherited from `@xpell/core` | Do not move. |
| `ensure_string` | 30 | inherited from `@xpell/core` | Do not move. |
| `ensure_params` | 29 | inherited from `@xpell/core` | Do not move. |
| `normalizePrompt` | 22 | local text normalization | Move only if `@xpell/xvibe` needs it; otherwise replace with local XVibe helper. |
| `guid` | 17 | inherited from `@xpell/core` | Do not move. |
| `to_iso_now` | 10 | inherited from `@xpell/core` | Do not move. |
| `normalize_prompt` | 6 | inherited from `@xpell/core` | Do not move. |
| `checkFolders` | 6 | Node filesystem | Move as `ensureFolders`. |
| `unique_strings` | 4 | inherited from `@xpell/core` | Do not move. |
| `copyDirRecursive` | 2 | Node filesystem | Move as `copyDirectoryRecursive`. |
| `encode` / `decode` | 1 each | Node Buffer text codec | Prefer local XDB helper unless other packages need the exact codec. |
| `pathJoin` | 1 | Node path helper | Replace with explicit `path.join` or `joinDirectoryPath`. |

Decision: split, do not move wholesale.

Recommended `@xpell/node-core` subset:

- `ensureFolders(paths: string[]): void`
- `copyDirectoryRecursive(src: string, dest: string): void`
- `joinDirectoryPath(...parts: string[]): string` only if trailing-separator behavior is intentionally required.
- `encodeTextBase64Uri(value: string): string` and `decodeTextBase64Uri(value: string): string` only if XDB keeps the current file content codec.
- `normalizePrompt(value: unknown): string` only if shared by `@xpell/xvibe`; otherwise keep it in XVibe.

Do not make `@xpell/node-core` the new home of the global `_xu` singleton. Future packages should import generic helpers from `@xpell/core` and Node helpers from `@xpell/node-core`. `@xpell/node` can keep `_xu` as a compatibility facade during migration.

### Filesystem, Path, JSON, and Environment Helpers

There are several repeated patterns across higher-level modules:

- Folder creation and recursive copy.
- Root-safe path resolution.
- JSON file read/write with missing-file fallback.
- Environment variable reads and boolean feature flags.

Examples:

- `src/XVIBE/Conversation/ConversationManager.ts`
- `src/XVIBE/Archive/RunArchiveManager.ts`
- `src/XVIBE/IntentMemory/IntentMemoryStore.ts`
- `src/XVIBE/VibeKnowledgeSelector.ts`
- `src/XVIBE/XVibeModule.ts`
- `src/XVM/ServerXVMModule.ts`
- `src/XEntityManager/MongoConnectionManager.ts`
- `src/XAuth/XAuthUtils.ts`
- `src/XServer/XWebServer.ts`
- `src/XDB/XDBEngine.ts`

Decision: add only generic helpers to `@xpell/node-core`, not policy-specific helpers.

Recommended helpers:

- `ensureDirectory`
- `ensureFolders`
- `readJsonFile`
- `writeJsonFileAtomic` if atomic write is desired.
- `safeResolveInsideRoot`
- `readEnv`
- `readBooleanEnv`
- `readNumberEnv`

Do not move auth secrets, Mongo connection resolution, server port policy, or XVibe feature flags into `node-core`.

### `src/XServer/XNode.ts`

Responsibilities:

- Server runtime composition and lifecycle.
- Work-folder setup.
- Core runtime event manager registration.
- Module loading.
- XDB bootstrap.
- XAI, XVM, FlowManager, EntityManager, Wormholes, Auth, XVibe, XStudio, XMutator, and generated-module wiring.

Dependencies:

- `@xpell/core`
- `XSettings`, `XNUtils`, `XEM`
- `XWebServer`
- `XDB`
- `XAI`
- `XVM`
- `XFM`
- `XEntityManager`
- `XAuth`
- `XVIBE`
- `XGenerative`
- `XMutator`
- `XStudio`
- local modules
- Node `fs`, `path`

Decision: stay in `@xpell/node`.

Rationale: this is the server composition root and runtime policy layer. Moving it to `node-core` would make `node-core` depend on the packages it is supposed to support.

### `src/XServer/XWebServer.ts`

Responsibilities:

- Express HTTP/HTTPS server.
- Public folder setup.
- Web settings defaults.
- Wormholes REST/WS installation.
- Static asset serving.

Dependencies:

- `express`, `cors`, `express-sslify`
- Node `http`, `https`, `fs`, `path`, `url`
- `@xpell/core`
- `XSettings`, `XNUtils`
- `Wormholes`

Decision: stay in `@xpell/node`.

Rationale: this is server hosting and transport composition, not reusable infrastructure for `@xpell/xdb`, `@xpell/xvibe`, or `@xpell/xai`.

### `src/Wormholes/**`

Responsibilities:

- Wormholes v2 protocol types, codec, gateway, REST router, WS server, WS client, sessions, and errors.
- Request dispatch into `_x.execute`.

Dependencies:

- `@xpell/core`
- `express`
- `ws`
- Node `http`
- Local `XNUtils` for `guid` in codec/client/server.

Decision: stay in `@xpell/node` for this extraction.

Rationale: `docs/AGENTS.md` states Wormholes is the client/server transport boundary. It is infrastructure in a broad sense, but it is transport/runtime infrastructure, not foundational Node-core infrastructure. If it is extracted later, it should be a dedicated protocol or transport package, not part of `@xpell/node-core`.

Cleanup opportunity:

- Replace local `XNUtils` imports with `@xpell/core` `guid` access where possible.

### `src/XEntityManager/**`

Responsibilities:

- Entity manager behavior.
- Entity provider implementations.
- Mongo and SQLite provider support.
- Wormholes and XDB integration.

Dependencies:

- `@xpell/core`
- `XDB`
- `XEM`
- `XNUtils`
- `XSettings`
- `Wormholes`
- `mongoose`, `better-sqlite3`
- Node `fs`, `path`, `crypto`

Decision: stay in `@xpell/node`.

Rationale: this is persistence/domain behavior, not generic Node infrastructure. The future architecture can later split providers, but `node-core` should not contain entity management.

`MongoConnectionManager` should not move. It can consume `XSettings` from `@xpell/node-core` after extraction.

### `src/XDB/**`

Responsibilities:

- XDB engine, object model, entity operations, indexing, storage adapters, cache, vectors, temp objects.

Dependencies:

- `@xpell/core`
- `XEM`
- `XNUtils`
- Node `fs`, `path`, `crypto`
- `better-sqlite3`

Decision: stay out of `@xpell/node-core`.

Rationale: XDB is a target future package (`@xpell/xdb`). It should depend on `@xpell/node-core` only for Node event/settings/utility infrastructure, not live inside it.

### `src/XAI/**`

Responsibilities:

- AI provider registry and generation module.
- Provider selection and provider API key settings.

Dependencies:

- `@xpell/core`
- `XSettings`
- `XNUtils`

Decision: stay out of `@xpell/node-core`.

Rationale: XAI is a target future package (`@xpell/xai`). It should consume `XSettings` from `@xpell/node-core` and generic utilities from `@xpell/core`.

### `src/XVIBE/**`

Responsibilities:

- XVibe workflows, processors, conversation state, structured editing, runtime context, archives, artifact execution, semantic intent, and project memory integration.

Dependencies:

- `@xpell/core`
- `XEM`
- `XNUtils`
- `Wormholes`
- `XVM`
- Node `fs`, `path`, `url`

Decision: stay out of `@xpell/node-core`.

Rationale: XVibe is a target future package (`@xpell/xvibe`). It contains business workflow logic and server behavior. Shared filesystem/path helpers can move to `@xpell/node-core`; XVibe itself should not.

### `src/XVM/**`

Responsibilities:

- Server XVM app/view/flow/entity persistence and project memory helpers.

Dependencies:

- `@xpell/core`
- `XSettings`
- `XEM`
- `XNUtils`
- `Wormholes`
- Node `fs`, `path`, `url`

Decision: stay in `@xpell/node`.

Rationale: Server XVM persists and validates app runtime artifacts. It is server runtime behavior, not foundational Node infrastructure.

### `src/XAuth/**`

Responsibilities:

- Auth module and auth utility functions.
- JWT and API key policy.
- Dev auth credentials.
- Super-user checks.

Dependencies:

- `@xpell/core`
- Node `crypto`
- environment variables.

Decision: stay in `@xpell/node` or later move to a dedicated auth package.

Rationale: auth policy is not generic node-core infrastructure.

### `src/XCDN/**`

Responsibilities:

- CDN client/server helpers and file upload behavior.

Dependencies:

- `@xpell/core`
- `XNUtils`
- `express`
- Node `fs`, `path`.

Decision: stay in `@xpell/node` or move later to a CDN package.

Rationale: CDN behavior is product/server functionality, not foundational infrastructure.

### `src/XGenerative/**`, `src/XMutator/**`, `src/XStudio/**`, `src/XFM/**`, `src/modules/**`

Decision: stay in `@xpell/node`.

Rationale:

- `XGenerative` and `XMutator` are generated-module and mutation behavior.
- `XStudio` is runtime/product module behavior.
- `XFM` is flow execution module behavior.
- `src/modules/PingModule.ts` is a server module.

These are not reusable Node infrastructure.

## 3. Dependency Map

Measured static import edges by top-level `src` folder:

```text
Wormholes -> @xpell/core (11)
Wormholes -> XNUtils (1)
Wormholes -> external (4)
Wormholes -> node:* (1)
XAI -> @xpell/core (1)
XAI -> XNUtils (1)
XAI -> XSettings (1)
XAuth -> @xpell/core (2)
XAuth -> node:* (1)
XCDN -> @xpell/core (2)
XCDN -> XNUtils (1)
XCDN -> external (1)
XCDN -> node:* (4)
XDB -> @xpell/core (12)
XDB -> XEM (2)
XDB -> XNUtils (9)
XDB -> external (5)
XDB -> node:* (6)
XEM -> @xpell/core (2)
XEM -> node:* (1)
XEntityManager -> @xpell/core (5)
XEntityManager -> Wormholes (1)
XEntityManager -> XDB (6)
XEntityManager -> XEM (1)
XEntityManager -> XNUtils (3)
XEntityManager -> XSettings (1)
XEntityManager -> external (6)
XEntityManager -> node:* (3)
XFM -> @xpell/core (1)
XFM -> XEM (1)
XFM -> XNUtils (1)
XGenerative -> @xpell/core (1)
XGenerative -> external (2)
XGenerative -> index.js (1)
XGenerative -> node:* (4)
XMutator -> @xpell/core (2)
XMutator -> index.js (1)
XNUtils -> @xpell/core (1)
XNUtils -> node:* (3)
XServer -> @xpell/core (3)
XServer -> Wormholes (1)
XServer -> XAI (1)
XServer -> XAuth (1)
XServer -> XDB (2)
XServer -> XEM (1)
XServer -> XEntityManager (2)
XServer -> XFM (1)
XServer -> XGenerative (1)
XServer -> XMutator (1)
XServer -> XNUtils (2)
XServer -> XSettings (2)
XServer -> XStudio (1)
XServer -> XVIBE (1)
XServer -> XVM (1)
XServer -> external (4)
XServer -> modules (1)
XServer -> node:* (7)
XSettings -> @xpell/core (1)
XSettings -> XEM (1)
XSettings -> XNUtils (1)
XSettings -> node:* (2)
XStudio -> @xpell/core (2)
XVIBE -> @xpell/core (39)
XVIBE -> Wormholes (2)
XVIBE -> XEM (2)
XVIBE -> XNUtils (13)
XVIBE -> XVM (4)
XVIBE -> node:* (13)
XVM -> @xpell/core (2)
XVM -> Wormholes (1)
XVM -> XEM (1)
XVM -> XNUtils (4)
XVM -> XSettings (1)
XVM -> node:* (3)
index.ts -> @xpell/core (12)
index.ts -> Wormholes (1)
index.ts -> XAI (1)
index.ts -> XAuth (1)
index.ts -> XDB (1)
index.ts -> XEM (1)
index.ts -> XMutator (1)
index.ts -> XNUtils (1)
index.ts -> XServer (2)
index.ts -> XSettings (1)
index.ts -> XVIBE (1)
index.ts -> XVM (4)
modules -> index.js (1)
```

Current infrastructure chain:

```text
@xpell/core
  -> XNUtils
  -> XEM

XNUtils + XEM + @xpell/core
  -> XSettings

XSettings + XNUtils + XEM
  -> XNode, XWebServer, XDB, XAI, EntityManager, ServerXVM, XVibe
```

Target dependency graph, with arrows pointing from importer to dependency:

```text
@xpell/node-core
  -> @xpell/core

@xpell/xdb
  -> @xpell/node-core
  -> @xpell/core

@xpell/xai
  -> @xpell/node-core
  -> @xpell/core

@xpell/xvibe
  -> @xpell/node-core
  -> @xpell/core

@xpell/node
  -> @xpell/node-core
  -> @xpell/core
  -> @xpell/xdb
  -> @xpell/xai
  -> @xpell/xvibe
  -> server composition, Wormholes, XNode, XWebServer, ServerXVM, EntityManager
```

Dependency matrix:

| Module | Core | XNode | ServerXVM | EntityManager | Wormholes | XDB | XVibe | XAI | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| XEM | Yes | No | No | No | No | No | No | No | Move |
| XSettings | Yes | No | No | No | No | No | No | No | Move |
| XNUtils full facade | Yes | No | No | No | No | No | No | No | Split |
| Node filesystem helpers | No | No | No | No | No | No | No | No | Move |
| Environment helpers | No | No | No | No | No | No | No | No | Move small subset |
| XNode | Yes | Owns | Yes | Yes | Yes | Yes | Yes | Yes | Stay |
| XWebServer | Yes | Used by | No | No | Yes | No | No | No | Stay |
| Wormholes | Yes | Used by | Used by | Used by | Owns | No | Used by | No | Stay |
| ServerXVM | Yes | Used by | Owns | Integrates | Yes | Indirect | Used by | No | Stay |
| EntityManager | Yes | Used by | No | Owns | Yes | Yes | No | No | Stay |
| XDB | Yes | Used by | Indirect | Used by | No | Owns | No | No | Future `@xpell/xdb` |
| XAI | Yes | Used by | No | No | No | No | No | Owns | Future `@xpell/xai` |
| XVibe | Yes | Used by | Uses XVM | No | Yes | Indirect | Owns | Indirect | Future `@xpell/xvibe` |

## 4. Proposed Package Contents

Recommended layout:

```text
@xpell/node-core
  package.json
  tsconfig.json
  src/
    index.ts
    XEM/
      XEventManager.ts
    XSettings/
      XSettings.ts
    NodeUtils/
      NodeUtils.ts
      fs.ts
      path.ts
      env.ts
      json.ts
```

Recommended public exports:

```ts
export {
  XNodeEventManager,
  XEventManager,
  XEventManager as _xem,
  type XEventListenerOptions,
} from "./XEM/XEventManager.js";

export {
  _XSettings,
  XSettings,
  XSettings as Settings,
  XSettings as _xs,
} from "./XSettings/XSettings.js";

export {
  ensureDirectory,
  ensureFolders,
  copyDirectoryRecursive,
  safeResolveInsideRoot,
  readJsonFile,
  writeJsonFile,
  readEnv,
  readBooleanEnv,
  readNumberEnv,
} from "./NodeUtils/index.js";
```

Recommended package dependencies:

```json
{
  "peerDependencies": {
    "@xpell/core": "^2.0.0"
  },
  "dependencies": {}
}
```

Node built-ins do not need package dependencies. `@xpell/node-core` should not depend on `express`, `ws`, `mongoose`, `better-sqlite3`, `bcryptjs`, or any `@xpell/node` package entrypoint.

## 5. Modules That Stay in `@xpell/node`

These modules should remain in `@xpell/node`:

- `src/XServer/XNode.ts`
- `src/XServer/XWebServer.ts`
- `src/Wormholes/**`
- `src/XVM/**`
- `src/XEntityManager/**`
- `src/XFM/**`
- `src/XAuth/**`
- `src/XDB/**` until extracted to `@xpell/xdb`
- `src/XAI/**` until extracted to `@xpell/xai`
- `src/XVIBE/**` until extracted to `@xpell/xvibe`
- `src/XCDN/**`
- `src/XGenerative/**`
- `src/XMutator/**`
- `src/XStudio/**`
- `src/modules/**`
- `src/index.ts` as the compatibility export surface.

Reasons:

- They implement server composition, transport, domain behavior, persistence domains, application lifecycle, or runtime policy.
- They either depend on several higher-level packages or are future target packages themselves.
- Moving them to `node-core` would invert the intended architecture.

## 6. Migration Phases

### Phase 0: Baseline and Compatibility Tests

Complexity: low.

Actions:

- Add tests that import current public names from `@xpell/node`: `_xem`, `XEventManager`, `_xs`, `XSettings`, `Settings`, `_xu`, `XUtils`.
- Add smoke tests for settings load/save/watch behavior.
- Add smoke tests for event manager core dispatch and optional Node `EventEmitter` bridge.

No production behavior should change in this phase.

### Phase 1: Create `@xpell/node-core` with XEM

Complexity: low to medium.

Actions:

- Create package skeleton.
- Move or copy `XEM/XEventManager.ts` into `@xpell/node-core`.
- Keep imports limited to `@xpell/core` and `node:events`.
- Update `@xpell/node` to re-export from `@xpell/node-core`.
- Keep `XNode` responsible for calling `setXEventManager(XEventManager)`.

Risk:

- Runtime event manager singleton identity must remain stable.

### Phase 2: Add NodeUtils Subset

Complexity: medium.

Actions:

- Add explicit Node helper functions.
- Do not move the whole `_xu` facade.
- Replace `XSettings` dependency on `_xu.checkFolders` with `ensureFolders`.
- Replace `XSettings` path/default merge helpers with direct core utility imports or local functions.

Risk:

- Existing modules rely on inherited `_xu` methods from `@xpell/core`. A mechanical import change from `_xu` to node-core would be wrong.

### Phase 3: Move XSettings

Complexity: medium.

Actions:

- Move `XSettings` to `@xpell/node-core`.
- Change its XEM import to node-core local XEM.
- Keep default file path behavior compatible:
  - work folder default: `.work`
  - settings folder: `settings`
  - settings file: `server-settings.json`
- Add optional constructor/setup parameters for settings file name if needed.
- Re-export from `@xpell/node`.

Risk:

- Watcher behavior and event ordering must remain unchanged.
- Settings writes can trigger asynchronous event handlers during server startup.

### Phase 4: Update Internal Imports in `@xpell/node`

Complexity: medium.

Actions:

- Change production imports from package-local infrastructure paths to `@xpell/node-core`:
  - `../XEM/XEventManager.js`
  - `../XSettings/XSettings.js`
  - selected Node utility imports.
- Keep old source files in `@xpell/node` as forwarding modules temporarily if deep imports are in use.
- Keep top-level `src/index.ts` compatibility exports.

Risk:

- TypeScript project references and package export maps must make ESM paths resolve consistently.

### Phase 5: Extract Target Packages

Complexity: high across all target packages, medium per infrastructure dependency.

Actions:

- Extract `@xpell/xdb` to depend on `@xpell/core` and `@xpell/node-core`.
- Extract `@xpell/xai` to depend on `@xpell/core` and `@xpell/node-core`.
- Extract `@xpell/xvibe` after removing dependencies on `@xpell/node`-only modules such as `Wormholes` and `ServerXVM`.

Risk:

- XVibe currently has direct dependencies on `XVM` and `Wormholes`; those are not node-core candidates and need separate interfaces or package boundaries.

### Phase 6: Deprecate Compatibility Paths

Complexity: low.

Actions:

- Keep compatibility re-exports for at least one minor release.
- Add deprecation notes for deep imports from `@xpell/node/dist/XEM`, `XSettings`, and `XNUtils`.
- Remove forwarding modules only after downstream packages migrate.

## 7. Risks

### Dependency Cycles

Current static cycle risk is low for the proposed infrastructure set:

- `XEM` depends only on `@xpell/core` and Node events.
- `XNUtils` depends only on `@xpell/core` and Node built-ins.
- `XSettings` depends on `XEM`, `XNUtils`, `@xpell/core`, and Node built-ins.

The main future cycle risk is accidental:

```text
@xpell/node-core -> @xpell/node -> @xpell/xdb -> @xpell/node-core
```

This must never happen. `@xpell/node-core` must not import:

- `XNode`
- `XWebServer`
- `Wormholes`
- `ServerXVM`
- `EntityManager`
- `XDB`
- `XVibe`
- `XAI`
- package-local `@xpell/node` entrypoints.

### Hidden Deep Imports

The package currently has no `exports` map in `package.json`, so consumers may be using deep paths into `dist`. Backward compatibility requires temporary forwarding modules or an export map that preserves known deep paths.

### Singleton Identity

`_xem` and `_xs` are singletons. If both `@xpell/node` and `@xpell/node-core` create separate instances, event and settings state will split. Compatibility exports must point to the same singleton objects.

### Initialization Order

`XNode` currently calls `setXEventManager(XEventManager)` and initializes settings during server setup. Moving XEM and XSettings does not remove that ordering requirement. `@xpell/node-core` should expose primitives; `@xpell/node` should remain responsible for installing them into the running server.

### XNUtils Facade Confusion

Most `_xu` calls are inherited core helpers, not Node helpers. Moving the full facade would make `node-core` appear to own core utility behavior. That would blur the dependency boundary and make future packages depend on Node for platform-neutral utilities.

### Settings Semantics

`XSettings` defaults are currently server-shaped (`server-settings.json`, `xweb`, module settings). The class can move, but server-specific defaults must stay in `@xpell/node` modules such as `XWebServer` and `XNode`.

### Package and Workspace Changes

Required build changes:

- Add a workspace package for `@xpell/node-core`.
- Add TypeScript project config.
- Add package build step before `@xpell/node`.
- Add `@xpell/node-core` as a dependency of `@xpell/node`.
- Add `@xpell/node-core` as a future dependency of `@xpell/xdb`, `@xpell/xai`, and `@xpell/xvibe`.
- Add package export map for stable public imports.

## 8. Complexity Estimates

| Extraction item | Complexity | Main risk | Likely files affected |
| --- | --- | --- | --- |
| XEM | Low-medium | singleton identity and `setXEventManager` ordering | `src/XEM/XEventManager.ts`, `src/XServer/XNode.ts`, `src/index.ts`, tests, package exports |
| NodeUtils subset | Medium | splitting inherited core helpers from Node helpers | `src/XNUtils/XUtils.ts`, XDB storage/cache, XSettings, XVibe copy helpers, XWebServer, XNode |
| XSettings | Medium | watcher/event behavior and default settings path | `src/XSettings/XSettings.ts`, `src/XServer/XNode.ts`, `src/XServer/XWebServer.ts`, `src/XAI/XAI.ts`, `src/XVM/ServerXVMModule.ts`, `src/XEntityManager/MongoConnectionManager.ts`, tests |
| Env helpers | Low | over-centralizing module-specific policy | `XAuth`, `MongoConnectionManager`, `XDBEngine`, `XWebServer`, `XVIBE/Processors/SemanticIntentProcessor.ts` |
| Path/JSON helpers | Medium-high | accidentally changing path safety or persistence semantics | XVibe conversation/archive/intent memory, ServerXVM, XDB FS storage |
| Compatibility re-exports | Low | deep import compatibility | `src/index.ts`, forwarding modules, package exports |
| Workspace/package setup | Medium | ESM path resolution and build order | root workspace config, package scripts, tsconfig references, release config |

Overall complexity: medium.

`@xpell/xvibe` extraction remains high complexity, but that is because of XVibe's dependencies on XVM/Wormholes/runtime composition, not because of `node-core`.

## 9. Final Recommendation

Create `@xpell/node-core`, but keep it intentionally narrow.

Recommended first extraction:

1. Extract `XEM` into `@xpell/node-core`.
2. Add a small `NodeUtils` subset.
3. Extract `XSettings`.
4. Re-export all old names from `@xpell/node`.
5. Only then update future packages (`@xpell/xdb`, `@xpell/xai`, `@xpell/xvibe`) to consume `@xpell/node-core`.

Do not include these in `@xpell/node-core`:

- `XNode`
- `XWebServer`
- `Wormholes`
- `ServerXVM`
- `EntityManager`
- `FlowManager`
- `XDB`
- `XAI`
- `XVibe`
- `XAuth`
- `XCDN`
- generated-module or studio behavior.

Clean architecture target, with arrows pointing from importer to dependency:

```text
@xpell/node-core
  -> @xpell/core
  contains:
    - XNodeEventManager
    - XSettings
    - Node filesystem/path/json/env helpers

@xpell/xdb
  -> @xpell/node-core
  -> @xpell/core

@xpell/xai
  -> @xpell/node-core
  -> @xpell/core

@xpell/xvibe
  -> @xpell/node-core
  -> @xpell/core

@xpell/node
  -> @xpell/node-core
  -> @xpell/core
  -> @xpell/xdb
  -> @xpell/xai
  -> @xpell/xvibe
  contains:
    - XNode
    - XWebServer
    - Wormholes
    - ServerXVM
    - EntityManager
    - lifecycle, bootstrap, runtime policy
```

The extraction is worthwhile because it gives future Node-side packages a stable foundation without forcing them to depend on the full server runtime. The package should stay boring: no transport, no lifecycle, no domain modules, and no hidden imports back into `@xpell/node`.

## Concise Terminal Summary

Recommended package contents:

- `XNodeEventManager` / compatibility `XEventManager` / `_xem`
- `XSettings` / `Settings` / `_xs`
- Small Node utility helpers: folders, recursive copy, safe path, JSON file read/write, env reads

Biggest blockers:

- `_xu` currently mixes inherited `@xpell/core` helpers with real Node helpers.
- `XSettings` imports package-local `XEM` and `XNUtils`.
- Existing consumers may rely on deep imports because `@xpell/node` has no package `exports` map.
- Singleton identity must not split between `@xpell/node` and `@xpell/node-core`.

Suggested first extraction:

- Extract `XEM` first, then `NodeUtils`, then `XSettings`.

Overall complexity:

- Medium for `@xpell/node-core`.
- High only when continuing into `@xpell/xvibe` because XVibe still touches XVM/Wormholes/runtime composition.
