# PostgreSQL EntityLocalUnit P2 — Implementation Contract Review Candidate

**Status: Implementation contract approved by Yehudit-Miryam on 2026-11-26; implementation/evidence pending owner acceptance.**
The owner explicitly authorized implementation/tests and a Draft PR to `codex/postgresql-support`. The approved pre-implementation document SHA-256 is `939ff64d954cbb0ec079ad5c524640939f1f4957211ff09c57b6a51a8581d4f4`. Original planning-phase limitations below remain historical provenance. This authorization excludes merge, issue closure and starting P3/P4; it does not accept the resulting implementation.
**Date:** 2026-11-26. **Accountable engineering owner:** Yehudit-Miryam.
**Scope:** P2 EntityLocalUnit in `xpell-ai/xnode`. P3 Router integration and P4 cross-backend acceptance are separate gates.

## 1. Exact source and delivery boundary

- Integration base: `codex/postgresql-support`, commit `82d54ed5887b5d77637ae3418bc0f1a351f719bf`, tree `a3b2c66660f85f2982ba2ba55b120cc40037cd73`.
- Isolated local task branch: `codex/issue-74-postgresql-local-unit`, created directly from that integration commit. Future implementation PR base must be `codex/postgresql-support`.
- Accepted P1 implementation parent: `ebf1e9060e05815d8a031d2baaae537c13acae46`. The integration merge preserves its qualified tree. Main is not this task's base or merge target.
- Approved architecture: PostgreSQL persistence specification v0.1, `AimeVerse/xai-router` commit `a544f50ea48217afc55dbf780e88bd1493e43499`, `docs/postgresql-persistence-spec-v0.1.md`, SHA-256 `321dd123e58072553e10e66feb361dbf7abd83d1a5df4604d5f4f6d62b6c3e8b`.
- This document is an uncommitted repository-owned API/design review artifact. It is not an implemented API, a pushed artifact, a PR, a test result or an accepted design amendment. Names explicitly marked proposed require owner review.
- Source inspection only in this phase. No dependency installation, database startup, new test execution, implementation changes, merge, publication or active-service change is part of this delivery.

### Owner direction — 2026-11-26

In the current authorized owner conversation, Yehudit-Miryam explained that SQLite is intended mainly for local development/tests and less for production, then agreed to the following recommendation. This records the selected planning direction; the complete wire/fence contract and implementation approval gate remain pending.

| Use | Selected planning direction |
|---|---|
| Fast local development and business-logic tests | Keep SQLite convenient and supported. |
| Shared safety contract: authority, Hash, complete guards, atomic rollback | Test both backends and preserve existing SQLite regressions. |
| PostgreSQL concurrency, locking, ownership barrier and uncertain COMMIT | Require actual PostgreSQL tests, including a disposable local option. SQLite success is not substitute evidence. |
| Production reference and release acceptance | Use PostgreSQL as the reference for this project, alongside the retained SQLite regression gates. This is not deployment approval or removal of existing SQLite support. |

The owner-selected direction is to avoid adding a new SQLite business-UUID mechanism in P2, report verified identity kinds honestly, retain the independent P3 business-identity requirement, and apply stronger SQLite final checks only through explicit selection of the new contract. Backend selection remains explicit per environment with no automatic fallback. Existing financial safeguards, approved acceptance requirements and the narrow P1 Unicode exception are not relaxed.

The owner subsequently selected the narrower ownership boundary: leave production ownership acquisition, authority issuance and dedicated-session lifecycle to P3 / Issue #75. P2 / Issue #74 retains transaction-side epoch validation, the handover barrier and the closed future integration interface. This does not authorize starting #75 or implementing code in the current planning phase; full ownership readiness is not a P2 claim.

## 2. Existing behavior and consequences

Every source reference below is pinned to the accepted integration commit, not mutable main.

| Source | Observed behavior | Design consequence |
|---|---|---|
| [EntityLocalUnit.ts](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/EntityLocalUnit.ts) | Closed record DTO, GUID targets, exact canonical snapshots, capacity v2, explicit Hash policy, lease and expiry. | Reuse the DTO and validators; no SQL/query/callback transaction language or new operation kinds. |
| [XEntityManager.ts:260](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/XEntityManager.ts#L260) | Binding explicitly requires SQLite instances, pins registrations/definitions, checks a real writer and issues a private command key. | Generalize backend dispatch behind native authority; preserve the manager's command/authorization boundary. |
| [XEntityManager.ts:288](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/XEntityManager.ts#L288) | Commit rejects transport context and extra parameters, validates grants, broadcasts after provider return. | Keep transport denial, private key, exact write allowlist and post-COMMIT notification order. |
| [SQLiteEntityProvider.ts:1850](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/SQLiteEntityProvider.ts#L1850) | Existing private-file `BEGIN IMMEDIATE` unit, WAL/FULL/FK/busy checks, full-record guards, Hash preparation, lease checks, SQL indexes and three-field durability receipt. | Delegate the legacy SQLite path, rather than rewriting its transaction engine. |
| [SQLiteEntityProvider.ts:1986](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/SQLiteEntityProvider.ts#L1986) | Result-byte check is conditional on Hash or historical-import mode. Legacy plain units do not universally have this check. | Do not claim uniform output-size enforcement today. Proposed stronger behavior must be explicit opt-in for SQLite (D3). |
| [PostgreSQLEntityProvider.ts:43](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/PostgreSQLEntityProvider.ts#L43) | Each ordinary CRUD operation owns its own runtime transaction and schema check; atomic-unit capability is currently false. | A unit must not call public CRUD methods successively. Implement one provider-owned multi-entity execution path. |
| [PostgreSQLRuntime.ts:246](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/PostgreSQLRuntime.ts#L246) | One checked-out client, SERIALIZABLE writes, REPEATABLE READ read-only transactions, bounded timeout/cleanup and commit-submitted tracking. | Reuse pool/transaction ownership. Even guard-only atomic units require the SERIALIZABLE unit path. |
| [PostgreSQLRuntime.ts:73](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/PostgreSQLRuntime.ts#L73) | SQLSTATE mapping precedes the generic uncertain-write fallback. | Qualify classification at COMMIT boundaries; a timeout/lost reply must not be treated as proof of rollback. |
| [PostgreSQLSchema.ts:85](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/PostgreSQLSchema.ts#L85) | P1 verifies physical schema, enabled protection triggers, logged permanent tables, usable indexes, inventory and migration ledger. Metadata versions 1 and 2 have no owner-epoch row. | Preserve these checks. Any fencing metadata requires a reviewed explicit migration, never boot-time repair. |
| [PostgreSQLValues.ts:97](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/src/XEntityManager/PostgreSQLValues.ts#L97) | Ordinary CRUD preparation applies defaults/coercions, optional bcrypt, generated IDs and wall-clock timestamps. | Add strict atomic preparation; do not silently inherit CRUD transformations or generate atomic target IDs. |

The P1 corrections for schema/durability verification and PostgreSQL startup failure propagation remain required regressions. P1 portable CRUD semantics, query operators, type mapping, schema/layout hashes and physical record encoding are not redesigned here.

## 3. Provider-independent binding and authority

Keep `bindEntityLocalUnit`, `EntityLocalUnit`, `BoundEntityLocalUnit`, private `_local_unit_key`, `_x.execute` and XResponse envelopes. No remote or model operation can provision a binding. `_ctx`, unexpected command parameters and unknown/unbound entity names remain rejected.

Introduce an internal `EntityLocalUnitBackend.ts` adapter boundary (proposed file). It resolves only genuine supported native providers, with closed binding-verification and bounded-commit operations. Capability advertisement alone, a matching string or a duck-typed object is not authority. Provider recognition belongs inside this native adapter, rather than SQLite type checks at the manager's public boundary. No plugin/backend registration command, raw-client return or arbitrary transaction callback is added.

SQLite delegates to its existing static executor. PostgreSQL executes inside `PostgreSQLEntityProvider`, where its private runtime, identity and layout are available; no public SQL/client escape hatch is needed. Shared contract validation remains in `EntityLocalUnit.ts`; do not refactor unrelated historical-import infrastructure.

At binding:

1. Resolve only existing frozen standard/expanded limits and the optional existing Hash policy. Snapshot/freeze options and the allowlist before any await.
2. Require registered app-scoped entities in the same exact app/environment and backend. For PostgreSQL, require the same runtime-owned physical store entry, database/schema, persisted store UUID and checked inventory. Equivalent aliases resolving to that same entry are acceptable; equal caller-supplied UUID strings alone are not proof.
3. Pin registration objects, schema/definition identities, backend identity and per-entity write permission. Mixed SQLite/PostgreSQL units, cross-app/store/schema units and unsupported providers fail before admission.
4. Validate the actual atomic writer connection, every bound schema and the requested durability/capacity/Hash/fence contract before returning a bound handle. Do not publish a handle after a failed readiness probe.
5. Revalidate the pins after asynchronous preparation, inside the transaction and immediately before COMMIT submission. Replaced/disposed entities and revoked owner context invalidate the binding's work; no implicit rebinding/reconnect-to-a-new-store.

`transactions` and `runtime-entity-handle` remain unsupported. PostgreSQL `app-local-atomic-unit` becomes supported only for the implemented bounded contract, with versioned negotiation. Existing memory/Mongo/XDB behavior is unchanged.

## 4. PostgreSQL unit execution contract

### 4.1 Preparation before opening a transaction

- Run `validateLocalUnit` and enforce app/entity/write grants before any SQL or bcrypt work. Snapshot exact plain JSON; reject lossy/executable input, duplicate targets and extra DTO fields.
- Only the existing create/update/guard operations are allowed. A create requires `_expect: null` and its explicit `_id`; an update requires the complete expected record. The GUID syntax requirement is unchanged. ID text remains exact and case-sensitive; do not lowercase GUID-looking IDs or change accepted P1 encodings.
- Use existing schema and scalar normalization primitives, but compare every supplied non-Hash value with its prepared canonical value and reject coercion/truncation. Preserve required/default/immutable/null behavior established by the atomic SQLite contract. Reject user-written system timestamps and append-only updates.
- For Hash-schema writes require explicit `create-and-preserve-v1`. Validate plaintext before bcrypt, hash at cost 10 before checkout, reject encoded hashes/default credentials/null/coercion/over-72-UTF8-byte input, reject Hash updates and preserve existing stored hashes exactly. Required Hash without explicit admissible input fails. Unknown fields fail.
- Recheck the prepared payload against the selected 65,536-byte bound after Hash transformation. Never compute/log a fast digest of the original credential-bearing unit, a plaintext proposal or its receipt. Existing schema digests do not authorize credential hashing for audit.
- No AI, payment, network application call or asynchronous bcrypt preparation inside the database transaction.

### 4.2 One connection and one transaction

1. Acquire exactly one client through the accepted runtime's bounded pool. Begin `SERIALIZABLE` for the entire unit, including a guard-only unit. Do not use `pool.query`, nested CRUD transactions, or a separate client for any statement of that unit.
2. On that writer verify server/version/store/schema/role and actual durability policy. Verify all participating physical entity layouts, migration checksums, logged tables, protection triggers and usable required indexes using accepted P1 mechanisms.
3. If a fenced context is requested, acquire/check the shared owner-epoch row lock first and retain it until transaction end (§6). No unverified context may silently select an unfenced path.
4. Sort record reads/locks by exact physical entity identity then exact encoded `_id` bytes, with a stable bytewise comparator. Lock mutable existing target/guard rows in that order using `FOR UPDATE`. Preserve append-only SELECT/INSERT-only roles: immutable rows use exact SERIALIZABLE reads, native append-only protection and SSI for absence, without granting UPDATE just for row locks. Return results in the caller's original order.
5. Select the full logical `_json` for each target with exact ID equality, using P1 encoding/projection and full equality after any hash-index narrowing. Evaluate each supplied `_expect` against the entire canonical current record, or against `null` for absence. Never replace equality with SHA equality. A digest collision cannot establish identity or overwrite a different value.
6. For missing targets execute exact predicate reads inside SERIALIZABLE. A row lock cannot lock a nonexistent row. SSI predicate dependencies and native full-value uniqueness protections must cover create/guard races, including competing ordinary PostgreSQL CRUD. Serializable order is the guarantee: an insert legitimately ordered after an absence-guarded unit need not be rejected. Tests must exercise a conflicting dependency cycle, rather than incorrectly demanding that every overlapping insert abort.
7. Validate `_lease` against the included, locked full record: claimed state, owner ID, safe epoch/version and unexpired lease. Capture one valid trusted timestamp for all mutation timestamps. Preserve full expected-record comparisons including stored hashes, null/absent fields and timestamps.
8. Apply bounded inserts/updates plus all typed projections/index effects on the same client. Each mutation must affect exactly one intended record. Preserve native unique/required/immutable/append-only guards. A conflict or failed check aborts the entire unit; no partial success envelope.
9. Before COMMIT validate result records/byte size, authoritative registration/schema pins, revocation, trusted clock, `_valid_until` and lease expiry. Recheck actual writer policy if mutable settings could have changed. Native synchronous final checks run immediately before COMMIT submission, with no intervening asynchronous work. Runtime may need an internal-only final guard hook; it must not become a caller-authored transaction callback or SQL API.
10. Submit COMMIT once. Return success only after confirmed acknowledgement. Then and only then publish changed-record notifications, with existing Hash redaction. No notification or success response on an aborted unit.

Expiry is checked before COMMIT submission; this is not a promise that network/disk acknowledgement arrives before a wall-clock deadline. Result-size checks cannot be postponed until after COMMIT and presented as if they rolled back a transaction.

All failures release/discard the client through the existing runtime. Preserve its bounded admission and shutdown behavior. Reject work after shutdown; do not acquire replacement pools invisibly. Do not globally serialize independent account transactions just to make tests deterministic.

## 5. Capacity, acknowledgement and durability (D1–D3)

| Profile | Records | Writes | Entities | Bytes |
|---|---:|---:|---:|---:|
| `standard-v1` | 8 | 4 | 8 | 65,536 |
| `expanded-v1` | 10 | 5 | 8 | 65,536 |

These existing v2 limits, existing optional `_capacity` and `_hash` acknowledgements and their exact validation remain unchanged. No chunking, extra caller-selected limits or retry that splits an essential unit.

### D1 — Explicit supplemental negotiation (recommended)

Propose native binding option `_durability_contract: "provider-neutral-v1"`, a frozen versioned bound capability descriptor, and supplemental result field `_durability_attestation`. Names are proposals, not current API.

- Legacy SQLite with no new option returns exactly its existing keys and `_durability: { _journal_mode: "wal", _synchronous: 2, _foreign_keys: 1 }`. Existing opt-in capacity/Hash fields remain governed by their current rules.
- Explicitly opted-in SQLite keeps that exact `_durability` object and adds the neutral attestation. PostgreSQL requires explicit new-contract negotiation and reports its own tagged native durability evidence, never fabricated SQLite pragmas.
- Neutral attestation has a closed versioned shape: contract/version, `_unit_id`, backend, verified store-identity kind/value, app/env and schema/inventory identity, selected capacity/Hash semantics, isolation/guard qualification, actual durability profile and confirmed-commit status. The bound descriptor describes guarantees; only the post-COMMIT acknowledgement describes a confirmed commit. No DSN, credential, absolute private path, client or connection configuration is returned.
- The PostgreSQL native durability profile records verified `fsync`, `full_page_writes`, `synchronous_commit=on`, logged relations and SERIALIZABLE execution. SQLite adapter records its verified actual writer profile. Do not claim power-loss testing, HA or replica guarantees.
- Native result-shape/capability validation occurs before COMMIT where possible. Missing/corrupt post-COMMIT acknowledgement requires reconciliation; it is not proof that nothing happened. Consumers reject unsupported contract versions at binding, rather than guessing semantics.

### D2 — Tagged SQLite identity selected; exact wire shape pending

PostgreSQL already has a checked persisted `ep_store.store_id`. The generic SQLite local-unit provider has a verified file/app/entity identity, not a universal persisted business-store UUID. A UUID supplied in binding configuration, an inode/path digest or `_unit_id` is not evidence of a persisted logical business identity.

The owner-selected planning direction is a discriminated verified identity: PostgreSQL persisted UUID versus SQLite native file binding, with explicit identity kind/lifetime and schema/app scope. Router's existing persisted business identity must additionally be verified by its trusted adapter in P3. The descriptor must state that file binding alone does not qualify a Router business UUID. This does not weaken the spec's business-identity readiness requirement; P3 cannot become ready without that independent verification.

Do not add a new SQLite business-UUID mechanism, automatic identity metadata or schema rewrite in P2, and never return a caller-asserted UUID as verified. The exact closed identity/attestation fields still require contract review before implementation; production business-identity validation remains mandatory in P3.

### D3 — Stronger opt-in final checks selected in principle

The proposed PostgreSQL implementation always bounds prepared input and final records before COMMIT and rechecks expiry/revocation immediately before COMMIT. The owner-selected planning direction applies equivalent final result/expiry checks to SQLite only when it explicitly selects the new neutral contract. The legacy SQLite path retains its current timing/receipt behavior; its existing Hash/historical result checks remain intact.

This is an additive contract, not an undocumented tightening of every legacy consumer. Additive SQLite changes, if accepted, must occur inside its existing transaction before commit, with no new storage schema or transaction framework. Do not assert universal plain-unit output bounds on accepted P1/legacy SQLite code.

## 6. Deterministic fencing interface and P2/P3 boundary (D4)

The existing unit `_lease` is a record-level expected owner/version/expiry guard. It is not a store-wide Router ownership epoch or evidence that a dedicated owner session is alive.

P2 responsibilities under the selected D4 scope boundary; exact API/migration details remain review candidates:

- Define a closed native-only opaque fence context pinned at binding: exact persisted store UUID, owner UUID, canonical monotonic epoch, app/env authority and revocation state. It is not accepted in unit JSON or a transport command; copying a public tuple cannot mint authority.
- Validate the context in the transaction against one durable metadata fence row. Hold a compatible shared row lock until COMMIT/ROLLBACK; ordinary independent units may share it. Acquire this lock before record locks everywhere.
- A new epoch must be advanced while holding an exclusive lock on that same row. That barrier waits for old admitted transactions to finish/abort. After the new epoch is published, an old epoch cannot commit a later guarded write. A stale SERIALIZABLE snapshot may fail with a serialization conflict and must not be silently retried with a new epoch.
- Missing/stale/revoked context is rejected in explicitly fenced mode. All allowed ordinary CRUD mutations in that protected mode must use the same fence or be denied. Recommended initial policy: deny unbound ordinary CRUD mutations in a fenced store; read-only operations remain permitted. Portable unfenced P1 configurations remain unchanged. No assertion that existing P1 CRUD is already ownership-fenced.
- Whether a store requires fencing must be checked from protected persisted metadata by every qualified runtime, not selected away through a caller's local configuration. The metadata migration must define restricted epoch-transition privileges; ordinary application DML cannot rewrite owner identity/epoch or downgrade the policy. P2 defines the transaction-side validation boundary; P3 implements and qualifies production owner/transition authority and its safe issuer.
- Store epoch uses an exact bounded integer representation; if SQL BIGINT is selected, decode to canonical decimal text without JavaScript Number rounding, reject invalid/overflow state. Existing unit `_lease._owner_epoch` retains its safe-integer DTO contract.

P1 has no fence table. Propose a reviewed metadata v3 migration adding one protected permanent/logged fence relation and its version/checksum/privilege verification. Existing v1/v2 stores remain valid for their existing portable contract. A fenced binding requires the explicitly migrated version and expected identity; no normal startup migration. Review schema fingerprint consequences, old ledger checksums and interruption/unknown-migration outcome tests before coding. Do not reinitialize stores or rewrite entity definitions/layouts just to add fence metadata.

**D4 scope selected by the owner:** P2 supplies the generic epoch-validation/shared-lock barrier and closed future owner-context interface, qualified with a synthetic native fixture holding a real dedicated advisory session and performing the exclusive handover. P3 / Issue #75 owns production ownership acquisition, safe authority issuance, dedicated-session lifecycle, Router readiness, all Router writer wiring, loss handling, shutdown and reconciliation. The proposed expansion to a complete production owner coordinator in P2 is not selected. No Router files are implemented in P2, and #75 is not started by this decision.

Production context issuance must require verified ownership authority; do not ship a tuple-to-token backdoor or claim that row validation proves a live advisory session. P2 must define the closed consumer interface and reject missing/unverified authority in protected mode. Synthetic ownership/transition orchestration used to qualify P2 remains in isolated tests, not a public or default production authority issuer. P3 implements and end-to-end qualifies the real issuer/lifecycle against this interface before protected Router activation. Deferring the issuer does not authorize an unfenced fallback or a production-ready ownership claim. Exact interface review still precedes implementation approval.

P3 must eventually prove the approved protocol in full: dedicated non-pooled advisory owner lock keyed to the persisted business-store identity, epoch barrier before readiness, revoke/stop admission on known session loss, drain/reconcile pooled transactions, and no silent reacquisition. No instantaneous remote failure detection or active-active/HA claim is made by P2.

## 7. Confirmed abort, unknown commit and retry rules

| Observation | Required treatment |
|---|---|
| Input/authority/Hash failure before transaction | Rejected; no submitted unit effects. |
| Verified pre-COMMIT rejection with completed rollback, or server-confirmed transaction abort | Entire unit aborted; no mutations/notifications. |
| Server-confirmed SERIALIZABLE/deadlock victim or constraint abort | Surface sanitized conflict/constraint; no automatic provider retry. Caller may build a new attempt from fresh intent/guards after a confirmed abort. |
| Transport disconnect, timeout or cancellation around COMMIT without authoritative outcome | Unknown write outcome; do not infer rollback or silently replay. |
| COMMIT acknowledged, response/notification lost or process killed before caller receipt | Committed in storage, possibly unknown to caller. No provider rollback claim or blind retry. |

Audit `PostgreSQLRuntime.sanitizedPGError` and transaction cleanup with actual server/proxy faults. Do not classify solely from an exception name or the fact that a query promise rejected. A known server abort and a client query timeout are different evidence. Rollback success on a replacement connection cannot prove the original transaction's outcome. Conservatively surface `E_ENTITY_POSTGRESQL_WRITE_UNCERTAIN` when COMMIT may have succeeded; preserve stable existing public errors where their abort guarantee is proven. Any corrective runtime change must be narrowly tested against P1 CRUD as well as P2.

The current sanitizer preserves PostgreSQL-prefixed XErrors but not local-unit-prefixed validation errors. The new path must preserve only genuine, sanitized native unit errors (conflict, expiry, fencing, authority and bounds) across runtime cleanup, without forwarding arbitrary driver text or credential-bearing causes. Do not accidentally turn every failed business precondition into `UNAVAILABLE`, or let a pre-existing validation error mask an uncertain COMMIT.

No unit-level automatic retry, generic durable unit-log, or new financial/idempotency subsystem is proposed. `_unit_id` correlates a request; it does not establish persisted exactly-once effects. Reconciliation uses caller-owned deterministic business/immutable receipt identities and full verified records. P3 implements Router-specific reconciliation and preserves holds/obligations while evidence is incomplete. No re-dispatch of external providers/payments under an unresolved result.

Notification delivery is best effort after confirmed commit, not a transactional outbox or exactly-once event guarantee. Hash redaction remains in the existing manager notification path. Trusted native results may contain stored bcrypt values needed for complete future guards; never expose those results as transport authorization.

## 8. Dependencies, configuration and compatibility

Reuse accepted exact dependencies/runtime baseline: PostgreSQL **17.12**, `pg` **8.23.1**, `@types/pg` **8.23.1**, Node reference **22.23.1** and additional **24.22.3**. Preserve existing SQLite/native dependency qualification and SDK fixture locks. Do not select a newer version because it is available. A different version needs separate compatibility evidence.

Reuse P1 trusted native placement/configuration, secret environment references, TLS verification, bounded queue/pool/timeouts, sanitized errors, separate runtime/maintenance roles and no ordinary automatic initialization. Existing defaults remain: pool 10, waiting 32, acquisition/connect/statement 5,000 ms, lock 1,000 ms, idle transaction 5,000 ms, idle 30,000 ms, drain 10,000 ms. Existing permitted configuration bounds also remain unchanged. Do not silently lengthen transaction timeouts to conceal contention or include bcrypt/external work in transactions.

New configuration is limited to reviewed native contract negotiation and, if approved, fenced-store mode/opaque owner-context plumbing and explicit metadata-version expectation. No credentials in artifacts, logs, comments or committed fixtures; synthetic secrets stay in test process memory. No unqualified `PGOPTIONS` or search-path override.

Preserve P1's fixed WTF-8 codec, full-value equality/uniqueness checks and accepted encoding across both Node lanes. The sole owner-approved Unicode exception remains SQLite parity for unpaired UTF-16 surrogate keys; do not expand it, introduce a runtime-dependent codec, constrain the package to Node22 or weaken ordinary string equality. Atomic GUID target IDs do not broaden the portable CRUD ID domain.

Do not change accounting precision, business rules, pricing, Router schemas, arbitrary CRUD authorization or legacy filesystem/XDB behavior. Strict atomic Hash behavior is not a redesign of ordinary P1 Hash CRUD.

## 9. Proposed file inventory

All paths are repository-relative. Items conditional on owner decisions remain planning candidates, not permission to enlarge scope.

| Path | Proposed change |
|---|---|
| `src/XEntityManager/EntityLocalUnit.ts` | Add frozen supplemental durability contract/attestation types and strict negotiation; preserve DTO and capacity/Hash constants. |
| `src/XEntityManager/EntityLocalUnitBackend.ts` (new) | Closed internal native backend adapter selection, verified binding/result contract and provider-independent dispatch. No public registration or client API. |
| `src/XEntityManager/XEntityManager.ts` | Replace SQLite-only boundary dispatch; retain pinned authority, remote denial, grants, optional legacy fields and postcommit notifications. Store/revoke qualified native contexts. |
| `src/XEntityManager/PostgreSQLEntityProvider.ts` | Strict bounded multi-entity executor and private binding verification; same-client SQL, full guards, locks, projections, native results; qualified capability; deny unfenced CRUD in protected mode if approved. |
| `src/XEntityManager/PostgreSQLLocalUnit.ts` (new internal helper) | Fixed preparation/SQL kernel for the provider and isolated storage-half fixtures; no public callback transaction or raw-client API. Separation supports real fence-protocol tests while production issuance remains deferred. |
| `src/XEntityManager/PostgreSQLValues.ts` | Add narrowly scoped strict atomic preparation helper if needed; reuse codec/projection/normalization without changing ordinary CRUD semantics. |
| `src/XEntityManager/PostgreSQLRuntime.ts` | Internal same-entry identity check, final synchronous guard and commit-phase outcome classification; optional closed fence-context state per D4. Preserve pool ownership and existing limits. |
| `src/XEntityManager/PostgreSQLSchema.ts` | Only if D4 approved: reviewed explicit fence-metadata migration, identity/fingerprint/role checks and exact checksums. Preserve previous versions/checksums/DDL. |
| `src/XEntityManager/SQLiteEntityProvider.ts` | Thin adapter use; only if D2/D3 approved, opt-in identity attestation/final precommit bounds/expiry checks inside existing executor. Legacy mode and historical-import behavior unchanged. |
| `src/index.ts` | Export only approved public metadata/types; no native backend resolver, raw clients, SQL operations or unrestricted transaction entrypoint. |
| `tests/postgresql-local-unit.test.mjs` (new) | Real binding, authority, full guards, Hash, capacity, result/durability and postcommit notification cases. |
| `tests/postgresql-local-unit-concurrency.test.mjs` (new) | Multi-client/process row/CAS/absence/uniqueness/deadlock/timeout and fence-barrier cases. |
| `tests/postgresql-local-unit-durability.test.mjs` (new) | Actual rollback/connection termination/COMMIT-ack loss/process-crash tests and reconciliation observations. |
| `tests/postgresql-local-unit-worker.mjs` (new) | Isolated native concurrency/crash worker; fixed test fault points, no product SQL API. |
| `tests/postgresql-fixture.mjs` and `tests/postgresql-network-guard.mjs` | Preserve P1 safeguards; allow an explicitly marked disposable Issue74 cluster/workers without accepting arbitrary endpoints. No weakening of administrative deletion checks. |
| `tests/postgresql-schema.test.mjs`, `tests/postgresql-review.test.mjs`, `tests/postgresql-pool.test.mjs` | Add migration/fenced policy/commit-classification regressions only where changed; retain all P1 protection tests. |
| `tests/local-unit.test.mjs`, `tests/hash-local-unit.test.mjs`, `tests/sqlite-durability.test.mjs` | Exact legacy-shape regressions plus explicitly negotiated neutral tests if approved. |
| `tests/fixtures/postgresql/consumer/` | Extend clean installed-consumer use of the public bounded API; preserve dependency locks. |
| `tests/fixtures/postgresql/qualification-p2.json` (new) | New immutable P2 source/package/version/log/result evidence. Do not overwrite accepted P1 receipt to make it appear newly qualified. |
| `docs/architecture/postgresql-entity-local-unit-p2-plan.md` | This review contract, subsequently updated only with explicit decision evidence. |
| `docs/architecture/entity-provider-portable-v1.md`, `docs/architecture/postgresql-entity-provider-v1.md` | Document additive capabilities, exact compatibility boundaries and native usage after approval. |
| `docs/architecture/postgresql-entity-local-unit-p2-qualification.md` (new) | Reproducible commands, fixtures, failures, limitations and exact new acceptance evidence after implementation. |

No expected dependency/package-version change, new ORM, lockfile rewrite, XNode/ServerXVM startup redesign or Router repository change. Existing PostgreSQL test glob includes the proposed test names; add a script only if reproducibility actually requires it. If another source file becomes necessary, record its reason before expanding the implementation diff.

## 10. Real test and evidence plan

### Harness and provenance

Use a separately marked disposable PostgreSQL 17.12 cluster, template0 databases, synthetic fixtures and separate restricted runtime/maintenance roles. Reuse accepted source/image provenance and network guard; only the explicitly approved loopback/socket endpoint is accessible. The existing fixture requires an Issue73-marked directory: extend that check explicitly for Issue74, never bypass it with a production DSN. No mock database may substitute for a required PostgreSQL test.

Build source, pack in isolation, install a clean consumer from exact locked SDK dependencies and repeat the actual tests on Node22 and Node24. Record integration base, final feature head/tree, source map, archive hash, lock hashes, PostgreSQL source/image identity, observed running server, driver/native/OS versions, complete commands, per-test expected/actual results, log digests and PASS/FAIL/SKIP counts. Preserve immutable P1 historical records; build a new P2 evidence artifact. The existing conditional P1 skip remains separately identified, not converted to a pass or widened.

### Required test groups

| Group | Required actual evidence |
|---|---|
| Native authority | Genuine binding succeeds; fabricated key/provider/capability, transport `_ctx`, extra parameters, cross-app/store/schema/backend, read-only grant, replaced/disposed registration and changed options during bcrypt all reject without partial writes. |
| Exact guards | Full expected record success and mismatch for each field/Hash/timestamp/null/absent; expected absence; duplicate IDs; case-sensitive GUID text; no digest-only acceptance or hidden coercion/truncation. |
| Atomic effects | Standard and expanded units at limits, multi-entity writes plus indexes, failure before first/between every write up to five/before COMMIT, constraint failure and append-only/immutable denial. All-or-none records, projections and immutable receipts. |
| Concurrent correctness | Existing-row CAS one winner; duplicate create; guard/insert write-skew cycle with SSI victim; ordinary CRUD interaction; independent account units both progress. Use separate processes and observed distinct PostgreSQL backend PIDs, not Promise concurrency on one client. |
| Lock behavior | Reversed input order has the same physical lock order; fenced units use shared epoch lock before row locks; actual lock timeout, serialization failure and forced deadlock surface safe whole-unit aborts with no hidden retry. |
| Lease and expiry | Wrong owner/epoch/version/state, expired lease and invalid trusted clock fail. Expiry/revocation during a blocked transaction fails before COMMIT; test the newly negotiated SQLite final check separately from legacy semantics. |
| Fencing boundary | Real dedicated test owner session; stale/missing/revoked opaque context; wrong-store epoch; exclusive handover waits for old in-flight shared locks; new epoch blocks old writes; no CRUD bypass in protected mode. Session-loss full Router readiness remains a P3 acceptance gate. |
| Hash security | Strict input and 72-byte limit, prehash/default/null/mutation denial, cost10, exact preservation, bounds before/after hashing and on results; no plaintext/digest in diagnostics/fault evidence/receipts; notification Hash redaction. |
| Durability/schema | Actual writer SERIALIZABLE and safe settings; malformed metadata/version/checksum/identity, disabled triggers, unlogged tables, invalid indexes and unsafe permissions fail closed. Accepted P1 native startup negative tests remain green. |
| Commit faults | Kill actual client/backend before COMMIT versus lose actual COMMIT acknowledgement using an isolated test proxy. Kill process after COMMIT before caller receipt; independent readback establishes committed/absent facts. Unknown remains unknown to caller, never auto replay or duplicate effect. No fabricated crash-only durability proof. |
| New metadata lifecycle | If approved: v2→v3 explicit migration, v1 qualification through reviewed sequence, source/inventory/roles checked, interrupted DDL transaction, lost migration acknowledgement, restart and mismatched/partial state refusal; no auto-repair. |
| Receipt validation | Exact negotiated version/identity/profile/records, corrupt/missing acknowledgement treated conservatively; no SQLite pragmas in PostgreSQL result; old SQLite default deep-equality and keys unchanged. |
| Lifecycle | Pool saturation/drain/discard, shutdown while a unit waits/runs, no leaked clients/timers, fixed deadlines, identity verified on reconnect and no fallback file/database creation. |

Test faults use existing trusted `_fault` injection and fixed internal points or isolated process/proxy controls. They do not add arbitrary SQL callbacks, remote fault commands, real provider calls or test-only authority issuers to the public package.

### SQLite and package regressions

Run the existing `local-unit`, `hash-local-unit`, `sqlite-durability`, entity-provider conformance and relevant historical import/backup suites because adapter routing and shared validation can affect them. Check unmodified legacy result keys/pragmas, both capacity profiles, schema/lease/security, rollback/ack-loss and Hash behavior. Run accepted P1 PostgreSQL provider/schema/pool/review/lifecycle/value suites and TypeScript build plus clean consumer typecheck. A required lane with no real database must fail the qualification setup, not silently skip and count as success.

Planned commands, **not executed in this phase**, after isolated locked-fixture setup and an explicitly verified disposable cluster (adapt the existing [P1 qualification procedure](https://github.com/xpell-ai/xnode/blob/82d54ed5887b5d77637ae3418bc0f1a351f719bf/docs/postgresql-provider-qualification.md), not a host-wide package install):

```sh
./node_modules/.bin/tsc -p .
node --import ./tests/postgresql-network-guard.mjs --test --test-concurrency=1 tests/postgresql-*.test.mjs tests/entity-provider-conformance.test.mjs
node --test --test-concurrency=1 tests/local-unit.test.mjs tests/hash-local-unit.test.mjs tests/sqlite-durability.test.mjs tests/historical-import.test.mjs tests/historical-import-durability.test.mjs tests/historical-backup.test.mjs tests/historical-backup-durability.test.mjs
```

Run each lane against source and the separately packed/installed candidate as appropriate. Use the existing packing helper with a new absolute task-output path and new P2 evidence file; record the exact clean consumer compilation command and complete final regression file list. These command templates are a plan, not evidence that compilation or a test passed.

The full Router financial/payment/signup/recovery/backup integration matrix belongs to P3/P4. P2 supplies generic synthetic account/receipt fixtures and exact installed-package evidence, not a claim that those Router workflows have been newly qualified.

**Current phase results:** implementation tests NOT RUN; no new PASS/FAIL/SKIP totals claimed. Historical P1 evidence is a dependency, not new P2 evidence.

## 11. Risks, alternatives and approval sequence

- SERIALIZABLE may abort valid competing work. Exact full guards and immutable receipts remain required; do not hide conflicts by enabling automatic retries. A broader lock/ORM/transaction framework is unnecessary.
- Missing-row protection, long-key hash-assisted indexes and maintenance-trigger tampering require real negative/concurrent evidence. Row locking or hash matching alone is insufficient.
- Neutral acknowledgement must not fabricate a SQLite business UUID or silently alter legacy consumers. D1/D2 gate the exact public shape.
- Stronger final output/expiry checks must precede COMMIT and be opt-in on SQLite (D3); a postcommit error cannot undo storage effects.
- Epoch metadata changes require explicit migration and role/fingerprint review. D4 scope is selected; exact transaction-side API remains under review and production capability issuance is a P3 dependency. No stale-owner acceptance claim without the real P2 barrier test, and no complete ownership-readiness claim before P3 qualification.
- COMMIT timeout/error classification is a risk in the current runtime and must be fault-qualified; no finding is asserted as reproduced in this planning phase.
- Privileged maintenance is not an adversarial DBA guarantee. Concurrent uncoordinated DDL/DBA writes remain outside the qualified operating model; normal runtime roles cannot alter protections.
- Filesystem/SQLite native version differences retain their accepted narrow Unicode boundary. No broad SQLite parity exemption.

Decision status before implementation:

1. **D1 — Exact contract pending:** retain explicit supplemental negotiation and unchanged legacy SQLite receipts; review exact capability/acknowledgement fields and names before implementation.
2. **D2 — Direction selected:** tagged verified SQLite file identity plus a mandatory separate P3 persisted-business-identity check; no new P2 SQLite business-UUID mechanism and no claim that file identity proves that UUID. Exact representation remains subject to D1 review.
3. **D3 — Direction selected:** strict final result/expiry checks for PostgreSQL and only explicitly opted-in SQLite bindings; preserve legacy mode. This is planning agreement, not implementation acceptance.
4. **D4 — Scope selected:** retain P2 transaction-side epoch/shared-lock/guarded-write enforcement and the proposed explicit metadata migration; leave production ownership acquisition, authority issuance and dedicated-session lifecycle to P3 / Issue #75. Define the closed integration interface in P2, reject unverified authority and prove the barrier with isolated real-PG fixtures. Full ownership/readiness qualification remains a P3 gate; exact API/migration contract and implementation approval are still pending.

After those decisions: capture the accepted contract revision and approval in the task, refresh authority/claims/integration head, then implement in small reviewable steps (adapter/legacy parity; negotiated contract; PostgreSQL executor; fenced metadata/guards; real concurrent/fault qualification; installed consumer and evidence). Unexpected source drift or an unsatisfied mandatory invariant stops dependent implementation for owner reconciliation. Open a Draft PR targeting the integration branch only after implementation is separately authorized. Do not merge or close the task without explicit owner acceptance.

## 12. Primary technical references

- [node-postgres transactions](https://node-postgres.com/features/transactions): transactions require one checked-out client for all statements.
- [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html): SERIALIZABLE predicate/dependency semantics, not nonexistent-row locking.
- [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html): compatible shared/exclusive row locks, advisory sessions and consistent lock order.
- [PostgreSQL serialization failure handling](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html): confirmed serialization/deadlock failures and retrying a complete decision transaction rather than isolated SQL fragments.

These documents support the proposed mechanisms. They do not substitute for qualification of this exact source/package, ownership interface or failure protocol.

## 13. Concrete implementation baseline for owner approval — 2026-11-26

This section resolves the remaining proposal names/consumer semantics for one implementation approval. It is still a specification draft, not code or evidence of implemented behavior. Owner-selected D2/D3/D4 directions above are preserved. Routine spelling choices below do not require a separate decision for every field.

### 13.1 Supplemental durability contract

Use the proposed native binding option `_durability_contract: "provider-neutral-v1"`. A successful opted-in binding returns a frozen `_durability_contract` descriptor. A successful commit returns `_durability_attestation`, containing that descriptor plus `_unit_id` and `_commit: "confirmed"`. The existing `_records`, explicitly negotiated `_capacity` and `_hash` fields keep their current meaning. No commit attestation is returned before confirmed COMMIT.

The descriptor is closed and versioned:

| Field | Proposed value and interpretation |
|---|---|
| `_contract` / `_version` | `provider-neutral-v1` / `1`; an unsupported version fails negotiation. |
| `_backend` | `postgresql` or `sqlite`, never inferred from optional flags. |
| `_store_identity` | One of the explicitly tagged identities below. |
| `_scope` | Exact native `_app_id` and `_env`. |
| `_schema_sha256` | Canonical digest of the sorted bound-entity manifest: logical name, physical identity and definition digest. This hashes schemas only, never record/credential proposals. |
| `_capacity` | Existing resolved v2 capacity descriptor, including exact fixed limits. Existing top-level `_capacity` remains conditional on the original explicit profile option. |
| `_hash_policy` | `create-and-preserve-v1` or explicit `null`; no implicit Hash authority. |
| `_semantics` | `serializable-exact-record-v1`: bounded whole-unit atomicity and complete expected-record/absence conditions. |
| `_durability_profile` | `postgresql-local-durable-v1` or `sqlite-wal-full-v1`, checked on the actual writer. |
| `_ownership` | `{ _mode: "unfenced" }`, or epoch-qualified mode with canonical owner UUID and exact decimal epoch. This describes qualification; it grants no authority. |

PostgreSQL store identity: `_kind: "postgresql-store-v1"`, checked persisted `_id`, `_schema_version` and `_inventory_sha256`. SQLite store identity: `_kind: "sqlite-binding-v1"`, an opaque native `_id` with `_lifetime: "bound-handle"`. The SQLite token correlates the verified native app/file binding only; it is not a persisted business UUID, an inode attestation, a portable restart identity or a credential. It is backed by private binding state and the existing actual-writer/path/schema checks. No path, DSN or credential is returned. Separate P3 business/file-ownership identity validation remains mandatory.

`postgresql-local-durable-v1` requires actual writer SERIALIZABLE execution, accepted server/role/store/schema verification, fsync/full_page_writes enabled, synchronous_commit on, permanent logged required tables, enabled protection triggers and usable required indexes. `sqlite-wal-full-v1` requires the existing real writer WAL/FULL/FK/busy profile, plus the expressly opted-in final bounds/expiry checks. Profiles do not attest replica, OS power-loss or HA qualification.

Legacy SQLite without the new option returns exactly its existing result shape and three-field `_durability`. Opted-in SQLite retains that same `_durability` and adds the new attestation. PostgreSQL requires the new negotiation and uses a tagged `_durability` containing `_backend: "postgresql"` and `_profile: "postgresql-local-durable-v1"`; it never emits SQLite pragmas. The common attestation is the new consumer contract; native details remain in the adapters.

All descriptor fields are frozen at binding and checked against private state at commit. The final acknowledgement adds only the validated `_unit_id` and confirmed-commit marker. A changed schema/store/profile cannot silently update the existing descriptor. Result/descriptor preparation and validation occur before COMMIT where possible. Missing/corrupt caller acknowledgement after submission is an uncertain result requiring reconciliation, never permission for blind retry. No plaintext intent digest or new durable unit-log is introduced.

### 13.2 Closed future ownership consumer interface

Reserve native binding field `_owner_context` of opaque type `EntityLocalUnitOwnerContext`. It is not part of `EntityLocalUnit` JSON, is not serializable, and cannot be supplied by transport. A plain owner/store/epoch object or copied attestation is rejected. The native context is pinned to the runtime-owned store entry, app/env, owner UUID, exact epoch and revocation state; binding copies no caller-controlled function or SQL callback.

| Condition | Required P2 behavior |
|---|---|
| Existing portable store with no required fence | Existing portable behavior; new acknowledgement labels it `unfenced`. |
| Store metadata requires fencing but context is absent/unverified | Reject binding/admission; no default owner, invented context or unfenced retry. |
| Context has different store/app/env, stale epoch, revoked state or replaced registration | Reject the unit without a partial write. |
| Qualified epoch-mode unit | Lock/check the fence row first with a shared row lock, then deterministic record locks; retain all locks until transaction end. Recheck native revocation and expiry immediately before COMMIT. |
| Ordinary mutation in a required-fence store without the qualified unit path | Reject; do not permit generic CRUD to bypass the fence. |
| Public capability/result advertises `unfenced` or no production issuer exists | This does not satisfy future Router fenced readiness. |

No production context factory/acquisition/session coordinator is implemented in #74. Its implementation and complete positive readiness path belong to #75. P2 real PostgreSQL tests exercise the internal transaction-side storage protocol with synthetic trusted frames and actual dedicated-session/maintenance handover fixtures, and separately prove that public bindings reject fabricated/missing authority. They do not claim to qualify a production issuer. Test orchestration remains under `tests/`, with no test authority factory exported by the public package. The existing public bounded path is positively exercised for ordinary portable units. End-to-end issued-context binding/readiness remains an explicitly documented P3 dependency.

This is a native authority boundary, not a sandbox against arbitrary privileged code running inside the host process. No raw client, arbitrary SQL, general callback transaction API or remote ownership command is added.

### 13.3 Fence metadata and explicit migration proposal

Propose metadata version 3 with one permanent logged singleton `ep_fence` relation: checked store ID, boolean required-fence policy, canonical nullable owner UUID, nonnegative BIGINT epoch and a constant `lock_anchor` boolean constrained NOT NULL/TRUE. Epoch zero/null owner is unowned and cannot authorize protected writes; active epochs are positive and represented in JavaScript as exact decimal strings bounded by signed BIGINT. No timeout-based takeover is encoded.

PostgreSQL row-locking SELECT requires UPDATE privilege on at least one column ([SELECT privileges](https://www.postgresql.org/docs/17/sql-select.html), [column GRANT](https://www.postgresql.org/docs/17/sql-grant.html)). Therefore grant the runtime role SELECT plus UPDATE on `lock_anchor` only, not table-wide UPDATE. The constant column permits row locking and at most a no-op update; its constraint rejects a changed value. No UPDATE authority on store ID, owner, epoch, required policy or singleton key, and no INSERT/DELETE/TRUNCATE/TRIGGER/DDL authority is granted. Actual role tests must prove shared locking succeeds and all meaningful metadata mutations fail. Dedicated production transition authority is supplied and qualified in #75; P2 handover tests use only the separate disposable maintenance role. Physical identity, column privileges, constant constraints, required relation/index validity and checksummed migration are verified before a qualified binding. Changing a local config flag cannot disable a persisted required fence.

Preserve the existing initializer and v1→v2 migration behavior. Add only an explicit native migration target for v2→v3; normal boot never invokes it. A fresh fenced test store is explicitly initialized then upgraded through reviewed steps. Existing v1/v2 portable stores retain their accepted behavior. Operator configuration must explicitly expect version 3 after verified migration. Previous migration checksums and entity definition/layout identities are not rewritten. Source-ledger drift, interruption, malformed epoch state and unknown migration acknowledgement remain fail-closed test cases.

The fixed consumer rule for a later owner transition is exclusive locking of this same singleton before epoch advancement; the replacement owner is not ready until that barrier commits. Production acquisition and loss/recovery orchestration are deferred to #75 as selected. This section specifies the storage contract needed by that future producer, not its implementation or deployment.

### 13.4 Implementation authorization and execution order

The proposed next authorization is limited to implementing/testing #74 against this document on `codex/issue-74-postgresql-local-unit`, with a Draft PR targeting `codex/postgresql-support`. It includes the adapter, negotiated contract, PostgreSQL executor, explicit fence-metadata consumer support, opt-in SQLite final checks and the scoped real tests. It excludes production owner acquisition/lifecycle, Router business changes, #75/#76 execution, merge, issue closure, deployment, publication, paid calls and production data.

After owner approval, refresh the effective policy/task claim and remote integration head, then implement in this order: (1) native adapter with exact legacy SQLite regressions; (2) negotiated descriptor/attestation; (3) single-client PostgreSQL unit and precommit guards; (4) transaction-side fence metadata/validation; (5) real concurrent/fault/durability tests; (6) clean installed consumer, immutable P2 evidence and Draft PR/HANDOFF. Stop on unexpected source drift or a failed required invariant. Completion still requires owner review of actual evidence, not just this plan.

Current state: documentation only; implementation tests NOT RUN. No implementation approval is inferred from this proposed baseline.

## 14. Execution-phase refinements and evidence

The owner subsequently authorized implementing/testing §13 and a Draft PR. Final qualification is recorded separately in `tests/fixtures/postgresql/qualification-p2.json` and `docs/architecture/postgresql-entity-local-unit-p2-qualification.md`. Historical planning statements above do not claim later tests were unperformed or accepted.

Source-backed refinements preserve the approved safeguards: append-only records retain SELECT/INSERT-only privileges and use exact SERIALIZABLE reads; strict plain-JSON canonical validation rejects Date/Map/class instances because the SDK's broad object helper alone does not reject them. No valid JSON semantics, capacity, Hash policy or financial rule is changed. Actual store identity is also rechecked inside the unit transaction.

Test-only native/process/wire-proxy helpers do not ship a public authority issuer. PostgreSQL may conservatively abort independent transactions under SSI, especially on small-table predicate locks. Tests prove independent progress while another unit is open, then permit a fresh caller attempt only after a confirmed abort and renewed absence check. There is no provider auto-retry or global transaction mutex.
