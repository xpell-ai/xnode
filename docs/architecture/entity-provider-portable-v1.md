# EntityProvider Portable V1 Contract

EntityManager remains the public application boundary. It resolves logical identity, app/environment scope, provider selection, lifecycle, and `XResponseOK` / `XResponseError` envelopes. Entity providers return raw provider values behind that boundary.

The default provider is `xdb`, and the default storage scope is `app`. An entity artifact with no `_storage` block therefore keeps the current XDB-backed app-scoped behavior. Provider changes never copy, merge, fall back, or dual-write records.

## Portable required behavior

The reusable conformance suite covers:

- generated GUID `_id` values and preservation of caller-supplied legacy ids;
- normalized `_created_at` and `_updated_at` values;
- `add`, `get`, `find`, `count`, `update`, and `delete`;
- indexed scalar equality, comparisons, and `_in`;
- explicit sort, limit, skip, and combined filter/sort/pagination;
- exact count independent of find page limits;
- schema-declared unique scalar fields on add and update;
- clear rejection of unsupported query operators;
- durable provider recreation for XDB and SQLite, and intentional non-persistence for Memory;
- EntityManager response envelopes and result shapes.

Providers may retain extensions beyond this subset. XDB remains fully materialized and uses its existing query engine. Memory remains process-local. SQLite remains row-backed and queries only `_id`, timestamps where supported, and indexed scalar fields. Mongo translates the portable subset to Mongo operations but still requires deployment-backed integration verification.

## Capability terminology

- `transactions` means an application-controlled transaction boundary. No current EntityProvider exposes that API.
- `operation-atomic-writes` means a single provider method is internally atomic. SQLite advertises this because each write method uses an internal SQLite transaction.
- `app-local-atomic-unit` is an optional SQLite extension, separate from portable CRUD and `transactions`. It requires a trusted EntityManager binding as described below.
- `server-side-pagination` means skip/limit are applied inside the server-side provider rather than by EntityManager.
- `exact-count` means count is independent of normal find limits.
- `unique-scalar-indexes` covers per-field scalar uniqueness only. It does not promise compound, array, or object indexes.

SQLite continues to reject indexed Array and Object fields. The portable contract does not add joins, full-text search, compound indexes, array indexes, or a transaction API.

## Opt-in app-local atomic units (XNet Phase 1D-B1)

The public Node entrypoint exports `bindEntityLocalUnit`, `EntityLocalUnit`, `EntityLocalUnitBinding` and `BoundEntityLocalUnit`. Trusted server bootstrap calls the factory **after entity registration** with one fixed native `(_env, _app_id)`, an allowlist of entity IDs and explicit per-entity write permission. All providers must be SQLite/app-scoped in one physical database. The factory pins registration/schema identity and checks a real WAL/FULL/foreign-key writer before returning a bound `commit(unit)` function. No remote operation provisions bindings. This is not an arbitrary transaction callback, SQL interface or cross-application transaction facility.

The bound function routes data through `_x.execute({ _module: 'entity-manager', _op: 'commit-local-unit', ... })`. Its ephemeral authority key stays in the closure; it is never persisted. The operation rejects transport `_ctx` even with a genuine key, absent/unknown authority, arbitrary scope selectors and unbound entities. It is deliberately absent from the general/model skill catalogue. Default runtimes provision no such authority. Callers must not publish the bound function through an Agent tool or gateway.

A unit has a GUID `_unit_id`, one to eight distinct fixed-ID `_records`, optional exclusive `_valid_until`, and an optional fixed Pulse-style owner/epoch/version/lease guard. Each record may assert its full normalized `_expect` snapshot (or absence), create with `_expect: null`, update with an exact existing snapshot, or read without mutation. There are no query expressions, deletes or per-record app/database selectors. At most four records may mutate, and commands are bounded to 64 KiB / depth 24. Unknown fields, lossy coercion/truncation, non-JSON values and write schemas containing Hash fields are refused. Existing ordinary CRUD retains its normalization behavior.

One provider-owned `BEGIN IMMEDIATE` transaction rechecks schema metadata, every expected record, current trusted clock/lease and affected counts, then writes records and SQL indexes together. No await or external call occurs while the transaction is held. One private SQLite connection is opened with verified WAL/FULL/foreign keys and closed in `finally`; legacy provider connections remain WAL/NORMAL. Notifications follow commit only. The returned XResponse contains `_records` and checked `_durability`; a response/notification failure cannot undo a commit. Create conflicts never overwrite a record: the owning Pulse repository reconciles equivalent event/receipt replays using consistent reads and immutable identity, without a generic unit-log table.

SQLite entity artifacts may explicitly set `_storage._append_only: true` for completion receipts. Provider checks and persistent SQLite UPDATE/DELETE rejection triggers enforce this rule, including after restart; schema synchronization refuses dropping the flag on an existing protected table. This flag is SQLite-specific, not a general authorization system. B1 artifacts are installed only into disposable native Business Apps; existing application schemas/default installation do not change.

The B1 consumer remains synthetic/test-only. Process-kill tests establish rollback/restart/replay behavior; WAL/FULL configuration does not make those tests proof of operating-system/power-failure recovery, storage synchronization behavior, disk-loss recovery or HA. Production qualification and backup remain separate.

## Runtime context

Provider construction may receive an optional XNode-owned runtime context containing `_work_folder` and the optional trusted `_sqlite_require_full_durability` policy. XNode supplies it to EntityManager, and EntityManager passes it through the existing built-in registry. SQLite uses it to resolve the default provider database at `<work_folder>/xdb/entity-provider.sqlite`; it no longer reads private XDB initialization state. Existing direct provider constructors remain valid, and an explicit SQLite `_db_path` still takes precedence.

## Backup boundary

Storage providers own storage-specific backup mechanics. Deployment and operations own backup policy, scheduling, retention, and cross-provider coordination. SQLiteEntityProvider does not currently expose a production backup contract. This is deferred and is not part of portable V1 conformance.

## Deferred

- external provider registration;
- provider backup APIs;
- Postgres and MySQL providers;
- compound, array, full-text, and other advanced indexes;
- TTL and atomic counters;
- automatic or implicit provider migration.


## Server-owned SQLite durability opt-in (Pulse hardening, 2026-11-04)

`XNode.start({ _entity_sqlite: { _require_full_durability: true } })` forwards an immutable policy through EntityManager's provider runtime context to all row-backed SQLite connections it owns. A directly constructed EntityManager may set `_provider_runtime_context: { _work_folder, _sqlite_require_full_durability: true }`. These are native trusted construction/startup options; no entity artifact, model tool, registration parameter or remote operation sets the policy. They are separate from `_xdb` whole-entity storage options.

The opt-in sets and reads back WAL, synchronous FULL (2), foreign keys ON (1) and the existing 5000ms busy timeout on each ordinary provider connection before schema initialization. Failure closes the handle and refuses registration (`E_ENTITY_SQLITE_DURABILITY`); it never falls back to NORMAL. Debug stats expose effective `_sqlite_pragmas`. Existing connections retain their startup policy; changing a caller's options object cannot downgrade them. The existing bounded local-unit writer still uses its private verified FULL connection and unchanged immediate transaction/busy behavior. Ordinary CRUD transaction semantics are unchanged.

Unrelated hosts remain WAL/NORMAL by default. Existing schema/data/table identity is unchanged and no migration is performed. FULL applies on every writing connection, not persistently to the file or automatically to external tools. Readiness requires every registration response to succeed; a generic host must not ignore registration errors.

Process-kill recovery tests are distinct from OS/power failure. WAL/FULL requests SQLite synchronization for acknowledged commits, contingent on the filesystem/storage correctly honoring sync. It does not protect against disk loss, filesystem defects, simultaneous application workflow races, or external effects not atomically committed with SQLite. Use local persistent storage, one application owner where required, and independently verified encrypted off-volume backups. This opt-in adds no general transaction, provider backup API, or multi-instance framework.
