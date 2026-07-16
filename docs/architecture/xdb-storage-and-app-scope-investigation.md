# XDB Storage and App Scope Investigation

Date: 2026-07-16

Scope: `@xpell/node` XDB, `entity-manager`, ServerXVM entity artifacts, flows, generated entity paths, tests, and settings.

This report is analysis-only. It does not propose production code changes in this branch.

## 1. Executive Summary

App-aware XDB is practical, but it is not only a naming change. The current runtime already propagates `_app_id` and `_env` through ServerXVM, EntityManager, generated flows, and FlowManager, but XDB persistence still resolves entity storage by the raw `XDBEntity._name`. That means two apps can register logical `users` entities under separate EntityManager keys while still sharing the same physical XDB entity folder/table.

Current entities are effectively global at the record persistence layer. ServerXVM stores entity definitions under app/env directories, and EntityManager stores runtime registrations under `env::app::entity`, but `XDBEngine.loadEntity()` and `saveEntity()` use only `entityName`. With the filesystem adapter, records land in `work/xdb/entities/<entityName>/_data.json`; with SQLite, entity docs are keyed by `entity`. Existing tests assert the current global path for `users`.

Memory-only entities are feasible as an opt-in provider mode, but true disk-backed entities are not implemented today. Current FS and SQLite adapters both persist whole entity payload documents, and `XDBEntity` keeps the complete collection in `this._data`. A real disk mode needs record-level storage/query APIs or an entity provider abstraction; merely selecting SQLite through the current `IXDBStorage` contract still loads and saves whole entity documents.

MongoDB can be added without breaking the public EntityManager command API, but not cleanly as a thin current-style `IXDBStorage` adapter if the goal is Mongo-native query, pagination, indexes, uniqueness, and transactions. The safer target is an EntityManager-facing storage provider contract where XDB current memory/file behavior is the default provider, SQLite can become the first real disk provider, and Mongo is optional for apps that explicitly select it.

Recommended direction:

- Do now: introduce explicit app/env storage identity and provider selection in design/API, with default legacy/global behavior.
- Defer: true disk-backed provider until the provider contract is in place.
- Defer: MongoDB provider until SQLite proves the contract.
- Avoid: renaming current full-memory JSON persistence to `"disk"`.
- Preferred abstraction: EntityManager owns logical entity registry and delegates CRUD to a pluggable `EntityStorageProvider`; current XDB is the legacy/default provider.

## 2. Current Architecture Map

### XDB bootstrap and storage selection

`XNode.start()` boots XDB before EntityManager and ServerXVM. It builds storage from `options._xdb`, defaulting to FS under `<work_folder>/xdb`, or SQLite when `_xdb._type === "sqlite"` (`src/XServer/XNode.ts:72`, `src/XServer/XNode.ts:149`, `src/XServer/XNode.ts:158`, `src/XServer/XNode.ts:165`, `src/XServer/XNode.ts:177`).

`XDBOptions` currently supports `_type?: "fs" | "sqlite"`, `_root`, `_cache`, SQLite details, and embedding/vector providers (`src/XDB/XDBEngine.ts:131`). There is no Mongo option and no server settings JSON field for XDB in `src/server-settings.json:1`.

`XDBModule.init()` requires an injected `IXDBStorage`; `_init` explicitly throws because storage is not JSON-serializable and there is no storage registry (`src/XDB/XDB.ts:121`, `src/XDB/XDB.ts:140`). `xdbReady.ts` requires `XDB._engine._initialized` before XDB objects can operate (`src/XDB/xdbReady.ts:5`).

### Storage adapter contract

`IXDBStorage` is collection/document-oriented, not record-oriented. It exposes `loadEntity(entityName)` and `saveEntity(entityName, payload, saveSchema)` where the payload includes `_data`, `_schema`, `_indices`, vectors, files, temp, and metadata (`src/XDB/IXDBStorage.ts:22`, `src/XDB/IXDBStorage.ts:31`).

The FS adapter writes entity files under `entities/<entityName>/`; it reads `_meta.json`, `_schema.json`, `_data.json`, `_indices.json`, vector index docs, and helper folders (`src/XDB/XDBStorageFS.ts:141`, `src/XDB/XDBStorageFS.ts:193`, `src/XDB/XDBStorageFS.ts:214`). Its `loadEntity()` rejects a folder if `_meta._name !== entityName` (`src/XDB/XDBStorageFS.ts:194`, `src/XDB/XDBStorageFS.ts:201`).

The SQLite adapter stores entity docs in tables, but still as whole JSON documents. `xdb_entities.name` is the primary entity key, and `xdb_entity_docs` stores one JSON doc per `(entity, doc_type)` (`src/XDB/XDBStorageSqlite.ts:144`, `src/XDB/XDBStorageSqlite.ts:149`, `src/XDB/XDBStorageSqlite.ts:264`, `src/XDB/XDBStorageSqlite.ts:285`). Vectors/files/temp are delegated to a blob storage, defaulting to FS (`src/XDB/XDBStorageSqlite.ts:62`, `src/XDB/XDBStorageSqlite.ts:325`).

### XDBEntity runtime model

`XDBEntity` owns a full in-memory `_data: XDBEntityData[]` collection plus in-memory/persisted indexes and metadata (`src/XDB/XDBEntity.ts:147`, `src/XDB/XDBEntity.ts:150`, `src/XDB/XDBEntity.ts:152`, `src/XDB/XDBEntity.ts:155`).

Construction requires a ready XDB engine, creates helper `XDBVector`, `XDBFile`, and `XDBTemp` objects, normalizes schema, registers itself in engine metadata, and starts async `loadData()` (`src/XDB/XDBEntity.ts:175`, `src/XDB/XDBEntity.ts:183`, `src/XDB/XDBEntity.ts:185`, `src/XDB/XDBEntity.ts:208`, `src/XDB/XDBEntity.ts:225`).

`loadData()` loads the entire persisted entity into memory, assigns `_data`, `_schema`, `_indices`, vectors and meta, rebuilds indexes, and immediately saves once to normalize persisted format (`src/XDB/XDBEntity.ts:299`, `src/XDB/XDBEntity.ts:304`, `src/XDB/XDBEntity.ts:313`, `src/XDB/XDBEntity.ts:327`).

`find()`, `update()`, and `delete()` operate against `this._data`. Filtering is done by `XDBEngine.filterData()` over arrays; sorting and pagination are array operations (`src/XDB/XDBEntity.ts:1005`, `src/XDB/XDBEntity.ts:1028`, `src/XDB/XDBEntity.ts:1144`, `src/XDB/XDBEntity.ts:1232`, `src/XDB/XDBEntity.ts:1241`, `src/XDB/XDBEntity.ts:1260`, `src/XDB/XDBEntity.ts:1322`).

### EntityManager

`XEntityManager` is the public module boundary for entity registration and CRUD. It wraps results with `XResponseOK`/`XResponseError`, while `XDBEntity` returns raw data or throws (`src/XEntityManager/XEntityManager.ts:1`, `src/XEntityManager/XEntityManager.ts:93`, `src/XEntityManager/XEntityManager.ts:386`, `src/XEntityManager/XEntityManager.ts:579`).

It already uses a scoped runtime map key: `getEntityKey(app_id, env, entity_id) => "${env}::${app_id}::${entity_id}"` (`src/XEntityManager/XEntityManager.ts:129`, `src/XEntityManager/XEntityManager.ts:142`).

Registration creates an `XDBEntity` with `_id: entity_id` and `_name: entity._name ?? entity._title ?? entity_id`, then stores it in the scoped runtime map (`src/XEntityManager/XEntityManager.ts:282`, `src/XEntityManager/XEntityManager.ts:342`, `src/XEntityManager/XEntityManager.ts:348`, `src/XEntityManager/XEntityManager.ts:351`, `src/XEntityManager/XEntityManager.ts:371`). Existing registrations sync schema on the existing object (`src/XEntityManager/XEntityManager.ts:320`, `src/XEntityManager/XEntityManager.ts:323`).

CRUD operations resolve the scoped runtime registration, then call the underlying XDBEntity (`src/XEntityManager/XEntityManager.ts:150`, `src/XEntityManager/XEntityManager.ts:544`, `src/XEntityManager/XEntityManager.ts:624`, `src/XEntityManager/XEntityManager.ts:907`, `src/XEntityManager/XEntityManager.ts:952`).

### ServerXVM and generated artifacts

ServerXVM stores app bundles in `<work_folder>/xvm/apps/<env>/<app_id>/` and includes `_entities` in each bundle (`src/XVM/ServerXVMModule.ts:52`, `src/XVM/ServerXVMModule.ts:83`, `src/XVM/ServerXVMModule.ts:349`).

`server-xvm.set_entity` persists an entity definition into the app bundle and then calls `entity-manager.register` with `_app_id`, `_env`, and `_entity` (`src/XVM/ServerXVMModule.ts:849`, `src/XVM/ServerXVMModule.ts:869`, `src/XVM/ServerXVMModule.ts:873`, `src/XVM/ServerXVMModule.ts:875`).

Boot loading reads `entities/*.json` from each app directory and registers each entity with EntityManager (`src/XVM/ServerXVMModule.ts:1241`, `src/XVM/ServerXVMModule.ts:1275`, `src/XVM/ServerXVMModule.ts:1284`). Persisting a bundle writes `entities/<entity_id>.json` separately from XDB record data (`src/XVM/ServerXVMModule.ts:2036`, `src/XVM/ServerXVMModule.ts:2095`).

Flow execution preserves app/env through `flow.run`, loads flows through `server-xvm.get_flow`, and executes each step through `_x.execute()` (`src/XFM/FlowManagerModule.ts:168`, `src/XFM/FlowManagerModule.ts:191`, `src/XFM/FlowManagerModule.ts:287`). XVibe-generated create flows already include `_app_id`, `_env`, and `_entity` in EntityManager commands (`src/XVIBE/Artifact/ArtifactExecutor.ts:3074`, `src/XVIBE/Artifact/ArtifactExecutor.ts:3080`).

## 3. App-Scoping Feasibility

App-aware XDB is feasible because most command context already exists:

- ServerXVM entity definition storage is app/env scoped.
- EntityManager runtime registry is app/env scoped.
- FlowManager and generated flows propagate `_app_id` and `_env`.
- ArtifactResolver resolves entity definitions through `server-xvm.get_entity` with app/env (`src/XVIBE/Artifact/ArtifactResolver.ts:35`).

The missing layer is physical persistence identity. Today, `entity-manager.register` maps a scoped runtime key to an `XDBEntity`, but gives XDB a raw `_name`. XDBEngine and storage adapters persist by that raw name. Therefore:

- App A `default::crm::users` and App B `default::admin::users` can have separate EntityManager registrations.
- Both can still load/save XDB physical entity `users`.
- Schema sync in one app can overwrite the shared physical schema.
- Record CRUD in either app can see or mutate the same `_data`.

Complexity is medium-high because existing code must preserve logical entity ids while adding an internal physical name. A workable design is:

```text
logical entity id: users
scope: default + my-app
physical XDB entity name: default::my-app::users
public command remains: _entity: "users"
```

The physical scoped name should remain internal. Application code and generated flows should continue to use `_entity: "users"` plus `_app_id` and `_env`. EntityManager should resolve `(env, app_id, entity_id)` to a provider/physical identity and should not expose the physical prefix in records, responses, or generated code unless a diagnostic endpoint explicitly asks for it.

Affected areas:

- `src/XEntityManager/XEntityManager.ts`: registration, storage key construction, list/get/has/unregister, CRUD dispatch.
- `src/XDB/XDBEntity.ts`: `_name` currently controls storage and `_meta._name`.
- `src/XDB/XDBEngine.ts`: `_xdb_data._entities` currently stores raw names.
- `src/XDB/IXDBStorage.ts`, `XDBStorageFS.ts`, `XDBStorageSqlite.ts`: persistence identity is a single `entityName`.
- `src/XVM/ServerXVMModule.ts`: entity definition persistence and boot sync.
- `src/XFM/FlowManagerModule.ts`: likely no structural change, but regression tests are required for flow commands.
- `src/XVIBE/**`: generated commands and artifact resolver should continue using logical names.
- `src/test.ts`: current tests assert global physical paths such as `xdb/entities/users/_data.json`.

Collision risks:

- Current risk is high for same entity ids across apps or envs.
- With internal physical names, collision risk drops, but unsafe raw filesystem path characters must be sanitized or encoded. Literal `::` in a folder name may work on Unix but should not be assumed portable or safe for all adapters.
- Entity `_name` and `_title` should not be allowed to override physical identity for app-scoped records. They can remain display metadata.

Cross-app access risks:

- Current EntityManager blocks lookups by scoped runtime key, but once an entity is registered, underlying XDB storage can be shared accidentally.
- A future admin/global access mode must be explicit, not a fallback side effect.
- Wormholes authorization should treat cross-app EntityManager commands as app-scoped operations and enforce app access before execution.

Memory/cache implications:

- App scoping increases number of XDBEntity instances for common names. A tenant-heavy runtime may create many full in-memory `_data` arrays.
- XDB meta `_entities` will grow from logical names to physical scoped names unless a separate mapping is introduced.
- Cache keys and vector/file/temp folders must use the same physical identity as data to avoid vector/file leakage.

Entity discovery and generated entities:

- ServerXVM should remain the source of app artifact discovery: `list_entities` returns logical ids for an app (`src/XVM/ServerXVMModule.ts:977`).
- EntityManager `_list` already lists scoped logical definitions from its runtime map (`src/XEntityManager/XEntityManager.ts:1002`).
- Generated entities should persist definitions via `server-xvm.set_entity`, not directly in XDB.

ServerXVM and app loading:

- ServerXVM app loading already has app/env when registering definitions. It is the right place to synchronize definitions, but not to decide storage internals.
- `server-xvm.delete_entity` currently unregisters runtime schema but intentionally does not delete record data (`src/XVM/ServerXVMModule.ts:954`, `src/XVM/ServerXVMModule.ts:960`). That behavior needs an explicit compatibility policy when scoped physical data exists.

Flows and client APIs:

- Existing flows should keep command shape. FlowManager executes persisted JSON steps through `_x.execute()` and does not need to know storage identity.
- Client APIs should continue sending `_app_id`, `_env`, and logical `_entity`.

## 4. Backward Compatibility and Migration Analysis

Current behavior:

- Existing XDB data is global by physical entity name.
- FS data is stored under `work/xdb/entities/<entity>`.
- SQLite stores docs by `xdb_entities.name`.
- Entity definitions are app-scoped in ServerXVM, but records are not reliably app-scoped.
- Existing tests assert the global file path for records (`src/test.ts:27000`, `src/test.ts:34110`).

What happens to old apps if app-scoped storage is enabled abruptly:

- They may no longer see records stored in global `<entity>` names.
- If fallback reads global data, multiple apps with the same entity id could see legacy records until migrated.
- If fallback writes to global, app isolation remains broken.
- If fallback reads global but writes scoped, record counts can appear split unless migration is explicit.

Migration options:

1. Legacy/global default
   - Behavior: existing apps continue using physical `<entity>`.
   - Pros: safest immediate backward compatibility, no silent data movement.
   - Cons: no isolation by default, app-scoping opt-in only, continued collision risk for old apps.

2. App-scoped default with fallback
   - Behavior: new registrations use scoped physical name; reads may fall back to global when scoped storage is empty.
   - Pros: new apps get isolation; old apps can still see data.
   - Cons: high ambiguity. Fallback can leak global records into the wrong app. Writes need strict policy.

3. One-time migration
   - Behavior: explicit command/tool copies global `<entity>` into `<env>::<app>::<entity>` based on selected app context.
   - Pros: deterministic, auditable, supports backups and conflict reports.
   - Cons: requires operator decision for each global entity and app mapping; cannot infer safely when multiple apps define the same entity.

Recommended rollout:

1. Keep legacy/global as default for existing data and current apps.
2. Add explicit app-scoped mode on entity definitions or app config, for example `_storage_scope: "app"` or app-level `_xdb_scope: "app"`.
3. In app-scoped mode, never fallback-write to global. Optional fallback-read should be disabled by default or require `_legacy_fallback: true`.
4. Provide a dry-run migration report: global entity name, candidate app/env definitions, record counts, schema diff, uniqueness conflicts.
5. Provide explicit copy/move migration command only after dry-run confirmation.
6. Later change defaults for newly created apps only, not existing apps.

## 5. Memory/Disk Entity Feasibility

Current persistence model:

- XDB stores entity data in files for FS, and as JSON docs in SQLite.
- `XDBEntity.loadData()` loads complete entity collections into memory.
- Mutations update in-memory arrays and indexes.
- `commit()` writes the whole entity payload through `engine.saveEntity()`.
- `find()` is synchronous and array-based.

Therefore, current XDB already has disk persistence, but not disk-backed query/storage semantics. It is memory-resident with full-payload persistence.

Potential `_storage: "memory"`:

- Feasible as a true volatile provider.
- Semantics should be: schema registered in runtime, records kept in process memory, optional seed/import on boot, no required persistence after restart, no XDB metadata writes unless explicitly configured.
- Current code would need a `MemoryEntityProvider` or an `IXDBStorage` that does not persist, plus careful handling because `XDBEntity.loadData()` currently saves after load.

Potential `_storage: "disk"`:

- Not currently feasible as a label on current XDBEntity if “disk” means no full collection in memory.
- Required semantic change: record-level read/write/query/index APIs, async query execution, adapter-owned indexes, and provider-owned pagination.
- SQLite is a better first implementation than custom JSON files because it already provides transactions, WAL, indexed queries, uniqueness, durability, and pagination.

APIs that assume synchronous in-memory access:

- `XDBEntity.find()` returns immediately and slices arrays (`src/XDB/XDBEntity.ts:1232`).
- `XDBEntity.findById()` uses the in-memory primary index (`src/XDB/XDBEntity.ts:820`).
- `XDBEntity.update()` and `delete()` filter in-memory data (`src/XDB/XDBEntity.ts:1028`, `src/XDB/XDBEntity.ts:1153`).
- EntityManager `_find` calls `stored._xdb_entity.find(...)` synchronously and only awaits hash filtering afterward (`src/XEntityManager/XEntityManager.ts:695`, `src/XEntityManager/XEntityManager.ts:707`).

EntityManager methods are already `async`, so the public command boundary can support async providers. The hidden coupling is that the stored object is assumed to be an XDBEntity instance with sync `find`, raw `_schema`, and methods such as `verifyHashField()`.

Query/filter/sort/pagination implications:

- The current filter language is implemented in `XDBEngine.filterData()` and supports equality, range, string contains, date comparisons, array contains, and object search over arrays (`src/XDB/XDBEngine.ts:476`).
- A disk provider must define a portable subset and either translate it to SQL/Mongo or fall back with clear limits.
- Sorting and pagination must happen in storage for large datasets, not after full load.
- Hash fields cannot be queried by plaintext in the database; current `_hash_filter` post-filters records by bcrypt verification (`src/XEntityManager/XEntityManager.ts:206`). This is expensive and incompatible with large unbounded scans unless constrained.

Indexes:

- Current indexes are derived JSON state in `XDBEntity._indices`.
- Primary `_id` maps `_id` to array position, unique indexes map value to `_id`, non-unique indexes map value to `_id[]` (`src/XDB/XDBEntity.ts:35`, `src/XDB/XDBEntity.ts:623`).
- True disk providers should map schema `_index` to adapter indexes and constraints, while retaining GUID `_id` as canonical identity.

Concurrency and corruption:

- FS adapter uses synchronous `writeFileSync` without temp-file atomic replacement for XDB entity docs (`src/XDB/XDBStorageFS.ts:185`).
- SQLite adapter has transaction boundaries for entity doc writes (`src/XDB/XDBStorageSqlite.ts:288`).
- Current full-file writes are vulnerable to partial writes/process crash and concurrent writers. A custom JSON disk provider would need locks, temp files, checksums, and recovery.

Conclusion: true disk-backed entities are practical, but not by extending the current full-memory XDBEntity in place. Recommended path is provider-first, SQLite-first.

## 6. MongoDB Feasibility

MongoDB is technically available as a dependency (`mongoose` is listed in `package.json:54`), but no MongoDB XDB or EntityManager provider exists in the inspected source.

Mongo should be introduced as an optional provider behind EntityManager, not as a behavior-changing replacement for XDBEntity. EntityManager can remain the stable public API if it stores an abstract provider handle per `(env, app_id, entity_id)` instead of assuming `stored._xdb_entity`.

Storage/provider shape should be generic:

```json
{
  "_storage": "mongo",
  "_provider": "default"
}
```

or:

```json
{
  "_storage": {
    "_type": "mongo",
    "_provider": "default",
    "_collection": "users"
  }
}
```

Mongo impacts:

- Entity registration: schema must compile to collection/index definitions without losing XDB schema metadata.
- CRUD: add/get/find/update/delete should return the same EntityManager result shapes.
- Queries: define supported operators and reject unsupported operators explicitly.
- Pagination: use cursor/limit/skip or keyset pagination for large collections.
- Aggregation: current EntityManager supports only a narrow `sum` over provided records (`src/XEntityManager/XEntityManager.ts:744`). Mongo aggregation should not leak Mongo pipelines into generic EntityManager by default.
- IDs: retain Xpell GUID `_id` as canonical identity. Mongo `_id`/ObjectId should remain adapter-internal or mirrored, not become public identity.
- Hash fields: preserve bcrypt behavior; never query password-like fields by plaintext except explicit bounded verification flows.
- Indexes/uniqueness: map `_index: true` and `_index: { _unique: true }` to Mongo indexes; handle build errors and duplicates deterministically.
- Relationships: continue storing GUID `_id` references.
- Serialization: dates and ObjectIds must return JSON-compatible transport-safe values.
- App-scoped namespaces: include env/app in collection naming or query partition keys. Prefer provider-managed namespace, not user-visible physical names.
- Transactions: optional and provider-capability dependent; required for multi-record/multi-collection workflows only when configured.
- Connection lifecycle: belongs to provider boot/shutdown, not per command.
- Configuration/secrets: connection strings must come from settings/secrets, not entity JSON or logs.

Can storage-specific behavior be hidden?

Mostly yes for CRUD/query/list. Not fully for Mongo-specific aggregation, text search, and transactions unless exposed through explicit provider capability ops. Keep generic EntityManager stable and add provider-specific escape hatches only after capability checks.

Current APIs too coupled to XDBEntity:

- EntityManager stores `_xdb_entity` and calls XDBEntity methods directly.
- EntityManager hash filtering expects `verifyHashField()` on the XDBEntity.
- Schema inspection returns the original definition object, not a provider-normalized schema.
- Current tests assert file paths and XDB engine metadata.

## 7. Risk Matrix

| Risk | Level | Reason | Affected areas |
| --- | --- | --- | --- |
| Same entity id across apps shares records | High | Runtime keys are scoped, physical XDB name is not | EntityManager, XDBEntity, XDBEngine, FS/SQLite storage |
| App-scoped default breaks old data visibility | High | Existing data lives under global names such as `users` | Migration, tests, existing apps |
| Fallback from scoped to global leaks data | High | Cannot infer which app owns global records | EntityManager, auth policy, migration |
| True disk mode mislabeled over current XDB | High | Current adapters still load/save full payload docs | XDBEntity, IXDBStorage, FS/SQLite |
| Provider abstraction touches many call sites | Medium | EntityManager can be the boundary, but stored object assumptions are strong | EntityManager, tests, XDBEntity |
| SQLite record provider implementation | Medium | Needs query translation, schema/index management, migration | New provider, tests |
| Mongo provider implementation | High | Query semantics, connection lifecycle, indexes, ObjectIds, transactions, secrets | New provider, settings, deployment |
| FS custom disk provider | High | Atomicity, locking, corruption recovery, indexes are hard | XDBStorageFS or new provider |
| Generated flows lose context | Low | Current generated flows already include app/env | XVibe, FlowManager tests |
| ServerXVM entity definitions diverge from provider schema | Medium | Definitions and record storage are separate boundaries | ServerXVM, EntityManager registration |
| Deleting entity accidentally deletes records | Medium | Current delete unregisters schema but keeps records | ServerXVM, migration UX |
| Hash filtering over large disk/Mongo datasets | Medium | Bcrypt verification requires reading candidates | EntityManager, provider query planning |

## 8. Recommended Target Architecture

Target layers:

```text
ServerXVM
  owns app/env entity definition artifacts

EntityManager
  owns logical registry, app/env scope, public command API, result envelopes

EntityStorageProvider
  owns CRUD/query/pagination/index persistence for one logical scoped entity

Providers
  xdb-memory-file legacy provider
  memory provider
  sqlite provider
  mongo provider
```

EntityManager registry entry should become:

```ts
{
  _app_id: string;
  _env: string;
  _entity_id: string;
  _definition: object;
  _scope: "global" | "app";
  _storage: "xdb" | "memory" | "sqlite" | "mongo";
  _physical_name?: string;
  _provider: EntityStorageProvider;
}
```

Provider contract should include:

- `init(definition, context)`
- `syncSchema(definition)`
- `add(data)`
- `get(id)`
- `find(query)`
- `update(filter, updates)`
- `delete(filter)`
- `getSchema()`
- `dispose()`

Provider result shapes should remain raw internally. EntityManager remains the response envelope boundary.

XDB current behavior should be preserved as the legacy provider. App-scoped XDB can be implemented by passing a physical scoped name to XDBEntity while keeping logical `_entity` public.

## 9. Recommended Phased Implementation Plan

Phase 0: contract and diagnostics

- Add docs for current global record behavior.
- Add a diagnostic command/report that lists EntityManager registrations and physical XDB names.
- Add tests that prove current collision behavior before changing it.

Phase 1: storage identity and compatibility flags

- Add explicit entity/app storage scope fields.
- Keep default `global` for existing apps.
- For scoped entities, EntityManager resolves physical names internally.
- Do not implement migration yet.

Phase 2: app-scoped XDB provider

- Implement app/env physical identity for XDB-backed entities.
- Keep logical names in ServerXVM, flows, XVibe artifacts, and client APIs.
- Add tests for two apps with `users` proving isolated schema and records.

Phase 3: migration tooling

- Dry-run migration: inspect global entity names, app definitions, schema diffs, counts, and uniqueness conflicts.
- Explicit copy/move migration command with backup.
- No implicit migration during normal reads/writes.

Phase 4: memory provider

- Add true volatile provider.
- Define optional seed/import behavior.
- Ensure restarts drop records unless seed is configured.

Phase 5: SQLite record provider

- Implement record-level tables and adapter-owned indexes.
- Translate supported filters/sort/pagination.
- Preserve Xpell GUID `_id`.
- Add transaction and corruption recovery tests.

Phase 6: Mongo provider

- Add optional provider config and connection lifecycle.
- Implement supported CRUD/query/index subset.
- Keep provider-specific capabilities explicit.

## 10. Likely Files/Modules To Change

- `src/XEntityManager/XEntityManager.ts`
- `src/XDB/XDBEntity.ts`
- `src/XDB/XDBEngine.ts`
- `src/XDB/IXDBStorage.ts`
- `src/XDB/XDBStorageFS.ts`
- `src/XDB/XDBStorageSqlite.ts`
- `src/XDB/index.ts`
- `src/XServer/XNode.ts`
- `src/XSettings/XSettings.ts`
- `src/XVM/ServerXVMModule.ts`
- `src/XFM/FlowManagerModule.ts`
- `src/XVIBE/Artifact/ArtifactExecutor.ts`
- `src/XVIBE/Artifact/ArtifactResolver.ts`
- `src/XVIBE/Runtime/RuntimeContextManager.ts`
- `src/XVIBE/Processors/*FieldProcessor.ts`
- `src/XVIBE/Processors/CrudProcessor.ts`
- `src/test.ts`
- `docs/XDB-v1.md`
- `docs/xdb-codex.md`
- this architecture report or follow-up implementation contract docs

## 11. Required Regression Tests

App scoping:

- Register `users` in two apps and verify schemas do not overwrite each other.
- Add records to both apps and verify queries are isolated.
- Same app different envs must be isolated.
- Legacy/global entity still reads old `xdb/entities/users/_data.json`.
- Scoped entity physical path/name is not exposed in normal EntityManager responses.
- ServerXVM boot reload re-registers scoped entities correctly.
- `server-xvm.delete_entity` unregisters schema without deleting records unless explicit delete-records option exists.
- Generated create flow with EntityManager command preserves `_app_id` and `_env`.

Storage modes:

- Memory entity loses records after provider/runtime restart.
- Memory entity can seed records if seed config exists.
- Disk provider does not load all records for find/list.
- Disk provider enforces unique indexes.
- Disk provider supports filter/sort/pagination equivalence for supported operators.
- Concurrent writes are deterministic or rejected with structured errors.
- Crash/partial-write simulation for FS if a custom disk adapter is attempted.

Mongo:

- Provider config missing/invalid fails safely.
- Connection lifecycle opens/closes once per runtime/provider.
- GUID `_id` remains public identity.
- Unique indexes and duplicate insert errors map to stable Xpell errors.
- Unsupported operators are rejected.
- Serialization returns JSON-compatible records.
- App/env namespace isolation.

Migration:

- Dry-run reports ambiguous global entity ownership.
- Migration refuses schema conflicts without explicit resolution.
- Copy mode preserves source global data.
- Move mode backs up and removes only after successful copy.
- Re-running migration is idempotent or reports already migrated.

## 12. Open Questions and Decisions

- Should app-scoped storage be configured per app, per entity, or globally for new apps?
- What exact field names should define storage: `_storage`, `_provider`, `_scope`, `_storage_scope`, or app-level `_xdb`?
- Should system apps use global or app-scoped records?
- Should `entity._name` remain display metadata only, or can it still affect physical storage in legacy mode?
- What is the allowed physical-name encoding for FS/SQLite/Mongo?
- Should legacy fallback ever be allowed in production?
- Should deleting an entity definition ever delete records by default? Current behavior says no.
- Which filter operators are mandatory for all providers?
- Should aggregation become a provider API or remain generated flow/client composition?
- Where should Mongo secrets live: XSettings, environment, or a future secrets module?
- What provider capability metadata should XVibe use before generating provider-specific artifacts?

## 13. Clear Final Recommendation

Do now:

- Treat current XDB records as global and document that explicitly.
- Add design/tests for app-scoped physical identity behind EntityManager.
- Preserve current public command shape: `_app_id`, `_env`, logical `_entity`.
- Keep legacy/global mode as the default for existing apps and data.

Defer:

- True disk-backed entities until a provider contract exists.
- MongoDB until the provider contract is proven by SQLite.
- Default app-scoping for all apps until migration tooling exists.

Avoid:

- Do not label the current full-memory XDBEntity plus FS/SQLite full-document persistence as `"disk"`.
- Do not infer migration ownership for global entities.
- Do not expose Mongo ObjectIds or provider-specific physical collection names as public entity identity.

Preferred storage abstraction:

EntityManager should become the stable app/entity command facade over pluggable entity storage providers. The current XDBEntity implementation should remain the legacy/default provider; SQLite should be the first true disk-backed provider; MongoDB should be optional and capability-gated.

## Terminal Summary

Overall complexity: medium-high for app scoping, high for true disk and Mongo providers.

Highest risks:

- Physical XDB entity names are global today, despite scoped EntityManager registry keys.
- Existing data/tests rely on global paths such as `xdb/entities/users/_data.json`.
- Current FS and SQLite adapters persist whole entity documents; they do not provide true disk-backed record access.
- Mongo requires a provider abstraction to avoid leaking Mongo semantics into generic EntityManager commands.

Recommended direction:

- Keep EntityManager as the public API.
- Add internal app/env physical identity first.
- Roll out app-scoped storage as opt-in with explicit migration.
- Implement SQLite as the first true disk provider.
- Add Mongo later as an optional provider.

Suggested first implementation phase:

Add diagnostics and tests for current global collision behavior, then introduce an internal scoped physical-name resolver in EntityManager while preserving legacy/global default behavior.
