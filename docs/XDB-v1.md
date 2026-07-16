# XDB v1

**XDB v1** is a storage-agnostic, embedded database engine designed for the **Xpell runtime**.

It provides **entity-based data management**, optional **vector & semantic support**, and **pluggable persistence**, while keeping all core logic deterministic and in-memory.

---

## Goals

XDB v1 is designed to:

- Be **runtime-embedded** (not a standalone server)
- Support **real-time entity creation**
- Separate **engine logic** from **storage**
- Enable **AI / vector workflows** without hard dependencies
- Integrate cleanly with **XModule / XObject**

---

## Architecture

```
┌─────────────┐
│  XDBEngine  │  ← Core logic (filters, vectors, semantic ops)
└─────┬───────┘
      │
┌─────▼─────────────────────┐
│        IXDBStorage         │  ← Persistence contract
│  (FS / SQLite / Mongo…)    │
└─────┬─────────────────────┘
      │
┌─────▼──────────┐
│   XDBEntity    │  ← Dynamic entities
│   XDBVector    │
│   XDBFile      │
│   XDBTemp      │
└────────────────┘
```

---

## Core Concepts

### XDBEngine
- Owns **query logic**, **vector handling**, and **semantic search**
- Does **not** know how data is persisted
- Uses injected providers for:
  - Embeddings
  - Vector search (MAT / ANN / external engines)

### IXDBStorage
Pluggable storage adapter.

Examples:
- `XDBStorageFS` (filesystem)
- `XDBStorageSqlite` (embedded production storage)
- Future: Mongo, Graph, Remote

### XDBEntity
- Schema-driven dynamic entities
- Created at runtime
- Fully managed via Xpell’s `XObjectManager`

### EntityManager Storage Scope

EntityManager registrations are app-scoped at runtime by:

```text
<env>::<app-id>::<entity-id>
```

Entity definitions may optionally choose a storage provider and scope:

```json
{
  "_storage": {
    "_provider": "xdb",
    "_scope": "app"
  }
}
```

Defaults preserve existing behavior:

- Missing `_storage._provider` resolves to `xdb`.
- Missing `_storage._scope` resolves to `global`.

Supported providers:

- `xdb`: current durable XDB-backed entity storage.
- `memory`: volatile process-local entity storage. Records, indexes, and Hash field values exist only inside the provider instance and are lost when the provider is recreated or unregistered. The memory provider does not write records, schemas, indexes, files, vectors, temp data, or metadata to the XDB filesystem, SQLite XDB documents, or server settings.
- `sqlite`: record-level SQLite entity storage. Records are stored as SQLite rows in provider-owned tables, not as the existing XDB whole-entity `_data` JSON document.

EntityManager owns command routing, app/environment resolution, logical entity identity, provider selection, response envelopes, and provider lifecycle. Provider implementations own storage behavior, schema translation, query translation, hash verification, capabilities, validation, and persistence details. Provider construction is centralized in the internal EntityProvider registry so EntityManager does not import or branch on concrete provider classes.

Supported scopes:

- `global`: physical identity is the logical entity id, for example `users`.
- `app`: physical identity is scoped by environment and app, for example `<env>::<app-id>::users`.
- `server`: physical identity is shared across apps on the server, for example `server::users`.

EntityManager owns scope resolution. XDB receives only the resolved physical entity name and does not interpret app or environment semantics. Physical names are encoded when needed so scoped identities are safe for filesystem and SQLite-backed storage paths; callers continue to use logical entity ids such as `users`.

All XDB resources for an EntityManager-backed entity use the same resolved physical entity name:

- record data
- schema
- indexes
- vectors
- files
- temp storage
- metadata

Backward compatibility is intentional: existing global XDB records are not automatically migrated or used as fallback records for app-scoped or server-scoped entities. Apps that omit `_storage._scope` continue to read and write the current global physical entity name.

Normal CRUD responses intentionally do not expose this implementation detail. Use the internal `entity-manager` operation `storage-diagnostics` when debugging the current logical-to-physical mapping.

Memory-backed entities support the core EntityManager operations (`register`, `add`, `get`, `find`, `update`, and `delete`), schema validation, unique fields, in-memory indexes, Hash fields, and common logical query operators. They intentionally do not support persistent storage, XDB files, XDB vectors, XDB temp storage, or transactions.

SQLite-backed entities use EntityManager's resolved physical identity to choose a provider table namespace. By default the provider database is:

```text
<work_folder>/xdb/entity-provider.sqlite
```

The provider owns:

- `entity_provider_meta`: logical/physical identity, provider metadata, schema JSON, and table name.
- `entity_provider_indexes`: declared indexed fields and unique/required metadata.
- one record table per physical identity, with `_id`, `_created_at`, `_updated_at`, `_json`, and separate SQLite columns for indexed fields.

The public record identity remains the Xpell GUID `_id`; SQLite row order or row ids are never public identity.

SQLite provider foundation support currently includes:

- `init`
- schema synchronization
- `add`
- `get` by `_id`
- filtered `update`
- filtered `delete`
- SQL-backed `find` over `_id` and indexed fields
- `count` without loading records
- `sum` aggregation through the generic EntityManager aggregation contract
- unique indexes and SQLite transactions for writes

Supported SQLite query matrix:

| Behavior | Supported | Notes |
| --- | --- | --- |
| Equality | yes | `_id`, `_created_at`, `_updated_at`, and indexed schema fields. |
| Comparison | yes | `>`, `>=`, `<`, `<=`, `_gt`, `_gte`, `_lt`, `_lte` on indexed fields with compatible SQLite column types. |
| Inclusion | yes | `_in` on indexed fields. Empty `_in` returns no rows. |
| Contains | partial | `_contains`, `_starts_with`, `_starts`, `_ends_with`, and `_ends` on indexed text fields only. Hash fields are excluded. |
| Sorting | yes | `_created_at`, `_updated_at`, `_id`, and indexed fields. |
| Limit/skip | yes | Applied by SQLite using `LIMIT` and `OFFSET`. |
| Count | yes | Uses SQLite `COUNT(*)`; it does not load rows. |
| Unsupported operators | rejected | Returns structured `E_ENTITY_SQLITE_QUERY_UNSUPPORTED` errors. |

SQLite provider capability metadata reports:

- `hash-verification`: supported with bounded result sets only.
- `aggregation`: supported for `sum` over caller-provided record arrays.
- `transactions`: supported for writes.
- `persistent-storage`: supported.
- `query-operators`: supported for the matrix above.
- `runtime-entity-handle`: supported for diagnostics.
- `physical-unregister`: unsupported; unregister closes the provider and preserves tables.

SQLite provider limitations in this phase:

- Query filters are limited to `_id` and schema fields declared with `_index`.
- Array and Object fields are JSON-serialized in `_json` but cannot be indexed or queried directly in this phase.
- Hash verification is applied only after SQL filters and refuses result sets larger than the provider's bounded verification limit.
- Files, vectors, temp storage, and XDB whole-document migration are not implemented for the SQLite provider.
- Unsupported schema field types and unsupported query operators return structured provider errors.

### Explicit Global-to-App Migration

XDB v1 does not migrate legacy global entity records during normal application loading. Operators must use explicit EntityManager migration operations:

- `storage-migration-dry-run`
- `storage-migrate` with `_mode: "copy"` or `_mode: "move"`
- `storage-migration-diagnostics`

Dry run returns a structured `_migration` report containing:

- `_global_entity_name`
- `_global._record_count`
- `_global._schema`
- `_definitions` for apps/environments that define the logical entity
- `_target._physical_identity` and `_target._physical_entity_name`
- `_schema_differences`
- `_uniqueness_conflicts`
- `_ambiguous_ownership`
- `_conflicts`
- `_warnings`
- `_migration_readiness`

Ambiguous migrations are blocked unless the operator explicitly supplies `_target_app_id`, `_target_env`, and `_target_entity_id`.

`copy` writes the target app-scoped physical entity and leaves the global source intact. `move` first creates an XDB object-store backup, writes and verifies the target, and only then deletes the source physical entity. Conflicting records are never merged silently. If the target already contains the same migrated records, the operation reports `already_migrated` instead of duplicating data.

Backups are stored in the XDB object store with `_type: "entity-migration-backup"` and include the source payload plus copied file/vector/temp resources. If a `move` migration fails after the backup is created, EntityManager attempts rollback by restoring the source payload/resources and removing a partially written target. The failed report includes `_backup`, `_rollback`, and `_error`.

`storage-migration-diagnostics` is an internal administrator/test operation. It lists legacy global XDB entities, app-scoped XDB entities registered in EntityManager, and per-target migration status. Normal CRUD responses continue to use logical entity ids and do not expose physical storage names.

---

## Embeddings & Vectors

XDB v1 does **not** hard-code any AI provider.

Embedding and vector search are injected via:

- `IXDBEmbeddingProvider`
- `IXDBVectorQueryProvider`

This allows:
- OpenAI / Azure / local models
- Text, image, or custom embeddings
- Offline or internal vector engines

---

## Versioning

This is **XDB v1**.

Guarantees:
- Stable contracts
- No breaking changes inside v1.x
- Storage adapters remain compatible

Breaking architectural changes will result in **XDB v2**.

---

## Non-Goals (by design)

XDB v1 is **not**:
- A distributed database
- A graph database
- A SQL replacement
- A standalone service

Those are future versions.

---

## Status

**Production-ready (v1)**  
Actively evolving inside the Xpell ecosystem.
