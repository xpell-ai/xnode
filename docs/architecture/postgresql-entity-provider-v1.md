# PostgreSQL EntityProvider P1

Status: implementation candidate; owner acceptance and merge pending. The narrow owner-approved Unicode compatibility exception below is part of this candidate contract. This contract extends [EntityProvider Portable V1](./entity-provider-portable-v1.md). It adds generic PostgreSQL row persistence, not an ORM or an application-specific repository. Existing hosts without PostgreSQL native options keep their existing provider defaults and SQLite behavior.

## Native configuration and placement

Registry name: `postgresql`. Configuration is trusted native startup data, never entity JSON, command parameters, transport metadata, Settings mutations or a model tool. `XNodeOptions._entity_postgresql` accepts `PostgreSQLRuntimeOptions`. Direct EntityManager owners can pass an opaque `createPostgreSQLRuntime(options)` handle as `_provider_runtime_context._postgresql` and explicitly close it when their owned runtime ends.

### Required application startup

For XNode hosts with explicit PostgreSQL placements, the placed entities are required at startup. Provision their validated app/entity artifacts before `XNode.start()`; registering them only after successful startup cannot satisfy readiness. Direct EntityManager owners still control their own registration/initialization lifecycle.

XNode supplies a trusted native registration-response guard to ServerXVM. A failed response for a required PostgreSQL application/placement aborts loading before that app bundle is published, including trusted older artifacts whose declared provider remains SQLite. Before `_started`, MCP Ready or `server:started`, the owned EntityManager also verifies that every explicit placement has a registered PostgreSQL provider and freshly verifies its store/schema. Missing apps/entities and ignored or incomplete registrations cannot produce Ready. Failure uses the existing owned-resource cleanup path; connections, core execution and listeners are closed.

The guard is native-only, not an operation/model tool or persisted app field. It preserves existing response behavior for SQLite-only hosts and unrelated applications; it does not turn legacy errors into a new global startup policy. Applications without PostgreSQL native options keep their existing behavior.

Each named connection requires:

- `_connection_string_env`: explicit environment-variable reference. No guessed URI or PG environment-variable fallback. The URI must contain host, user, password and the same database as `_database`; URI query parameters are rejected, including SSL overrides.
- `_database`, `_schema`: explicit lower-case identifiers matching `[a-z][a-z0-9_]{0,62}`.
- `_expected_store_id`: preauthorized immutable store UUID, separate from logical record IDs.
- `_expected_inventory_sha256`: hash returned by `postgresqlInventory(entities)._sha256` for the qualified logical inventory.
- `_expected_schema_version`: 1 by default, or explicitly 2 after the reviewed metadata upgrade.
- `_tls`: `_mode: "verify"` with certificate/hostname verification and optional `_ca_file`. `_mode: "isolated-loopback"` is an explicit synthetic-test exception for literal loopback IPs only.
- Optional `_pool` and `_timeouts` within the finite bounds below. Unknown connection/pool/timeout/TLS properties reject rather than silently selecting defaults.

`_placements` select exact normalized app/env/entity allowlists and a named connection. `_scope` defaults to `app`; explicit server/global scopes reuse the existing identity contract. A selected app/env cannot split its entities across different stores. Unmapped or contradictory registration in that app/env rejects. Ordinary unrelated hosts/scopes retain their legacy defaults; PostgreSQL is never inferred because a database is unavailable.

An immutable older artifact may retain `_storage._provider: "sqlite"` only when trusted placement explicitly provides `_accepted_artifact_provider: "sqlite"` and the exact canonical definition hash in `_definition_sha256`. This changes effective placement, not the original definition/schema or existing SQLite data. Conflicting per-entity connection/path options reject. Provider/store rebinding of a registered PG entity rejects before disposing its working provider.

Example native configuration, using the existing identity utility rather than a new scope algorithm:

```ts
import { postgresqlInventory, resolve_entity_scope_identity } from "@xpell/node";

const definition = {
    _id: "notes",
    _storage: { _provider: "postgresql", _scope: "app" },
    _schema: { title: { _type: "String", _required: true, _index: true } }
};
const entities = [{
    _definition: definition,
    _physical_identity: resolve_entity_scope_identity({
        _provider: "postgresql", _app_id: "example", _env: "test", _entity_id: "notes"
    })
}];
const connection = {
    _connection_string_env: "EXAMPLE_PG_RUNTIME_URI",
    _database: "example_store", _schema: "xpell",
    _expected_store_id: "00000000-0000-4000-8000-000000000001",
    _expected_inventory_sha256: postgresqlInventory(entities)._sha256,
    _tls: { _mode: "verify" as const, _ca_file: "./certificates/example-ca.pem" }
};
const nativeOptions = {
    _connections: { primary: connection },
    _placements: [{ _app_id: "example", _env: "test", _entities: ["notes"], _connection: "primary" }]
};
// After separate explicit one-time initialization, pass nativeOptions to
// XNode.start({ _entity_postgresql: nativeOptions, ...otherOwnedOptions }).
```

The secret reference resolves only in the trusted process. The example UUID is a placeholder for the store identity authorized by its owner, not a value to reuse across installations. Initialization uses a separate maintenance secret reference and the same expected identity/inventory; ordinary startup never calls initialization.

## Store initialization and versioning

Provision a separate dedicated database and non-superuser schema-maintenance role using the host's approved operations process. The runtime role is separate: no ownership, superuser, CREATE/TEMP, role escalation, replication, bypass-RLS, TRUNCATE or trigger/DDL permissions. Initialization grants only schema usage, required entity DML and metadata reads; append-only entity roles receive SELECT/INSERT only.

`initializePostgreSQLStore({ _connection, _runtime_role, _entities, _authorize_empty_store: true })` is a native one-time operation. It verifies the pinned engine/durability, refuses an existing target schema or user relation, takes a database/schema-specific exclusive advisory transaction lock, then atomically creates tables, guards, inventory, immutable store identity and version/checksum receipts. It does not create databases, seed business data, adopt an unknown store, or replace missing data.

Ordinary `init()`/`syncSchema()` verify identity, inventory, exact logical definition/layout, executed migration checksums, generated DDL-plan hash, physical columns/indexes/constraints/trigger functions and role restrictions. They issue no DDL or repair. Partial/wrong/mismatched stores reject. A changed entity definition requires a separately reviewed schema migration; re-registration never silently evolves it.

Physical verification also checks operational catalog state independently of deparsed DDL hashes. Each entity table **and** `ep_store`, `ep_migrations`, `ep_entities` must be an ordinary permanent logged relation. Their indexes must be valid, ready for writes, live, and permanent. User protection triggers must retain the qualified normal (`O`) activation mode. Disabled, replica-only or otherwise changed activation states fail closed. This includes initialized providers on subsequent operations and the maintenance migration verification path; no automatic repair/adoption is performed.

PostgreSQL's deparsed index/trigger definitions do not substitute for these catalog flags: see [pg_trigger](https://www.postgresql.org/docs/17/catalog-pg-trigger.html), [pg_index](https://www.postgresql.org/docs/17/catalog-pg-index.html), and [pg_class](https://www.postgresql.org/docs/17/catalog-pg-class.html). The existing structural digest format is retained; healthy previously initialized P1 candidate stores are not automatically rewritten. These are readiness/operation checks, not a new concurrent-maintenance fencing or HA guarantee.

The initial `migratePostgreSQLStore` supports exactly the reviewed v1→v2 metadata-format upgrade (adding migration-description metadata), under separate native maintenance ownership. It verifies the source inventory/physical fingerprints, executes versioned SQL and writes its checksum/version in one transaction. Tests cover interruption after actual DDL and lost acknowledgement after actual COMMIT. Arbitrary entity schema transformations, caller-authored SQL, automatic down migrations and business-data conversion are unsupported. Add future schema evolutions as reviewed versioned migrations; do not misuse `syncSchema`.

Hashes serve distinct purposes: canonical logical-definition/layout/inventory hashes; the hash of the exact versioned migration SQL with a stable namespace token; per-entity generated DDL-plan hash; and a PostgreSQL catalog fingerprint of installed columns/indexes/constraints/triggers/functions. Both expected code plan and actual physical state must match. Full physical identity is retained and checked against bounded SQL object names; SQL identifier collisions fail closed.

## Value and query behavior

Protection flags and index option flags must be Boolean, and `_id` must use String or ObjectId; unsupported schema flags/types reject explicitly.

The authoritative record is the normalized JSON serialization in TEXT. It is not converted through JSONB. Optional absence and explicit null remain distinct in JSON even when both project to SQL NULL. Arrays/objects retain existing JSON round-trip behavior; no nested query language, native PG-array mapping or inferred nested-field schema is introduced.

| Logical type | Projection / behavior |
| --- | --- |
| String/ObjectId/legacy `_id` | BYTEA key using fixed versioned WTF-8, including embedded NUL and lone UTF-16 surrogates; original string retained in JSON; SQLite exception below applies |
| Date/timestamps | Same ISO UTC millisecond string as existing normalization, projected as bytes; no implicit pg timestamp parser/timezone conversion |
| Number | Finite JS binary64 / DOUBLE PRECISION; reject NaN/Infinity and values normalized to them; preserve finite fractions and declared bounds |
| Boolean | Native BOOLEAN with existing accepted Boolean normalization |
| Array/Object | JSON document plus serialized projection for required/immutable guards; unsupported indexed arrays/objects reject |
| Hash | Existing bcrypt policy, cost 10 and pre-hashed-prefix behavior; prepare outside write transaction; verify at most 25 candidates and redact Hash fields in verification results |

Unrecognized top-level fields reject explicitly. Required/default/enum/pattern/length normalization follows the declared supported schema; update rejects immutable or null/undefined update fields. Financial safe-integer arithmetic remains the consuming application's contract; no suffix-based BIGINT conversion, new currency arithmetic or parseFloat of PG bigint/numeric results is introduced. Exact count text is converted only within the JS safe-integer range.

### Unicode compatibility exception

On 25 November 2026, the accountable owner explicitly deferred SQLite equality/order/uniqueness parity **only for string keys containing unpaired UTF-16 surrogate code units**. Native better-sqlite3 12.11.1 encodes these differently across the qualified Node22/24 versions. This is a recorded compatibility exception, not a SQLite fix or a cross-backend migration guarantee.

PostgreSQL continues to use one fixed versioned WTF-8 codec on both Node versions. A lone high surrogate projects to `EDA080`, a lone low surrogate to `EDB080`, and U+FFFD to `EFBFBD`; these remain distinct full values. JSON roundtrips preserve the original code units. There is no Node-dependent codec, replacement normalization, silent rejection or Node22-only restriction. Real PG tests must prove exceptional IDs/value roundtrips, exact queries, ordering, duplicate rejection and reopening on both qualified Node versions.

Well-formed Unicode, embedded NUL and all other supported value/constraint contracts retain their parity requirements. The deferred cross-backend assertion is retained as an explicitly skipped named test and must never be reported as PASS. Any future SQLite/PostgreSQL migration involving malformed Unicode must resolve this difference explicitly before conversion; this phase authorizes neither SQLite changes nor an implicit conversion policy.

Portable filters are AND-of-indexed-scalar fields: equality, `=`, `_eq`, `_equals`, comparisons and aliases, and `_in`. Runtime ID/timestamp fields are queryable. Unknown operators, SQL fragments, joins, unsupported field types and unindexed field filters reject. Null equality uses IS NULL; `_in` normalization follows the existing SQLite behavior, including null inputs. SQLite contains/starts/ends aliases are unsupported PG extensions in P1; there is no fallback.

Pagination remains SQL-side `_skip`/`_limit` with default limit 100000, exact independent total and existing response envelopes. Count and page share one read-only REPEATABLE READ snapshot. Sort uses `_sort_by` / `_sort_order`; default is creation time, with `_reverse_order` supported. NULLS FIRST ascending / NULLS LAST descending preserves SQLite value ordering. PG adds `_id` in the same direction as a unique secondary key. Historical SQLite tie order is unchanged and not claimed identical. Stable offset pages require an unchanged dataset; concurrent cursor/snapshot pagination is outside this contract.

## Native constraints and operation atomicity

Every write is one bounded SERIALIZABLE transaction on one checked-out client. Required scalar projections, finite numeric bounds, primary physical row keys, native unique scalar indexes where bounded, immutable projections and append-only guards are enforced in PostgreSQL as applicable. Public identity remains logical `_id`; an internal UUID row key is never returned as record identity.

Unbounded byte keys use a fixed-width SHA-256 expression index for candidate lookup. A database constraint trigger then compares the full byte values; digest equality alone never establishes uniqueness. Every native insert/update/delete must be SERIALIZABLE with synchronous_commit on. SSI protects concurrent absent-value checks; duplicate or conflicting writers abort as a whole. Tests inject a constant digest into the otherwise same native guard, proving distinct full values remain distinct and concurrent duplicates cannot both commit. No input is truncated to fit a B-tree, and no process-local uniqueness cache substitutes for database enforcement. Range queries may scan full projections; no unmeasured performance guarantee is made.

Append-only UPDATE/DELETE rejection persists in triggers, with runtime TRUNCATE/DDL/trigger privileges withheld. All document/projection/index changes in an operation commit together. No client results or manager success notifications precede confirmed commit. There are no hidden retries.

## Pool ownership and failures

One runtime-owned pool serves all entities with the same exact trusted connection/store policy; identical aliases share it. Pool configuration is copied/resolved once, and the opaque public handle exposes only diagnostics and close. No client, pool, SQL callback or transaction API is exported through that handle or EntityManager.

| Setting | Default | Allowed range |
| --- | --- | --- |
| Pool max / min | 10 / 0 | max 1–64; min fixed 0 |
| Waiting requests | 32 | 0–256 |
| Acquisition / connect | 5000 / 5000 ms | 1–60000; connect capped by acquisition |
| Statement and complete provider-transaction deadline | 5000 ms | 1–60000 |
| Lock | 1000 ms | 1–60000 |
| Idle transaction | 5000 ms | 1–60000 |
| Idle connection | 30000 ms | 1–300000 |
| Shutdown drain | 10000 ms | 1–60000 |

Admission is bounded before pg's queue. Expired/late checkouts are destroyed, with client and queue accounting settled once. Both idle and checked-out connection errors are handled. Every checkout sets/verifies safe session configuration, immutable store/schema/inventory, engine/durability and runtime privileges. Replacements repeat those checks; unavailable never becomes an empty result.

Provider disposal preserves data and sibling entities. Native owner close stops admission, drains once and bounds stuck operations. XNode closes only its own runtime on stop or startup failure. Direct manager owners explicitly call `closePostgreSQLResources()` or close their own handle; a global Mongo/SQLite/application store is never closed as a side effect.

Stable sanitized `E_ENTITY_POSTGRESQL_*` errors cover config/placement, unavailable, identity/schema/migration, validation/constraints, conflicts/timeouts and uncertain writes. Driver URIs, parameters, PostgreSQL detail, passwords and raw causes are not forwarded. A lost acknowledgement after COMMIT submission is `WRITE_UNCERTAIN`; do not infer rollback or retry. Business receipt/reconciliation, qualified atomic units, ownership fencing, backup/restore and release activation remain separate acceptance work.

## Capability matrix

Supported after qualification: persistent storage, exact count, server-side pagination, unique scalar constraints/indexes, operation-atomic writes, bounded Hash verification, portable operators and existing in-memory `sum` aggregation.

Unsupported in P1: application-controlled transactions, app-local atomic units, runtime entity handles/raw clients, physical deletion on unregister, arbitrary SQL and unsupported query extensions. P1 alone does not qualify an atomic financial application or multi-instance writer profile.
