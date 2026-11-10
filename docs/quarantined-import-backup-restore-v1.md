# XNode — Quarantined Historical Import Backup & Restore v1

Date: 2026-11-06. Acceptance: **PASSED for the shared opt-in capability on Node 22.23.1 with isolated synthetic stores.** This is not Router integration, financial qualification, quarantine release or production readiness.

## Decision and source of truth

Implement a separate versioned host capability around the genuine historical-import owner. Use native SQLite online backup, authenticated encrypted publication, independent original manifest and unit approval, and an explicit new physical-owner binding. Keep the original import protocol and original ownership metadata unchanged.

Complete source reports were read through Drive and checked against local investigation copies:

- [R4-B2 protected migration](https://drive.google.com/file/d/1Dg44mfCVhIEImLyAC2Sn7K0LtN8wXNcw/view).
- [Protected historical import v1](https://drive.google.com/file/d/1bZYvJJ7jPVnvh6vwP4bt312AtLT7iDEN/view).
- [R4-A backup/restore](https://drive.google.com/file/d/16ILtpa7Hce8oZPp99Z2WrP-PuIVrliuw/view).

The actual shared historical-import, SQLite provider, private EntityManager binding, native backup driver and durability tests were inspected. SQLite's [online Backup API](https://www.sqlite.org/backup.html) provides the consistent snapshot; the installed driver's [backup interface](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise) is used directly. No file-copy substitute, provider switch or active configuration change was introduced.

## Exact authored-file inventory

All paths below are relative to `packages/xnode`.

| File | Change |
| --- | --- |
| `src/XEntityManager/EntityHistoricalBackup.ts` | New separate capability, trusted backup/restore/resume APIs, native image validation, encrypted publication, physical ownership rebinding and immutable restore facts. |
| `src/XEntityManager/EntityHistoricalOwner.ts` | New package-private WeakMap of genuine owner contexts and EntityManager aliases. Serialized acknowledgements cannot issue ownership. |
| `src/XEntityManager/EntityHistoricalImport.ts` | Extract the existing reconciliation record validator for independent image checks and register its genuine owner context. Existing v1 options, acknowledgements and import semantics remain unchanged. |
| `src/XEntityManager/XEntityManager.ts` | Alias the existing public import binding to its private genuine owner; retain the existing command-backed commit path. |
| `src/XEntityManager/SQLiteEntityProvider.ts` | Additional fail-closed check for the reserved restore quarantine marker before ordinary initialization can create/open a database. Existing import-meta quarantine protection remains intact. |
| `src/index.ts` | Five additive runtime exports and three new public TypeScript types. No removed exports. |
| `tests/historical-backup-fixture.mjs` | Eighteen synthetic application schemas, thirteen original records and four approved import units. |
| `tests/historical-backup.test.mjs` | Twenty-five capability, preservation, integrity, publication, encryption, ownership, failure and compatibility tests. |
| `tests/historical-backup-worker.mjs` | Isolated child process for backup/restore/resume and owner termination. |
| `tests/historical-backup-durability.test.mjs` | Thirteen SIGKILL boundaries plus cross-process owner exclusion and recovery. |
| `docs/quarantined-import-backup-restore-v1.md` | This sanitized qualification report, produced after packaging; it is an output, not part of the artifact's source-input hash. |

Only four pre-existing source files changed: the import implementation, EntityManager, SQLite provider and root export file. Hash snapshots found no removed baseline files or Router source changes. No package manifest, lockfile, active schema, production setting, credential or other package source changed. Workspace compiled output was not rebuilt in place.

Generated local evidence is the 32-file, read-only content-addressed bundle listed later. Its complete inventory and checksums are in `SHA256SUMS`; it contains nine package tarballs, source and consumer input capsules/manifests, dependency lockfiles, capability acknowledgements, public API comparison, verification results, reproduction/audit helpers and log hashes. No database, encrypted backup, runtime key or generated financial record is included in that bundle. Only this report is synchronized to Drive.

## Public opt-in contract

New exports:

- `ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES` — frozen v1 descriptor, `quarantined-import-backup-v1`, `sqlite-online`, `aes-256-gcm`, `new-owner-rebind-v1`, `hmac-sha256-physical-binding-v1`, quarantine true and financial readiness false.
- `ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME` — protocol fingerprint, not a package signature.
- `backupEntityHistoricalImport(options)`.
- `restoreEntityHistoricalImport(options)` — new destination only.
- `resumeEntityHistoricalImportRestore(options)` — explicit authenticated reopening of a committed restore after close, crash or lost acknowledgement.

New types are `EntityHistoricalBackupOptions`, `EntityHistoricalRestoreOptions` and `BoundEntityHistoricalRestore`.

Backup requires an actual live import/restored-owner object, exact expected capability, new private bundle destination, complete independently approved import units, a scoped key identifier and a 32-byte key. A cloned binding, matching JSON, receipt digest or copied SQLite file is insufficient authority. The live owner is checked before and throughout native backup and before publication.

Restore/resume additionally require the authentic encrypted bundle, independently approved original manifest and its digest, exact original entity definitions, original capacity profile, destination, and separately chosen restore GUID. The existing unchanged v1 factory validates that approval in an empty private schema-verifier store. This derives the physical schema and validators independently of snapshot claims. No REST/WS command provisions these capabilities and no public/model operation was added.

**Approved units are deliberate authority, not an inferred plan.** Existing v1 receipts contain the original unit hash but not all guards/leases. The new contract requires the host's original approved units to verify every receipt's exact proposal hash, create inventory, deterministic receipt identity, per-unit capacity, full source coverage and uniqueness. It never reconstructs missing financial evidence or guesses the original proposal. A missing or altered plan fails closed.

Errors are redacted identifiers: `E_ENTITY_HISTORICAL_BACKUP_REJECTED`, `E_ENTITY_HISTORICAL_RESTORE_REJECTED`, or a failed reconciliation with `E_ENTITY_HISTORICAL_RESTORE_INTEGRITY`. Rejected or ambiguous operations never advertise readiness or successful restoration.

## Backup validation and publication

1. Require the actual active owner's opaque registry context and retained SQLite EXCLUSIVE owner transaction; validate its pinned path/inodes and original schema/quarantine metadata.
2. Verify the complete manifest inventory, exact definitions, actual physical DDL including indexes/triggers, provider metadata/index definitions, native integrity/FK checks, physical indexed columns, all original GUIDs, Hash bytes and canonical timestamps.
3. Verify complete progress and every append-only receipt against the approved unit plan. Incomplete sources cannot publish backups.
4. Call the native driver's `.backup()` into a private 0700 scratch directory with 0600 files. Recheck ownership on progress callbacks. Include the complete database: eighteen application tables, both original import-maintenance tables and both provider-maintenance tables. Original restore-history tables, if present, are also included.
5. Independently validate the completed native image and compare full record, receipt, original metadata, schema, physical table-content and restore-history roots against the validated source.
6. Encrypt both provenance metadata and the whole SQLite image using AES-256-GCM with a fresh 96-bit nonce and 128-bit tag. Authenticate the bounded public envelope as AAD. No source manifest, schemas, records or receipts are published in plaintext.
7. Claim the destination with atomic no-replace `mkdir`, move encrypted content, and publish the authenticated envelope last. Sync files and directories. Two concurrent publishers cannot replace the same destination. A complete bundle contains exactly `envelope.json` and `snapshot.gcm`.

Complete imported records are immutable. Therefore an authorized overlapping import operation after completion is an idempotent replay; that replay was exercised during native backup progress. Incomplete import states are explicitly rejected. A reader held open before the final import commits forced committed data to remain in WAL; the native snapshot included all thirteen records and four receipts.

## New owner and permanent quarantine

Restoration authenticates/decrypts and validates the snapshot, original approval, exact schema and complete receipts **before creating the requested target**. The requested destination must not exist, must have a private canonical parent, and is never overwritten or adopted by the create API.

A reserved durable `historical-restore.pending` marker blocks ordinary provider initialization even if restoration stops before a complete SQLite image has been written. It remains a permanent restriction after success; its name is not a readiness signal.

The restored target receives its own genuine `owner.sqlite` EXCLUSIVE transaction, pinned database/owner/marker/directory identities and canonical destination. Original `entity_historical_import_meta` bytes, original ownership identities and every original import receipt remain unchanged. The old import owner is not impersonated, and the v1 importer cannot adopt the relocated database.

The separate append-only `entity_historical_import_restores` table records the new restore identity, authentic snapshot/backup identities, independently approved manifest identity, original metadata/schema hashes, prior restore-history root, current physical binding and restore time/runtime. All original tables and financial history are preserved; no historical financial operation is replayed. Here the extra table is maintenance provenance, not a financial entity.

Each new current restore fact is sealed using a domain-separated HMAC-SHA256 with the authenticated source snapshot key. Resume verifies this seal and actual path/inodes under the exclusive lock, then compares complete records, original physical-content root and receipts independently. A copied target cannot authorize itself by editing ownership JSON and recreating matching trigger DDL. Previous facts remain immutable and authenticated through subsequent encrypted snapshots; a new restore appends one fact rather than rewriting the prior owner.

Returned restored handles expose reconciliation and close, with an explicit restore acknowledgement. They do not expose source import commits, ordinary CRUD, registration or financial execution. Both original and restored targets always report quarantine true and financial readiness false. No release API exists.

## Crash, ambiguity and storage failure evidence

| Boundary / scenario | Verified result |
| --- | --- |
| Backup SIGKILL before native work, during progress, after native completion, before encrypted write, before publication, after target reservation | No authentic completed artifact is claimed. Private partial output is unavailable; a new uniquely named backup and subsequent successful restore preserve all thirteen/four facts. |
| Backup SIGKILL after publication or lost acknowledgement | The completed authenticated bundle successfully restores. Retrying never overwrites it. |
| Restore SIGKILL after authentication, before/after image write, before rebind commit | No committed new owner is adopted. A partial target remains quarantined/unavailable; a fresh-target retry successfully restores thirteen records/four receipts. Rejection is not counted as recovery. |
| Restore SIGKILL after rebind commit or before acknowledgement | Explicit authenticated resume succeeds across process restart and reconciles the committed fact exactly once. |
| Paused restored owner and competing process | Second owner is rejected while the EXCLUSIVE transaction remains held. SIGKILL releases the OS-backed lock; explicit authenticated resume succeeds, without a timed stale-owner takeover. |
| Partial write ENOSPC / EIO injection | Actual filesystem write calls were injected to write a prefix and fail. Backup never publishes completion; partial restore cannot resume or gain ordinary access. A fresh restore subsequently succeeds. This is failure injection, not a claim of physical disk exhaustion testing. |
| Wrong/missing keys, changed key ID/AAD, corrupted/truncated ciphertext, extra bundle content, wrong approval/definitions/unit plan | Authentication or full validation rejects before target creation. |
| Source corruption, missing rows, altered DDL/provider metadata, replaced source inode, changed receipt proposals | Publication is rejected. |
| Forged current binding with trigger DDL restored | Resume is rejected; physical ownership requires the authenticated seal and actual identities. |
| Repeated backup/restore | Original rows/receipts remain exact; a second restoration appends a second immutable maintenance fact. |

SIGKILL tests qualify process termination, not power loss or storage-device fault tolerance. WAL/FULL/FK and explicit file/directory syncs were checked; no stronger hardware guarantee is fabricated.

## Build and immutable artifact

Node 22.23.1, npm 10.9.8, pnpm 10.25.0; native better-sqlite3 12.11.1, SQLite 3.53.2, ABI 127. The package still declares `node >=22.0.0`; the engine range and all dependencies are unchanged. No new dependency or alternate SQLite driver was introduced.

The source capsule contains 718 exact source/build inputs, including declared manifests, the existing pnpm lock, generated private workspace selection, nine runtime packages and two source-built UI/dashboard fixtures needed by existing Vibe tests. Builds started without compiled workspace output or installed modules in that private stage. Installation used the frozen declared lock, ignored installation scripts initially, disabled the side-effects cache, and explicitly rebuilt better-sqlite3 from source. No previously built native binary was copied.

The nine-package build order is Core, Node Core, File Service, MCP, Vibe, Node, Agent, Agent Channels and XNet. UI and Dashboard fixtures were then built from source. The original Core changelog was included; all eight dependency tarballs are byte-identical to the preceding approved historical-import candidate. Only the Node tarball changes.

Reproduction outline, with Node 22.23.1 first on PATH:

```sh
# In a new private source directory, extract source-inputs.tgz.
pnpm install --frozen-lockfile --ignore-scripts --side-effects-cache=false
# Resolve better-sqlite3 from that installation, then run inside its package directory:
npm rebuild --build-from-source
# Run npm run build for the build order in source-inputs.json; build the two fixture packages.
# Pack each runtime package with pnpm pack --pack-destination PRIVATE_d7a103d1bf5bba49ab01ad4c846c78a102ac61e789df0c897faf789b59945019S.
```

The observed install additionally used an existing offline package cache; the cache supplied locked package archives and source headers, not precompiled native modules. The full source/dependency identities and build logs are hashed in the bundle.

An independent clean consumer installed all nine local immutable tarballs with a separate npm lock and `npm ci --offline --build-from-source`. Router/provider/Agent/Pulse source compiled against that installation. A second fresh consumer installation repeated the native source build and artifact checks. All **879 distributed files** match the nine tarballs exactly. No arbitrary registry resolution of `@xpell/node@2.0.7` was used as capability evidence.

Candidate location:

`packages/xnode/.cache/quarantined-import-backup/d7a103d1bf5bba49ab01ad4c846c78a102ac61e789df0c897faf789b59945019/xpell-node-2.0.7.tgz`

| Identity | SHA256 |
| --- | --- |
| Node tarball | `d7a103d1bf5bba49ab01ad4c846c78a102ac61e789df0c897faf789b59945019` |
| Complete nine-package candidate manifest | `fca0788afda7ddf2464ebc3e744c836d73463641509f93c24ed8514867fb38ed` |
| Source-input file-set identity | `a7c4ac7f9967891d48a3d9fc051e64730214335073e3fa1bdbfddc0c492f2ec3` |
| Source capsule | `ce6b9cc38c271f8d081cf243a4c143437b59bf97524a6e509137309d323785ad` |
| Existing pnpm lock | `24c7fbac90de221761643f8975d41c1710c34a0a5fc1dfa2d2ab6124a031db25` |
| Clean consumer npm lock | `696e30c1bbfc3d15a046e072b39d720658971da342895e55d787dddd2983ac1b` |
| Installed nine-package file root | `e369a82795105746b1f7c7516fbac00cbb0cec14a1275cf7212f207a5a10c03e` |
| New backup protocol fingerprint | `c83bbb459a6f5665b6a544ddd6d26cac74c3f121d771bf18fda2aaecc2875245` |

`candidate.json` lists every exact dependency/artifact/source-manifest identity. `consumer-inputs.tgz`, its manifest, lockfile and verification helpers preserve the isolated consumer inputs. Existing package version strings are unchanged and are not treated as proof of capability. The final report is intentionally outside the sealed build-input capsule to avoid a checksum self-reference.

## Regression results

| Verification lane | Result |
| --- | --- |
| New backup/restore tests | **39 passed**, 0 failed: 25 unit/security/composition tests and 14 process-durability tests. |
| All XNode source tests | **169 passed**, 0 failed/skipped/TODO; includes the 39 new tests. |
| All XNode tests against independently installed final artifact | **169 passed**, 0 failed/skipped/TODO. |
| Existing XNode `npm test` script | Passed. |
| Core / Agent / Agent Channels / XNet consumers | **171 passed**, 0 failed. |
| Provider regressions, mocked transports | **36 passed**, 0 failed; no live provider calls. |
| MCP package regressions | **33 passed**, 0 failed, including final installed-artifact execution from the required package directory. |
| Router focused financial/payment/refund/signup/auth/Gateway/semantic/provider/schema regressions | **950 passed**, 0 failed; **2 skipped and 2 TODO**, separately listed below. |
| Focused Pulse SQLite backup/restore and recovery integration | **15 passed**, 0 failed. |
| File Service and Vibe existing package tests | Passed, with source-built UI/dashboard fixtures for Vibe. |
| Direct shared API with actual copied Router schemas and existing synthetic legacy fixture | Passed: all 18 entity tables, 13 original rows, 4 receipts; exact Account/User/Key GUIDs, bcrypt/API-key hash, lifecycle timestamps, pricing snapshots and integer Ledger values preserved. Both targets remain financially unavailable. |

All source tests use synthetic temporary stores. The Router-shaped proof exercises the shared API directly; it does not modify or bypass Router's production runtime pinning or implement its backup integration.

The existing public runtime exports grow from **160 to 165**, with zero removed exports. Existing declarations, package metadata/dependencies, default CRUD, standard 8/4/8/65536 and expanded 10/5/8/65536 profiles, capacity acknowledgements, Hash `create-and-preserve-v1`, import `preserve-historical-v1` fingerprint, CAS, expected-record checks, uniqueness/append-only restrictions, rollback, owner fencing and WAL/FULL/FK checks remain green.

The two Router TODOs remain unresolved and are **not passed tests**: nested `_index._enum` enforcement by SQLiteEntityProvider, and schema-only safe-integer/cross-field credit arithmetic. Application-level validation remains mandatory. The two skips are live Google Document AI and vision smoke tests, deliberately not authorized here.

Initial test-environment/harness runs were corrected and excluded from acceptance: thirteen restricted-environment localhost `EPERM` failures; an empty-file MCP selector that accidentally invoked automatic discovery and was interrupted; and two MCP source-fixture failures from the wrong working directory. Explicit-file/package-directory reruns and the complete permitted localhost suite passed. No implementation assertion was weakened to conceal them.

Known broader Pulse failures are carried forward, not rerun or counted passed: truncated scenario-child JSON output, and the stale web-identity expectation omitting `agent_profile`/`owner_user_profile`. The known Node 24 native `RemoveEnvironmentCleanupHook` assertion also remains unqualified. The broader Pulse/Node 24 matrix and live provider/browser UI certification are not claimed.

## Remaining limits and R4-B3 handoff

There is no unresolved shared ownership-handoff blocker within this tested capability. Operational limits remain explicit:

- v1 images are limited to 512 MiB with bounded 32 MiB encrypted metadata and use bounded in-memory encryption/decryption buffers. Larger/streaming formats require a separately versioned implementation.
- Private plaintext scratch is necessary for native SQLite image validation. Completed backups contain encrypted content only. SIGKILL may leave private scratch/partial directories; an encrypted host volume, controlled scratch retention and separately authorized cleanup remain deployment prerequisites. Secure erase is not promised.
- Host key custody, independently trusted source/manifest/unit approval, immutable artifact verification and retention of the authenticated original bundle/key for explicit restore resume remain required. A backup key or checksum alone never authorizes financial execution.
- Interrupted pre-commit destinations are never adopted or overwritten. Recovery uses a fresh destination; committed ambiguous restores use authenticated explicit resume. No silent repair or quarantine-release mechanism was added.
- The existing nested-enum/integer-schema gaps and incomplete original financial evidence do not disappear through faithful preservation. These targets remain financially unqualified.

A separately approved **R4-B3 Router integration** should:

1. Verify this complete nine-package artifact set and source/lock identities, then update only isolated candidate pins/fingerprints. Do not use the package version string or protocol hash as an artifact signature.
2. Negotiate the exact new capability/runtime, retain the genuine import owner, and pass the independently approved original manifest, exact definitions, capacity and approved units into backup/restore.
3. Provide Router-side encrypted-bundle approval, source/key custody and durable restore context; expose no public capability issuance or direct persistence bypass.
4. Add a quarantine-aware inspector for the complete import schema, original two maintenance tables, provider tables, optional immutable restore-history table and permanent restore marker. The R4-A ordinary-store inspector/pins must continue rejecting incompatible import stores.
5. Exercise the product's real approval/broker paths, ambiguity/restart handling, transport denials and preserved-original-history reconciliation without asserting financial readiness.
6. Keep financial qualification, activation, real-data migration, quarantine release and R4-C behind their own approval and acceptance gates.

**Acceptance: PASSED for this shared synthetic Node 22.23.1 extension. R4-B3 may proceed as a separate implementation task. Router integration, active runtime pins, real migration/activation, npm publication and deployment were not performed.**
