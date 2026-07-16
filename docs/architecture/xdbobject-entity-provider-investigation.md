# XDBObject EntityProvider Investigation

## 1. Executive Summary

`XDBObject` can be reused as the Mongo-backed implementation behind EntityManager, but not as a direct provider. The recommended architecture is:

1. Add a `MongoEntityProvider` that implements the internal `EntityProvider` contract.
2. Keep EntityManager as the only public CRUD and response-envelope boundary.
3. Let EntityManager continue resolving app/environment scope and pass only the resolved physical identity into the provider.
4. Translate EntityManager entity schemas and portable queries inside `MongoEntityProvider`.
5. Add narrowly scoped raw/internal methods to `XDBObject` so the provider can receive raw records and throw errors instead of unwrapping public `XResponse` envelopes.

The least risky direction is **reuse plus wrapper with small `XDBObject` fixes**. Do not make EntityManager aware of Mongo, Mongoose models, collection names, ObjectIds, pipelines, or raw Mongo filters.

Mongo should **not precede SQLite** as the next provider milestone. SQLite is the better reference provider for the generic contract because it forces row-level storage, query translation, pagination, and deterministic unsupported-operation errors without adding network connection lifecycle and Mongoose model risks. Mongo should follow once the SQLite provider and portable query subset are stable.

## 2. Current XDBObject Capability Map

Observed source: `src/XDB/XDBObject.ts`.

| Capability | Current XDBObject support | Notes |
| --- | --- | --- |
| Model creation | Yes | `createModel()` builds a Mongoose schema and model from `_schema` and `_name`. |
| Schema/index setup | Partial | `_schema` is passed directly to `mongoose.Schema`; `_indexes` are applied through `schema.index()`. This does not match XDB entity schema directly. |
| Runtime index add/list/drop/rebuild | Yes | `addIndex`, `listIndexes`, `dropIndex`, `rebuildIndexes`. These should remain provider/internal, not public EntityManager CRUD. |
| Hash fields | Partial | `fixFields(..., true)` hashes fields marked with `_xhash`, not XDB `Hash` fields. |
| Add | Yes | `add()` saves a Mongoose document, but deletes incoming `_id` and returns `XResponse`. |
| Search array | Yes | `searchArray()` returns an `XResponse` containing an array. No skip/limit/sort. |
| Search polymorphic | Yes, but risky | `search()` returns one object when exactly one match exists, otherwise an array. |
| Find by id | Yes | `findById()` calls `findOne({ _id: objId })`, so it assumes Mongo `_id` is the public identity. |
| Update | Partial | `update()` uses `findOneAndUpdate`, so it updates one record, while EntityManager providers currently expect filtered update semantics. |
| Delete | Yes | `delete()` calls `deleteMany()` and returns Mongoose delete result inside `XResponse`. |
| Count | Missing | Can be added through `countDocuments()` or wrapped in provider without changing public API. |
| Aggregation helpers | Yes, specialized | `getGrandchildren()` exposes raw Mongo aggregation concepts and ObjectId matching; it should be capability-gated and not normal EntityManager CRUD. |
| Connection lifecycle | Missing | No current central Mongo connection setup was found in `src`; only the `mongoose` dependency and direct use exist. |
| Disposal | Missing | No model/provider disposal or connection release method exists on `XDBObject`. |

## 3. EntityProvider Method Mapping Table

Current contract: `src/XEntityManager/EntityProvider.ts`.

| EntityProvider method | XDBObject mapping | Direct match? | Required wrapper/change |
| --- | --- | --- | --- |
| `init()` | construct `XDBObject`, ensure connection, create model | No | `MongoEntityProvider.init()` should resolve connection, translate schema, create model, and validate indexes. |
| `syncSchema(definition)` | `createModel()` and index sync | No | Provider should translate the XDB entity definition into a Mongoose schema and index list. Existing model replacement must avoid global model collisions. |
| `add(data)` | `XDBObject.add(data)` | Partial | Must preserve Xpell `_id`, avoid input mutation, return raw record, and throw structured errors. |
| `get(id)` | `XDBObject.findById(id)` | Partial | Should query by public Xpell `_id`, not Mongo ObjectId. |
| `find(query, options)` | `searchArray(filter)` / Mongoose `find()` | Partial | Provider must translate portable query subset, apply sort/skip/limit in Mongo, and return EntityManager-compatible `{ _meta, _data }`. |
| `count(query)` | missing | No | Use `Model.countDocuments(translatedFilter)` in provider or raw helper. |
| `update(filter, updates)` | `XDBObject.update(filter, updates)` | Partial | Existing method updates one record. Provider needs filtered update count semantics or a raw helper using `updateMany` after validation/hash preparation. |
| `delete(filter)` | `XDBObject.delete(filter)` | Partial | Delete result must normalize to `{ _deleted: number }`. |
| `getSchema()` | `_schema` | Partial | Provider should return the logical EntityManager definition, not Mongoose schema internals. |
| `getRecords(result)` | provider result `_data` | No | Implement in `MongoEntityProvider`, same shape as XDB/SQLite providers. |
| `getRecordCount(result)` | provider result `_data.length` | No | Implement in provider. |
| `applyHashFilter(result, hash_filter)` | `compareHashField()` | Partial | Provider should verify only bounded candidate sets and only declared `Hash` fields. |
| `aggregate(request)` | no generic sum; specialized Mongo helper exists | Partial | For V1, keep generic record-array `sum` behavior. Raw pipelines should not be exposed through normal CRUD. |
| `getCapabilities()` | missing | No | Provider reports Mongo-supported query operators, transactions, persistence, hash verification, aggregation limits. |
| `getPhysicalIdentity()` | missing | No | Provider returns EntityManager-resolved identity. |
| `getRuntimeEntityHandle()` | `_model` or `XDBObject` | Partial | Optional diagnostics only; do not leak to app commands. |
| `dispose()` | missing | No | Provider should deregister/release model references; connection closure belongs to shared connection manager. |

## 4. Recommended Identity Strategy

Recommendation: **preserve Xpell GUID `_id` as the public identity and keep Mongo `_id` internal**.

Do not choose Mongo ObjectId as public `_id`.

Reasons:

- Backward compatibility: XDB and SQLite providers already expose Xpell GUID `_id`. Existing flows, relationships, diagnostics, and tests expect portable `_id`.
- Provider portability: EntityManager commands should behave the same across `xdb`, `memory`, `sqlite`, and future `mongo`.
- Relationships: app records can safely reference other records by Xpell `_id` without depending on Mongo ObjectId serialization.
- Serialization: ObjectId values introduce BSON-specific behavior and awkward JSON conversion. Xpell GUID strings are stable JSON values.
- Query behavior: `get(id)` should query by `_id` as a logical Xpell field. Mongo `_id` can remain native and indexed internally, but should not be returned as the canonical id.
- Migration impact: moving XDB/SQLite records into Mongo is straightforward if `_id` is preserved. Re-keying every record and relationship into ObjectIds would require a destructive migration and relationship rewrite.

Implementation direction:

- Store Mongo `_id` as Mongoose internal identity and strip it from normal EntityManager records.
- Store Xpell public `_id` in a required, unique, immutable internal field such as `_xid`.
- Normalize records on provider output by returning `_id: record._xid` and omitting Mongo `_id` / `_xid`.
- Translate `get(id)` to `Model.findOne({ _xid: id })`.
- Translate app filters on `_id` into Mongo filters on `_xid`.
- Add an explicit unique index on `_xid`.

Using Mongo `_id` as a string equal to the Xpell GUID is possible, but it is not the preferred V1 plan because it changes existing `XDBObject` ObjectId assumptions. The provider should keep that as a later simplification only after compatibility tests prove no current `XDBObject` user depends on native ObjectIds.

`XDBObject.add()` currently deletes incoming `_id`. That behavior must not be used by the provider path unless changed behind an internal option.

## 5. App/Environment Model and Collection Naming Strategy

EntityManager already resolves physical identity:

- `global`: `users`
- `app`: `<env>::<app-id>::users`
- `server`: `server::users`

It then encodes unsafe names into `_physical_entity_name`. Mongo should receive only that resolved physical name and should not understand app semantics.

Recommended Mongo naming:

| Item | Strategy |
| --- | --- |
| Logical entity id | Stays public as `_entity: "users"` in commands and responses. |
| Provider physical identity | Use `EntityPhysicalIdentity._physical_identity` for diagnostics only. |
| Collection name | Use `EntityPhysicalIdentity._physical_entity_name`, optionally prefixed with a stable namespace such as `xent_` if not already encoded. |
| Mongoose model name | Use provider type plus encoded physical name, e.g. `xpell_entity_mongo_${physical_entity_name}`. |
| Connection | Resolved by server settings/provider config, not entity definitions containing secrets. |

Two apps defining logical `users` with `_storage._scope: "app"` must produce different model names and collection names. Do not use raw `this._name` in global `mongoose.models` without connection scoping, because current `XDBObject.createModel()` reuses `mongoose.models[this._name]`.

Use `connection.model(modelName, schema, collectionName)` instead of global `mongoose.model(modelName, schema)` so models are scoped to the selected Mongo connection.

## 6. Schema Translation Design

Schema translation should live in **MongoEntityProvider**, not EntityManager.

Reasons:

- EntityManager should remain provider-agnostic and own only logical registration plus physical identity resolution.
- `XDBObject` currently expects a Mongoose-compatible schema. It should not learn every EntityManager provider rule unless it becomes a generic provider itself.
- The provider can reject unsupported schema features with structured provider errors.

EntityManager/XDB schema fields use `_type`, `_required`, `_default`, `_index`, `_enum`, `_min`, `_max`, `_min_length`, `_max_length`, `_pattern`, `_immutable`, `_auto_increment`, `_embed`, `_toFile`, and special types like `Hash`, `Vector`, `Matrix`, `File`.

Mongo V1 schema translation:

| XDB type | Mongoose mapping | V1 support |
| --- | --- | --- |
| `String` | `String` | Supported, including required/default/enum/min/max length/pattern. |
| `Number` | `Number` | Supported, including required/default/min/max/enum. `_auto_increment` should be rejected or implemented explicitly later. |
| `ObjectId` | `String` for public Xpell ids | Supported as Xpell id/reference string, not Mongo ObjectId. |
| `Boolean` | `Boolean` | Supported. |
| `Array` | `Array` or `[Schema.Types.Mixed]` | Supported for storage and `_includes`; index behavior limited. |
| `Object` | `Schema.Types.Mixed` or nested schema | Supported for storage; limited portable filtering. |
| `Date` | `Date` | Supported with JSON normalization on output. |
| `Hash` | `String` with provider hashing | Supported. Do not use `_xhash`; translate `Hash` to hashed string storage. |
| `File` | Not Mongo V1 | Reject or store explicit metadata only in a later file-storage capability phase. |
| `Vector` | Not Mongo V1 | Reject or mark unsupported; do not silently ignore embeddings. |
| `Matrix` | Not Mongo V1 | Reject or mark unsupported. |

Indexes:

- `_id`: unique public id.
- `_index: true`: create a normal Mongo index.
- `_index: { _unique: true }`: create a unique Mongo index.
- `_index: { _primary: true }`: only meaningful for `_id`; otherwise reject or ignore with diagnostics.

Index synchronization should be explicit. `autoIndex: true` is acceptable for tests/dev, but production should avoid implicit index builds unless settings enable it.

## 7. Query/Capability Matrix

Mongo V1 should implement the portable EntityManager subset already represented by SQLite:

| Feature/operator | Mongo translation | V1 support | Notes |
| --- | --- | --- | --- |
| Equality | `{ field: value }` | Yes | Use schema-normalized values. |
| `_eq`, `_equals`, `=` | `{ field: value }` | Yes | Normalize aliases. |
| `_gt`, `>` | `{ field: { $gt: value } }` | Yes | Numbers/dates/strings where schema supports comparison. |
| `_gte`, `>=` | `{ field: { $gte: value } }` | Yes | Same. |
| `_lt`, `<` | `{ field: { $lt: value } }` | Yes | Same. |
| `_lte`, `<=` | `{ field: { $lte: value } }` | Yes | Same. |
| `_in` | `{ field: { $in: values } }` | Yes | Require array. |
| `_contains` on string | escaped regex or text operator | Yes, bounded | Prefer escaped case-sensitive regex for parity with XDB string contains. |
| `_starts_with`, `_starts` | anchored escaped regex | Yes | If included in provider capabilities. |
| `_ends_with`, `_ends` | anchored escaped regex | Yes | If included in provider capabilities. |
| `_includes` on array | `{ field: value }` or `$elemMatch` | Yes for simple values | Reject complex object searches in V1. |
| Sorting | `.sort()` | Yes | Only declared fields plus `_id`, `_created_at`, `_updated_at`. |
| Skip/limit | `.skip().limit()` | Yes | Must happen in Mongo, not after loading all rows. |
| Pagination metadata | count + page result | Yes | Use `countDocuments()` for `_total_records`. |
| Count | `countDocuments()` | Yes | Provider method. |
| Generic `sum` aggregation | record-array sum | Yes | Keep same EntityManager-compatible behavior. Native Mongo aggregation is a future capability. |
| Raw Mongo filters | none | No | Do not expose through EntityManager. |
| Raw aggregation pipelines | none | No | Keep `getGrandchildren()` outside normal CRUD. |
| Text search | none | No | Future capability. |
| Geospatial | none | No | Future capability. |
| Unindexed arbitrary scans | reject or cap | No by default | Avoid accidental full collection scans, especially for hash verification. |

Unsupported operators should throw structured provider errors such as `E_ENTITY_MONGO_QUERY_UNSUPPORTED` with `_provider`, `_field`, and `_operator` metadata.

## 8. Response/Error Normalization Strategy

EntityManager must remain the only public response-envelope boundary.

Current problem:

- `XDBObject.add`, `searchArray`, `search`, `findById`, `update`, `delete`, and `distinct` return `XResponse` envelopes.
- EntityManager provider methods should return raw records/provider result shapes or throw errors.
- If `MongoEntityProvider` returns `XDBObject` envelopes, EntityManager would wrap them again in `XResponseOK`, creating nested response envelopes.

Recommended least-risk option:

1. Keep existing public `XDBObject` methods for backward compatibility.
2. Add raw/internal helpers to `XDBObject`, for example:
   - `addRaw(data, opts)`
   - `findRaw(filter, options)`
   - `findOneRaw(filter)`
   - `countRaw(filter)`
   - `updateManyRaw(filter, updates)`
   - `deleteManyRaw(filter)`
   - `toEntityRecord(document)`
3. `MongoEntityProvider` calls only raw helpers.
4. Existing `XDBObject` public methods can delegate to raw helpers and wrap with `XResponse`, preserving current users.

Errors:

- Raw helpers should throw `XError` or normal errors with stable codes where practical.
- Provider should normalize duplicate-key errors into `E_ENTITY_MONGO_CONSTRAINT`.
- Provider should normalize unsupported schema/query behavior into `E_ENTITY_MONGO_SCHEMA_UNSUPPORTED` and `E_ENTITY_MONGO_QUERY_UNSUPPORTED`.
- EntityManager continues returning `XResponseError(err).toXData()`.

Avoid refactoring EntityManager for Mongo-specific envelope handling.

## 9. Connection Lifecycle Design

Current state:

- `mongoose` is installed.
- No central Mongo connection initialization/shutdown flow was found in `src`.
- `XDBObject` uses global `mongoose.models` and `mongoose.connection`.

Recommended design:

1. Add an internal Mongo connection manager, for example `src/XEntityManager/MongoConnectionManager.ts` or `src/XDB/XDBMongoConnection.ts`.
2. Resolve connection config from server settings or environment, not from entity definitions containing secrets.
3. Allow entity definitions to select a named connection only if needed, for example:

```json
{
  "_storage": {
    "_provider": "mongo",
    "_scope": "app",
    "_connection": "default"
  }
}
```

4. Store connection secrets in `XSettings` or environment:

```json
{
  "entity_providers": {
    "mongo": {
      "default": {
        "_uri_env": "XPELL_MONGO_URI",
        "_db_name": "xpell"
      }
    }
  }
}
```

5. Connect once per named connection and reuse it across providers.
6. Providers call `connection.model(modelName, schema, collectionName)`.
7. On provider `dispose()`, release provider/model references but do not close the shared connection if other providers use it.
8. On server shutdown, close all Mongo connections through the connection manager.
9. Handle reconnect/failure through Mongoose connection events and structured provider errors during operations.

Do not allow entity definitions to include raw Mongo URIs, passwords, or credentials.

## 10. Required XDBObject Changes

Required before provider integration:

| Change | Reason | Risk |
| --- | --- | --- |
| Add raw/internal methods | Avoid nested `XResponse` envelopes and keep EntityManager stable. | Low if existing methods delegate to raw helpers. |
| Stop mutating caller input in provider path | `add()` currently deletes `data._id`; provider must preserve Xpell `_id`. | Medium; keep old public behavior unless opt-in. |
| Support provider-supplied connection/model/collection names | Avoid global model and collection collisions. | Medium. |
| Throw on model creation failure in raw path | Current `createModel()` logs and continues; provider needs deterministic failure. | Low. |
| Support XDB `Hash` schema type | Current hashing checks `_xhash`, not `_type: "Hash"`. | Medium; centralize in provider or raw helpers. |
| Deterministic raw find array | Existing `search()` changes return type based on result count. | Low; use `findRaw()` for provider. |
| Add count helper | Provider needs `count()`. | Low. |
| Add filtered update-many helper | EntityManager update semantics are filtered update count, not only `findOneAndUpdate`. | Medium. |
| Normalize serialization | Public record must be JSON-compatible and provider-portable. | Medium. |

Should be evaluated but not necessarily changed in the first implementation:

- Constructor calls `super(data)` and `parse(data)` again. This is verified. It may be harmless if `XObject` does not parse by default in that call path, but it should be tested before provider work.
- `autoIndex: true` in schema construction. Keep for tests/dev; production should use explicit setting.
- `getGrandchildren()` assumes `parentId` is a Mongo ObjectId. Keep it out of generic provider V1.

## 11. Required MongoEntityProvider Changes

New provider responsibilities:

- Add `"mongo"` to `EntityProviderType`.
- Extend EntityManager `resolveStorageProvider()` and `createProvider()` to support `"mongo"` after provider implementation exists.
- Own schema translation from XDB entity definitions to Mongoose schema/index definitions.
- Own physical identity to model/collection name mapping.
- Own portable query translation.
- Own response shape normalization:

```ts
{
  _meta: {
    _name: logical_entity_id,
    _skip,
    _limit,
    _total_records,
    _records
  },
  _data: records,
  _vectors_ids: {},
  _matrices: {}
}
```

- Own `Hash` write hashing and bounded hash verification.
- Report provider capabilities:
  - `persistent-storage`: true
  - `transactions`: true only if using sessions and replica set/transaction-capable deployment; otherwise false
  - `query-operators`: true with explicit operator list
  - `hash-verification`: true with bounded verification
  - `aggregation`: generic record-array `sum` true; native Mongo aggregation false unless a separate capability is added later
  - `runtime-entity-handle`: true for internal diagnostics only
  - `physical-unregister`: false by default; unregister must preserve records
- Normalize Mongo duplicate-key errors and validation errors into structured errors.
- Implement `dispose()` without dropping collections or deleting records.

## 12. Likely Files to Modify

Expected implementation files:

- `src/XEntityManager/EntityProvider.ts`
  - Add `"mongo"` to `EntityProviderType`.
  - Possibly add richer capability metadata only if needed.

- `src/XEntityManager/XEntityManager.ts`
  - Add provider resolution and factory branch for `"mongo"`.
  - Keep public command shapes unchanged.

- `src/XEntityManager/MongoEntityProvider.ts`
  - New provider wrapper implementing the contract.

- `src/XEntityManager/MongoQueryTranslator.ts` or private provider helpers
  - Optional extraction if query translation becomes large.

- `src/XEntityManager/MongoSchemaTranslator.ts` or private provider helpers
  - Optional extraction if schema translation becomes large.

- `src/XEntityManager/MongoConnectionManager.ts`
  - Shared connection lifecycle.

- `src/XDB/XDBObject.ts`
  - Add raw/internal methods and connection/model injection support.
  - Preserve existing public methods.

- `src/XSettings/XSettings.ts` or settings docs/defaults
  - Only if a settings path helper or default config is needed. Prefer existing `getPath`/`setPath` behavior if sufficient.

- `docs/XDB-v1.md`
  - Document Mongo provider support, capabilities, and limitations after implementation.

- `src/test.ts` or dedicated test file if the repo is split later
  - Provider tests. Mongo tests should be skipped unless a Mongo URI is configured, or use a controlled local/test container only if the project permits it.

## 13. Regression/Integration Tests

Provider contract tests:

- Register Mongo entity through EntityManager.
- Add/get/find/update/delete through EntityManager only.
- `count()` returns DB-backed count.
- Normal CRUD responses do not expose collection name, model name, provider physical identity, Mongo ObjectId, or Mongoose document internals.
- Diagnostics expose logical and physical provider identity only through internal diagnostic operation.

Identity tests:

- Add record with explicit Xpell `_id`; get by that `_id`.
- Add record without `_id`; provider assigns Xpell GUID string.
- Restart/recreate provider; records remain readable by Xpell `_id`.
- Mongo ObjectId is not exposed as public identity.

Scope tests:

- `app-a/users` and `app-b/users` have separate model names and collection names.
- Same app in different environments is isolated.
- `server` scope is shared across apps.
- `global` scope remains shared by logical entity id.

Schema/index tests:

- Required fields.
- Defaults.
- Unique index conflict.
- Normal index creation.
- Unsupported `Vector`, `Matrix`, and `File` fields fail clearly in V1.
- Hash field writes store bcrypt hash, not plaintext.

Query tests:

- Equality.
- Comparison operators.
- `_in`.
- `_contains` on indexed string.
- Sort ascending/descending.
- Skip/limit pagination with large dataset, verifying Mongo does the paging.
- Unsupported operators return structured errors.
- Raw Mongo operators are rejected.

Hash tests:

- `_hash_filter` verifies bounded candidate set.
- Unbounded hash verification returns structured error.
- Non-Hash field in `_hash_filter` returns structured error.

Connection lifecycle tests:

- Reuse connection across two providers.
- Provider dispose does not close shared connection while another provider is active.
- Server shutdown closes connections.
- Missing/invalid connection settings fail registration deterministically.

XDBObject compatibility tests:

- Existing public `XDBObject.add/search/searchArray/findById/update/delete` wrappers still return `XResponse` envelopes.
- New raw methods return raw values and throw errors.
- Existing ObjectId-oriented consumers are not broken unless explicitly migrated.

## 14. Risk Matrix

| Risk | Severity | Impact | Mitigation |
| --- | --- | --- | --- |
| Public identity accidentally becomes Mongo ObjectId | High | Breaks provider portability, relationships, and migrations. | Preserve Xpell GUID `_id`; test no ObjectId exposure. |
| Nested response envelopes | High | Breaks EntityManager response shapes. | Provider calls raw helpers only; EntityManager wraps. |
| Global Mongoose model collisions | High | Two scoped apps can share model/schema by name. | Use connection-scoped `connection.model(modelName, schema, collectionName)` with encoded physical identity. |
| Raw Mongo query exposure | High | Bypasses portable contract and can create security/performance issues. | Translate only supported query subset; reject unknown `$` operators. |
| Unbounded bcrypt scans | High | Login/verification can become expensive and leak timing/performance behavior. | Require bounded candidate sets, unique lookup first, or max candidate cap. |
| Schema mismatch between XDB and Mongoose | Medium | Invalid indexes, wrong validation, hash fields not hashed. | Provider-owned schema translator with explicit unsupported errors. |
| Connection secrets in entity definitions | Medium | Leaks secrets into app JSON and ServerXVM persistence. | Use named connections resolved from settings/env. |
| Index sync in production | Medium | Startup latency or destructive index changes. | Gate `syncIndexes()` behind explicit setting. |
| Existing XDBObject consumers break | Medium | Backward compatibility regression outside EntityManager. | Preserve public envelope methods and add raw methods rather than replacing them. |
| Transactions reported incorrectly | Medium | False safety guarantees. | Capability true only when connection/deployment supports sessions/transactions. |
| Serialization drift | Medium | Dates/ObjectIds/Mongoose docs differ from XDB/SQLite. | Normalize records through provider serializer and parity tests. |

## 15. Recommended Implementation Phases

Phase 0: Contract preparation

- Add `"mongo"` to provider type only when implementing the provider.
- Add Mongo provider capability definitions.
- Decide settings shape for named Mongo connections.

Phase 1: XDBObject raw API

- Add raw/internal methods with raw return values and thrown errors.
- Preserve existing public `XResponse` wrapper methods by delegating to raw methods.
- Add tests for old envelope methods and new raw methods.

Phase 2: Connection manager

- Add named connection resolver using `XSettings` and environment values.
- Use connection-scoped model creation.
- Add lifecycle tests.

Phase 3: MongoEntityProvider V1

- Implement schema translation for supported field types.
- Implement add/get/find/count/update/delete.
- Implement provider result shape.
- Implement structured errors.
- Keep no raw Mongo filters or pipelines.

Phase 4: Scope and identity verification

- Test app/env/server/global physical identity mapping.
- Confirm model and collection isolation.
- Confirm public responses remain logical.

Phase 5: Hash and query hardening

- Add bounded hash verification.
- Add query parity tests against XDB/SQLite portable subset.
- Add large-record pagination test proving Mongo-side skip/limit.

Phase 6: Optional capability expansion

- Native Mongo aggregation capability.
- Transactions with sessions.
- Text search.
- File/vector storage strategy.
- Migration tooling from XDB/SQLite to Mongo.

## 16. Final Recommendation

Recommended path: **reuse `XDBObject`, wrap it with `MongoEntityProvider`, and lightly refactor `XDBObject` to expose raw/internal primitives**.

Do not replace `XDBObject`; it already contains useful Mongoose model, index, hash, and aggregation code. Do not wire it directly into EntityManager either; its current public methods return `XResponse` envelopes, mutate input `_id`, rely on global Mongoose models, and assume Mongo identity behavior.

The right boundary is:

- EntityManager: public command API, app/env registration, physical identity resolution, response envelopes.
- MongoEntityProvider: provider contract, schema/query translation, capability checks, hash verification, result normalization.
- XDBObject: low-level Mongoose object/model helper with raw methods and preserved legacy envelope methods.

This keeps Mongo replaceable, preserves existing application behavior, and avoids leaking Mongo-specific behavior into normal EntityManager commands.
