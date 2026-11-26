# PostgreSQL bounded EntityLocalUnit P2

Implementation candidate for owner review, based on integration commit `82d54ed5887b5d77637ae3418bc0f1a351f719bf`. The [approved detailed contract](./postgresql-entity-local-unit-p2-plan.md) and [qualification procedure](./postgresql-entity-local-unit-p2-qualification.md) distinguish design approval, executed evidence and implementation acceptance.

## Native binding

Reuse `bindEntityLocalUnit` after successful entity registration. Entities must be genuine supported providers in one app/environment and physical store. A capability string alone grants no authority. SQLite delegates to its existing executor; PostgreSQL uses a fixed internal unit kernel behind the existing manager/XCommand boundary.

```ts
const bound = await bindEntityLocalUnit({
  _app_id: "example", _env: "test",
  _entities: [{ _entity: "effects", _write: true }, { _entity: "receipts", _write: true }],
  _durability_contract: "provider-neutral-v1",
  _capacity_profile: "expanded-v1"
});
```

PostgreSQL requires explicit new-contract selection. Bootstrap verifies the complete returned descriptor/capacity before admission; accepting an option or reporting a version is insufficient. No transport/model command provisions bindings. Remote `_ctx`, unknown parameters, forged keys and unbound/read-only writes fail closed.

The unit DTO remains closed: GUID `_unit_id`, fixed entity/GUID records with full `_expect`, `_create` or `_update`, existing `_lease` and `_valid_until`. No SQL, query selectors, deletes, joins, arbitrary limits or transaction callbacks. IDs remain exact and case-sensitive. Standard limits are 8 records/4 writes/8 entities/65,536 bytes; expanded limits are 10/5/8/65,536.

## Supplemental receipt

The opted-in bound handle exposes frozen `_durability_contract` with `_contract: "provider-neutral-v1"`, `_version: 1`, `_backend`, tagged `_store_identity`, exact `_scope`, bound-manifest `_schema_sha256`, resolved `_capacity`, explicit `_hash_policy` or null, `_semantics: "serializable-exact-record-v1"`, `_durability_profile` and `_ownership`.

A successful commit adds `_durability_attestation`: the descriptor plus exact `_unit_id` and `_commit: "confirmed"`. Binding readiness is not proof of a later commit. Legacy SQLite without the new option retains exact existing result keys and `_durability: { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1 }`. Opted-in SQLite keeps that object and adds attestation. PostgreSQL `_durability` is `{ _backend: "postgresql", _profile: "postgresql-local-durable-v1" }`, never invented SQLite pragmas. Top-level `_capacity`/`_hash` remain conditional on their original options.

PostgreSQL identifies its checked persisted store UUID/version/inventory. SQLite `_kind: "sqlite-binding-v1"`, `_lifetime: "bound-handle"` identifies private verified app/file binding state only; it is not a persisted business UUID, restart identity, inode attestation or credential. P3 must separately verify Router business/file identity. No DSNs, private paths or credentials appear in the attestation.

## Atomicity, exact guards and failure

Strict JSON snapshots, grants, schema/Hash preparation and bounds precede checkout. Hash writes require explicit `create-and-preserve-v1`: admissible plaintext, bcrypt cost10 before the transaction, existing 72-UTF8-byte bound, no prehashed/default/null credentials or Hash mutation. Stored Hash values remain available in trusted native complete guards; notifications redact them. No fast digest of a plaintext proposal is produced.

One client runs the entire PostgreSQL unit at SERIALIZABLE, including guard-only units. Ordinary CRUD calls are not composed into units. Actual transaction store identity, schemas/native protections and writer durability are verified. Mutable targets/guards lock in deterministic physical-identity/exact-ID order; output order matches input. Append-only records preserve SELECT/INSERT-only roles and exact SERIALIZABLE reads. Absent rows use predicate protection and full-value native uniqueness, not imaginary row locks or digest-only equality.

Full canonical expectations distinguish absent/null/Hash/timestamps. Record/projection/index changes are atomic; each write affects exactly one row. Prepared/final sizes, lease/expiry, registration/schema pins and native revocation are checked before COMMIT. Final synchronous checks have no intervening await before submission. External providers/payments and bcrypt never run inside units.

Conflicts/deadlocks/constraints abort the entire unit. Independent requests may still have conservative SSI conflicts. There is no global unit mutex or automatic retry. Only a caller with a confirmed abort may build a fresh attempt after rereading/revalidating intent and guards.

`E_ENTITY_POSTGRESQL_WRITE_UNCERTAIN` covers possible successful COMMIT with lost transport/timeout acknowledgement. `E_ENTITY_LOCAL_UNIT_RESULT_UNCERTAIN` covers new-contract response/notification failure or malformed acknowledgement after provider commit. Neither means rollback. Server-confirmed abort SQLSTATEs retain sanitized conflict/constraint classification; raw driver details are not exposed.

`_unit_id` is correlation, not a durable idempotency receipt. Reconcile actual caller-owned immutable/business identities before retrying unknown work; do not re-dispatch external services. No generic unit-log/outbox is introduced. Notifications occur only after confirmed commit with best-effort delivery; lost acknowledgement cannot undo effects.

## Fence consumer and P3 dependency

Explicit v2→v3 migration adds permanent logged singleton `ep_fence` metadata. Initializer/v1→v2 behavior, old checksums and entity layout identity remain unchanged. Normal startup never migrates or repairs; v1/v2 portable stores remain supported.

The row stores checked store identity, required policy, owner UUID and exact BIGINT epoch. Runtime SELECT plus UPDATE on constant constrained `lock_anchor` allows locking SELECT without permission to change owner/epoch/policy. No table-wide UPDATE or metadata INSERT/DELETE/TRUNCATE/TRIGGER/DDL is granted. Ordinary CRUD in required-fence stores is denied; local flags cannot downgrade persisted protection.

The internal consumer holds a shared fence-row lock before record locks until transaction end and rejects stale/revoked/wrong-store frames, with exact decimal epochs beyond Number.MAX_SAFE_INTEGER. New epochs require an exclusive lock on that same row before readiness. Real fixtures qualify this transaction-side barrier.

**P2 provides no production issuer or dedicated-session acquisition/lifecycle.** `_owner_context` is a reserved opaque consumer slot; fabricated/missing contexts reject in required-fence mode. P3 must implement trusted issuer/native consumer wiring, dedicated session/transition authority, Router readiness/loss/drain/reconciliation, potentially through a scoped companion XNode change. A copied tuple cannot activate it. End-to-end issued-context readiness is a P3 gate, not a P2 PASS or production-readiness claim. No fallback bypass is provided.

Shared safety/SQLite regressions remain mandatory even though PostgreSQL is the project's production reference. The accepted narrow exceptional-Unicode SQLite parity exception remains unchanged. Router business rules, pricing, real providers, active installations and production data are untouched.
