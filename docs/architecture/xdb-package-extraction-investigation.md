# XDB Package Extraction Investigation

Date: 2026-07-16

Scope: `src/XDB/**`, XDB imports and consumers in `@xpell/node`, package/build metadata, tests, docs, and workspace package dependencies.

This is analysis only. No files were moved.

## Executive Summary

Extracting XDB into `@xpell/xdb` is feasible, but it is not a pure file move. The current `src/XDB/**` tree mostly depends on `@xpell/core`, Node runtime APIs, and a small package-local utility wrapper. The hard coupling to `@xpell/node` internals is narrow but important:

- `src/XDB/XDB.ts` and `src/XDB/XDBEntity.ts` import `_xem` from `../XEM/XEventManager.js`.
- Most XDB files import `_xu` from `../XNUtils/XUtils.js`.
- `XNode` owns XDB bootstrap and storage selection.
- `XEntityManager` and its providers consume XDB internals directly.
- `src/index.ts` re-exports XDB as part of the `@xpell/node` public surface.

Recommended direction: create `@xpell/xdb` as a Node-capable package that depends on `@xpell/core`, `bcryptjs`, `better-sqlite3`, and optionally `mongoose`. Move the XDB runtime, storage adapters, `XDBObject`, and the minimal local utility helpers it needs. Keep XDB bootstrap ownership, EntityManager, ServerXVM, XNode lifecycle, settings, Wormholes, and work-folder policy in `@xpell/node`.

Complexity: medium.

Main reason: XDB itself is self-contained enough to extract, but consumers in `XNode`, EntityManager providers, tests, docs, and package exports require careful compatibility re-exports.

## Current XDB Contents

Current files under `src/XDB/**`:

| File | Role | Move to `@xpell/xdb`? |
| --- | --- | --- |
| `src/XDB/index.ts` | XDB public barrel | Yes |
| `src/XDB/XDB.ts` | `XDBModule` singleton and object registration | Yes, after replacing node-local `_xem` and `_xu` imports |
| `src/XDB/XDBEngine.ts` | Storage-agnostic engine, filtering, vector helpers | Yes |
| `src/XDB/XDBEntity.ts` | Entity object, schema, indexing, CRUD, hash/file/vector/temp helpers | Yes |
| `src/XDB/XDBVector.ts` | Per-entity vector helper object | Yes |
| `src/XDB/XDBFile.ts` | Per-entity file helper object | Yes |
| `src/XDB/XDBTemp.ts` | Per-entity temp helper object | Yes |
| `src/XDB/XDBCache.ts` | FS-backed cache | Yes |
| `src/XDB/XDBStorageFS.ts` | FS storage adapter | Yes |
| `src/XDB/XDBStorageSqlite.ts` | SQLite storage adapter | Yes |
| `src/XDB/XDBObject.ts` | Mongoose-backed object/model helper | Yes, recommended |
| `src/XDB/IXDBStorage.ts` | Storage contract | Yes |
| `src/XDB/IXDBMaintenance.ts` | Optional maintenance and backup contracts | Yes, but dedupe backup interface |
| `src/XDB/IXDBBackup.ts` | Duplicate backup contract | Yes, but consolidate with `IXDBMaintenance.ts` |
| `src/XDB/xdbReady.ts` | Singleton engine readiness accessor | Yes |
| `src/XDB/providers/index.ts` | Provider barrel | Yes |
| `src/XDB/providers/XpellEmbeddingProvider.ts` | Exec-function embedding adapter | Yes |

## Dependency Map

### Allowed `@xpell/core` Dependencies

These can remain direct imports in `@xpell/xdb`:

| XDB file | Core imports |
| --- | --- |
| `XDB.ts` | `XModule`, `XCommand`, `_xlog`, `XpellSkill` |
| `XDBEngine.ts` | `_xlog`, `XResponse` |
| `XDBEntity.ts` | `XObject`, `XObjectData`, `_xlog` |
| `XDBVector.ts` | `XObject`, `XObjectData`, `_xlog` |
| `XDBFile.ts` | `XObject`, `XObjectData`, `_xlog` |
| `XDBTemp.ts` | `XObject`, `XObjectData`, `_xlog` |
| `XDBCache.ts` | `_xlog` |
| `XDBStorageFS.ts` | `_xlog` |
| `XDBStorageSqlite.ts` | `_xlog` |
| `XDBObject.ts` | `XObject`, `XObjectData`, `_xlog`, `XResponse` |
| `xdbReady.ts` | `_xlog` |
| `providers/XpellEmbeddingProvider.ts` | `XResponse` type |

### `@xpell/node` Internal Dependencies From XDB

| Dependency | Current imports | Current use | Extraction action |
| --- | --- | --- | --- |
| Node-local event manager | `../XEM/XEventManager.js` in `XDB.ts` and `XDBEntity.ts` | Fires `xdb-ready` and `xentity-loaded` | Replace with `_xem` from `@xpell/core` if available in current core surface, or inject a small event bridge. Do not import `@xpell/node`. |
| Node utility wrapper | `../XNUtils/XUtils.js` in most XDB files | GUIDs, folder creation, path joining, base64 encode/decode | Replace with `@xpell/core` `_xu.guid()` plus local `@xpell/xdb` Node utilities for FS/base64/path helpers. |

No XDB file directly imports `XSettings`, `XNode`, `EntityManager`, `ServerXVM`, Wormholes, XAI, XVibe, FlowManager, or server lifecycle modules.

### Node Runtime and Third-Party Dependencies

| Dependency | Current files | Use | Package placement |
| --- | --- | --- | --- |
| `node:fs` / `fs` | `XDBStorageFS.ts`, `XDBStorageSqlite.ts`, `XDBCache.ts` | Files, folders, entity docs, cache, SQLite backup/restore | `@xpell/xdb` dependency on Node runtime |
| `node:path` / `path` | `XDBStorageFS.ts`, `XDBStorageSqlite.ts` | Path resolution | `@xpell/xdb` |
| `node:crypto` / `crypto` | `XDBCache.ts` | SHA-256 cache filenames | `@xpell/xdb` |
| `Buffer` | `IXDBStorage.ts`, `XDBEngine.ts`, storage adapters | Binary vectors/base64 | `@xpell/xdb` Node runtime |
| `process.env.ENV_NAME` | `XDBEngine.ts` | Default vector-query environment name | Prefer option-only fallback or document Node dependency |
| `bcryptjs` | `XDBEntity.ts`, `XDBObject.ts` | Hash fields | `@xpell/xdb` dependency |
| `better-sqlite3` | `XDBStorageSqlite.ts` | SQLite adapter | `@xpell/xdb` dependency, possibly optional/peer if package should install without native build |
| `mongoose` | `XDBObject.ts` | Mongo-backed model helper | Recommended optional peer dependency or separate subpath/export |

## XNUtils / "nxutils" Inspection

No literal `nxutils` source module exists. The relevant package-local utility is `src/XNUtils/XUtils.ts`, exported by `src/index.ts` as `XUtils` and `_xu`.

Exact XDB uses:

| Function | XDB callers | Purpose | Recommendation |
| --- | --- | --- | --- |
| `_xu.guid()` | `XDBEngine.ts`, `XDBEntity.ts`, `XDBVector.ts`, `XDBFile.ts`, `XDBTemp.ts`, `XDBStorageSqlite.ts` | Engine IDs, record IDs, vector/file/temp IDs | Use `_xu.guid()` from `@xpell/core` if exported; otherwise add a tiny local GUID helper in `@xpell/xdb`. Do not copy all `XNUtils`. |
| `_xu.checkFolders(...)` | `XDBStorageFS.ts`, `XDBCache.ts` | Ensure directories exist | Replace with local `ensure_folders()` using `fs.mkdirSync(..., { recursive: true })`. |
| `_xu.pathJoin(...)` | `XDB.ts` | Build cache folder with trailing separator | Replace with local `path_join_dir()` or use `path.join` and avoid requiring trailing slash in `XDBCache`. |
| `_xu.encode(...)` | `XDBStorageFS.ts` | Base64 encode JSON when security mode is base64 | Replace with local `encode_text()` using `Buffer`. |
| `_xu.decode(...)` | `XDBStorageFS.ts` | Base64 decode JSON when security mode is base64 | Replace with local `decode_text()` using `Buffer`. |

Do not copy `copyDirRecursive()` or `normalizePrompt()` into `@xpell/xdb`; XDB does not use them.

## Node-Specific Coupling Audit

### XSettings

XDB does not import or call `XSettings`.

`@xpell/node` owns settings through `XNode` and `XSettings`. If package extraction happens, XDB storage options should remain explicit data passed from `XNode` into `XDB.init(...)`, not read from settings inside `@xpell/xdb`.

### XNode and Server Lifecycle

`src/XServer/XNode.ts` is a major consumer and should stay in `@xpell/node`.

Current responsibilities:

- Imports `XDB`, `XDBStorageFS`, `XDBStorageSqlite`, and XDB types from `../XDB/index.js`.
- Defines `XNodeOptions._xdb?: XDBOptions`.
- Creates `<work_folder>/xdb` during setup.
- Resolves storage root from `_xdb._root` or `<work_folder>/xdb`.
- Instantiates FS or SQLite storage.
- Calls `XDB.init(...)`.
- Loads XDB through `await _x.loadModuleAsync(XDB)` before EntityManager.

Extraction change:

```ts
import {
  XDB,
  XDBStorageFS,
  XDBStorageSqlite,
  type IXDBStorage,
  type XDBOptions
} from "@xpell/xdb";
```

`XNode` should continue to own work-folder resolution and bootstrap order. `@xpell/xdb` should not import or know `XNode`.

### EntityManager

EntityManager should stay in `@xpell/node` because it is a server module/API layer with `XResponseOK` / `XResponseError`, app/env scoping, Wormholes fanout, and provider registry.

Current XDB consumers:

- `src/XEntityManager/XDBEntityProvider.ts`
  - imports `XDB` and `XDBEntity`.
  - creates `XDBEntity` through `XDB.create(...)`.
  - refreshes physical data through `XDB._engine.loadEntity(...)`.
  - exposes hash verification and migration/dispose behavior.
- `src/XEntityManager/XEntityManager.ts`
  - imports `XDB` and `XDBEntityPersisted`.
  - uses raw engine APIs for legacy physical entity migration, backup, resource copy, diagnostics, and deletion.
- `src/XEntityManager/SQLiteEntityProvider.ts`
  - imports `XDB`.
  - reads `(XDB as any)?._initOpts?.workFolder` to resolve its SQLite path. This is a coupling risk and should be replaced with explicit provider options from EntityManager/XNode.
- `src/XEntityManager/MongoEntityProvider.ts`
  - imports `XDBObject`.

Extraction change:

```ts
import { XDB, XDBEntity, type XDBEntityPersisted, XDBObject } from "@xpell/xdb";
```

Follow-up needed: remove `SQLiteEntityProvider` dependency on private `XDB._initOpts`.

### ServerXVM

ServerXVM does not import XDB directly in the current scan. It interacts with entity persistence through `entity-manager` module commands and should remain unchanged for extraction, except tests should confirm entity registration still works after EntityManager imports `@xpell/xdb`.

### Work-Folder and Path Resolution

Work-folder ownership currently belongs to `XNode`:

- Setup creates `<work_folder>/xdb`.
- `create_xdb_storage(...)` resolves `_xdb._root` or `<work_folder>/xdb`.
- XDB receives `workFolder` only for cache path creation.

Recommended boundary:

- `@xpell/node`: decides work folder and storage root.
- `@xpell/xdb`: accepts explicit `xdbFolder`, `dbPath`, `cacheFolder`, and storage instances.

### Logging and Bootstrap Helpers

XDB logging uses `_xlog` from `@xpell/core`, which is allowed. It does not import node-local logging/bootstrap helpers.

Bootstrap sequencing remains in `@xpell/node`; `@xpell/xdb` should export the module singleton and storage constructors only.

## Imports Elsewhere That Must Change

Current source imports or exports that reference `src/XDB/**`:

| File | Current reference | Target |
| --- | --- | --- |
| `src/index.ts` | `export * from "./XDB/index.js";` | Temporary re-export from `@xpell/xdb` |
| `src/XServer/XNode.ts` | imports `XDB`, storage classes, XDB types from `../XDB/index.js` | `@xpell/xdb` |
| `src/XEntityManager/XDBEntityProvider.ts` | imports `XDB`, `XDBEntity` from `../XDB/...` | `@xpell/xdb` |
| `src/XEntityManager/XEntityManager.ts` | imports `XDB`, `XDBEntityPersisted` from `../XDB/...` | `@xpell/xdb` |
| `src/XEntityManager/SQLiteEntityProvider.ts` | imports `XDB` from `../XDB/XDB.js` | `@xpell/xdb`, then remove private `_initOpts` dependency |
| `src/XEntityManager/MongoEntityProvider.ts` | imports `XDBObject` from `../XDB/XDBObject.js` | `@xpell/xdb` |
| `src/test.ts` | imports `XDB`, `XDBStorageFS`, `XDBObject` from local XDB files | Prefer `@xpell/node` compatibility re-export first, then direct `@xpell/xdb` package tests |

Additional generated code text in `src/XGenerative/XModuleCreator/XModuleCreatorModule.ts` imports `XModule` from `@xpell/node`; it does not consume XDB directly and should not change for this extraction.

## Proposed `@xpell/xdb` Package Contents

Recommended package structure:

```text
packages/xdb/
  package.json
  tsconfig.json
  src/
    index.ts
    XDB.ts
    XDBEngine.ts
    XDBEntity.ts
    XDBVector.ts
    XDBFile.ts
    XDBTemp.ts
    XDBCache.ts
    XDBStorageFS.ts
    XDBStorageSqlite.ts
    XDBObject.ts
    IXDBStorage.ts
    IXDBMaintenance.ts
    IXDBBackup.ts
    xdbReady.ts
    utils/
      xdbUtils.ts
    providers/
      index.ts
      XpellEmbeddingProvider.ts
  tests/
    ...
  docs/
    ...
```

Recommended exports:

```json
{
  "name": "@xpell/xdb",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@xpell/core": "^2.0.4"
  }
}
```

Dependency recommendation:

- `dependencies`: `bcryptjs`
- `optionalDependencies` or regular `dependencies`: `better-sqlite3`
- `optionalDependencies` or `peerDependencies`: `mongoose`
- `devDependencies`: `@xpell/core`, `@types/better-sqlite3`, `@types/node`, `typescript`

If the package should install cleanly without native builds, split SQLite and Mongo into subpath packages later. For the first backward-compatible extraction, keeping them in `@xpell/xdb` is simpler but means `better-sqlite3` remains part of install/build concerns.

## Should `XDBObject` Move?

Recommendation: yes, move `XDBObject` with XDB, but treat it as a provider/helper export rather than the core entity store.

Reasons:

- It lives under `src/XDB`.
- `MongoEntityProvider` imports it as XDB infrastructure.
- It depends only on `@xpell/core`, `bcryptjs`, and `mongoose`; it does not import `@xpell/node` internals.
- Leaving it in `@xpell/node` would force either `@xpell/node -> @xpell/xdb` and `@xpell/xdb -> @xpell/node` coupling, or an awkward split where Mongo provider cannot share the XDB object helper.

Risk:

- `XDBObject` uses Mongoose and `XResponse`, while `XDBEntity` intentionally returns raw data and throws native errors. Document it as a legacy/Mongo helper, not the canonical XDBEntity API.

## Files That Stay In `@xpell/node`

| File/area | Reason |
| --- | --- |
| `src/XServer/XNode.ts` | Server lifecycle, settings, work-folder resolution, module load order |
| `src/XSettings/**` | Node settings store |
| `src/XEntityManager/**` | Server module/API boundary, app/env entity registry, provider orchestration |
| `src/XVM/**` | ServerXVM app/view/flow/entity-definition persistence |
| `src/XFM/**` | Flow execution |
| `src/Wormholes/**` | Transport boundary |
| `src/XEM/**` | Node event manager wrapper unless replaced package-wide by core event manager |
| `src/XNUtils/XUtils.ts` | General node utility wrapper used by many non-XDB modules |
| `src/index.ts` | Top-level `@xpell/node` public surface and compatibility re-exports |

## Dependency-Cycle Risks

Current internal XDB cycles:

- `XDB.ts` imports `XDBEntity`, `XDBVector`, `XDBFile`, `XDBTemp`.
- `XDBEntity.ts` imports the `XDB` singleton to create helper objects.
- `xdbReady.ts` imports the `XDB` singleton, and helper objects import `xdbReady.ts`.

This cycle already exists and should still work if moved as a unit. It is a design risk for extraction because package boundary changes can make initialization order bugs more visible.

Recommended mitigation:

1. Keep the cycle unchanged in phase 1 to reduce behavioral risk.
2. Add package tests for `XDB.init(...)`, `loadModuleAsync(XDB)`, and `XDB.create({ _type: XDBEntity._xtype })`.
3. Later refactor toward engine injection or a local XDB runtime context if needed.

Cross-package cycle to avoid:

```text
@xpell/node -> @xpell/xdb -> @xpell/node
```

This must not happen. Replace `../XEM` and `../XNUtils` imports before moving files.

## Backward-Compatible Extraction Plan

### Phase 0: Stabilize Current Source Contracts

- Add source-level tests around XDB imports, XNode bootstrap with FS and SQLite, EntityManager XDB provider, and `XDBObject` Mongo helper construction where feasible.
- Record current public exports from `src/XDB/index.ts`.
- Decide whether `better-sqlite3` and `mongoose` are regular or optional dependencies.

### Phase 1: Prepare XDB For Package Boundary In Place

- Replace XDB imports from `../XEM/XEventManager.js` with a core event import or an injected event bridge.
- Replace XDB imports from `../XNUtils/XUtils.js` with:
  - `@xpell/core` `_xu.guid()` where available.
  - local XDB utilities for folders, path joining, encode/decode.
- Stop `SQLiteEntityProvider` from reading private `XDB._initOpts`.
- Consolidate duplicate `IXDBBackup` definitions.
- Keep all files physically in `src/XDB/**` during this phase.

### Phase 2: Create `packages/xdb`

- Add `packages/xdb/package.json`, `tsconfig.json`, and `src/**`.
- Copy XDB files after Phase 1 import cleanup.
- Build `@xpell/xdb` independently.
- Add it to the existing workspace, which already includes `packages/**` in `pnpm-workspace.yaml`.
- Move XDB-specific tests into `packages/xdb` or add a focused package test suite first.

### Phase 3: Switch `@xpell/node` Internals To `@xpell/xdb`

- Add `@xpell/xdb` as a workspace dependency of `@xpell/node`.
- Change internal imports in `XNode`, EntityManager providers, and tests from local XDB paths to `@xpell/xdb`.
- Keep module load order unchanged: XDB before EntityManager.
- Keep work-folder/storage creation in `XNode`.

### Phase 4: Temporary Compatibility Re-Exports

In `@xpell/node/src/index.ts`, replace:

```ts
export * from "./XDB/index.js";
```

with:

```ts
export * from "@xpell/xdb";
```

For deep local imports, provide a short-lived compatibility strategy:

- Preferred: update all repo imports to package imports immediately.
- If external consumers use deep imports like `@xpell/node/dist/XDB/XDB.js`, document that only top-level re-exports are supported. Deep dist compatibility is costly and should not be promised unless required.

Suggested deprecation policy:

- Release N: `@xpell/node` re-exports all `@xpell/xdb` public exports.
- Release N+1: keep re-exports and add docs pointing to `@xpell/xdb`.
- Release N+2 or major: consider removing re-exports only if consumers have migrated.

### Phase 5: Docs and Package Cleanup

- Update `README.md`, `docs/XDB-v1.md`, and architecture docs to import from `@xpell/xdb` for direct XDB use.
- Keep `@xpell/node` docs using `XNode.start({ _xdb: ... })` for server bootstrap.
- Fix `package.json` docs script or add missing `typedoc.json`; current package script references `typedoc.json`, but it is not present in this package.

## Compatibility Strategy

Public compatibility goals:

- Existing `import { XDB, XDBStorageFS } from "@xpell/node";` keeps working through re-exports.
- New direct XDB consumers should use `import { XDB, XDBStorageFS } from "@xpell/xdb";`.
- `XNode.start({ _xdb: ... })` remains the server bootstrap API.
- EntityManager commands and ServerXVM entity definitions remain unchanged.
- Runtime event names such as `xdb-ready` and `xentity-loaded` remain unchanged.

Non-goals:

- Do not make `@xpell/xdb` read `XSettings`.
- Do not move EntityManager into `@xpell/xdb`.
- Do not move ServerXVM entity definition persistence into `@xpell/xdb`.
- Do not guarantee deep import compatibility unless a release requirement explicitly demands it.

## Test and Build Changes

`@xpell/xdb` tests should cover:

- Package build and declaration output.
- `XDB.init(...)` plus `loadModuleAsync(XDB)` with FS storage.
- SQLite storage open/save/load/delete if `better-sqlite3` is available.
- `XDBEntity` add/find/update/delete, unique indexes, delete index rebuild, hash fields, file fields, vector staging, and temp files.
- `XDBObject` construction/model behavior if `mongoose` is installed and testable without an external database.
- `XpellEmbeddingProvider` command shape.

`@xpell/node` tests should cover:

- Top-level re-export compatibility.
- `XNode.start({ _xdb: { _type: "fs" } })` loads XDB from `@xpell/xdb`.
- `XNode.start({ _xdb: { _type: "sqlite" } })` storage creation still works.
- EntityManager `xdb` provider CRUD still works.
- Existing storage migration tests in `src/test.ts` still pass.
- ServerXVM boot registration still reaches EntityManager with no direct XDB import.

Build/package changes:

- Add `@xpell/xdb` to workspace package dependencies.
- Move or duplicate XDB package docs.
- Keep `@xpell/node` `files` unchanged except that `src/XDB` can be removed after compatibility is proven.
- Decide whether `better-sqlite3` remains in `@xpell/node`. If only XDB uses it after extraction, remove it from `@xpell/node` dependencies.
- Decide whether `mongoose` remains in `@xpell/node`. EntityManager Mongo provider and Mongo connection manager still use it, so `@xpell/node` may continue to depend on it even if `XDBObject` moves.

## Main Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Import cycle in XDB singleton/helper objects becomes brittle after packaging | Medium | Move XDB as a unit first; add package-level readiness/create tests |
| Accidental `@xpell/xdb -> @xpell/node` dependency | High | Remove `../XEM` and `../XNUtils` imports before extraction |
| Native `better-sqlite3` install/build friction shifts to `@xpell/xdb` | Medium | Make optional or document Node/native requirement |
| Mongoose dependency bloats direct XDB package | Medium | Make optional or later split Mongo helper subpath |
| EntityManager uses private `XDB._engine` and `_initOpts` internals | Medium | Preserve for compatibility initially; remove `_initOpts` read in SQLite provider |
| Deep import consumers break | Medium | Support top-level re-exports; document unsupported deep imports or create compatibility stubs if required |
| Docs script currently references missing `typedoc.json` | Low | Add/fix typedoc config during docs migration |

## Likely Files Affected

`@xpell/xdb` new package:

- all current `src/XDB/**`
- new local XDB utility file
- package metadata, tsconfig, tests, docs

`@xpell/node`:

- `package.json`
- `src/index.ts`
- `src/XServer/XNode.ts`
- `src/XEntityManager/XDBEntityProvider.ts`
- `src/XEntityManager/XEntityManager.ts`
- `src/XEntityManager/SQLiteEntityProvider.ts`
- `src/XEntityManager/MongoEntityProvider.ts`
- `src/test.ts`
- `docs/XDB-v1.md`
- `docs/architecture/**`
- README/package docs as needed

Workspace:

- `pnpm-workspace.yaml` likely needs no change because it already includes `packages/**`.
- lockfile changes after adding `@xpell/xdb`.

## Final Recommendation

Proceed with extraction in staged form.

Move the full XDB runtime into `@xpell/xdb`, including `XDBObject`, but keep server bootstrap, settings, EntityManager, ServerXVM, Wormholes, and work-folder policy in `@xpell/node`. Treat `@xpell/core` as the only Xpell runtime dependency of `@xpell/xdb`. Replace package-local `XEM` and `XNUtils` dependencies before moving files.

Use `@xpell/node` re-exports as the backward-compatible bridge:

```ts
export * from "@xpell/xdb";
```

Keep this bridge through at least one release cycle. The extraction should be done before deeper storage/provider refactors so package boundaries are clear while behavior remains stable.
