# Protected historical import v1

2026-11-05. Shared XNode extension for isolated historical preservation only.
No Router migration, activation, financial qualification or R4-C is implemented.

## Separate trusted authority

`bindEntityHistoricalImport(options)` is trusted server bootstrap, analogous to
`bindEntityLocalUnit`, with an independent immutable descriptor:

```json
{"_version":1,"_policy":"preserve-historical-v1","_guid":"preserve","_hash":"preserve-valid-bcrypt","_timestamps":"preserve-canonical-utc","_writes":"source-bound-creates-only","_receipt":"atomic-append-only-v1","_destination":"new-quarantined-v1","_financial_ready":false}
```

Export: `ENTITY_HISTORICAL_IMPORT_CAPABILITIES`. Export
`ENTITY_HISTORICAL_IMPORT_RUNTIME` fingerprints this descriptor and the unchanged
Hash/capacity descriptors together. It identifies the protocol contract, **not**
a cryptographic runtime artifact attestation; the host must independently verify
its exact package/dependency artifacts before binding.

Options contain `_expected_capability` (exact full descriptor), `_destination`
(new private directory), `_manifest`, `_manifest_sha256` (independent trusted
approval anchor), `_entities` (exact target definitions), optional fixed
`_capacity_profile`, and trusted test/host `_clock`/`_fault` hooks. Extra selectors
and unknown options fail closed. The implementation snapshots manifest,
definitions, digest, capacity and hooks before asynchronous initialization.

There is no command or transport that issues this authority. EntityManager keeps
handles in its private registry. The private commit operation requires its
issued unpredictable key, rejects transport `_ctx` and accepts no policy or
scope overrides. No model/public operation catalogue entry is added. A serialized
object cannot issue the provider's opaque per-transaction preservation token.

The frozen binding exposes `_import`, `_capacity`, `commit(unit)`, `reconcile()`
and `close()`. Successful commits acknowledge the exact descriptor plus source,
run, destination, schema-root, manifest and runtime-contract identities. Results
contain a genuine receipt, durability and quarantine flags; they contain no
imported records, credential strings or plaintext. A failed acknowledgement is
not permission to fall back to CRUD or declare completion.

## Manifest and approval boundary

A version-1 manifest contains exactly:

- `_version: 1`, `_run_id`, `_destination_id`, `_source_id`: original source engine
  GUID and explicitly allocated import/destination GUIDs.
- `_source_root`: verified frozen source file/content root; `_record_root`: full
  approved source record inventory root; `_captured_at`: canonical UTC timestamp.
- Exact canonical `_env`, `_app_id`, and `_runtime` contract fingerprint.
- `_entities`: entries containing `_entity`, `_schema_sha256` and `_records`.
  Each record entry contains only original `_id` and approved `_sha256`.

Fingerprints use SHA256 over `localUnitCanonical`: finite JSON, sorted object
keys, unchanged array order, no lossy/non-JSON/prototype keys. Entity schema
fingerprints cover the **complete exact supplied definition**, including schema,
indexes and append-only setting, before ordinary provider runtime-field injection.
Runtime-normalized schemas and physical identity are additionally checked by the
existing native unit writer. `_record_root` fingerprints the flattened inventory
of `{_entity,_id,_sha256}`, sorted lexically by canonical `[_entity,_id]`. The
manifest approval anchor fingerprints the complete canonical manifest.

Definitions must explicitly select SQLite/app scope and may specify append-only;
caller database paths or other storage permissions are rejected. Scope/name
normalization must not change the approved identities. Duplicate record GUIDs
within an entity, including case variants, duplicate entities, malformed roots,
wrong runtime/version, schema mismatch and source-root mismatch are rejected.
The inventory has explicit defensive ceilings of 128 entities and 100,000 source
records; this is not production-scale qualification.

A matching digest proves consistency with the **independently trusted approval
anchor**. It does not prove that a caller's invented source ever existed. The
trusted host must verify the frozen XDB source and approve its engine identity,
file roots, complete records and definitions before supplying this anchor.
An untrusted request supplying both a forged manifest and its own checksum is
not an authorization source. This extension never reads a live XDB directory.

Version 1 performs no source transformations, defaults or lossy filtering.
Records must equal the approved fingerprints in full. Derived Router fields,
relationship classification, financial evidence and historical ambiguities
remain the separately approved R4-B preflight's responsibility. An import root
cannot prove absent financial history never existed.

## New destination, ownership and permanent quarantine

A first binding exclusively creates a new private directory and two mode-0600
files, `database.sqlite` and `owner.sqlite`. Existing unrelated directories/files
are refused. A same-run restart may reopen only its authentic completed import
metadata with matching manifest, scope, schema, destination ID, canonical path
and file device/inode identities. Copied/replaced destination or owner files,
wrong runs and incomplete initialization fail closed; initialization crashes are
not silently repaired. Keep the manifest/anchor independently available.

Exclusive ownership is an immediate SQLite `BEGIN EXCLUSIVE` on the separate
permanent owner file, held for the handle lifetime. It does not hold the main
WAL writer transaction open. A paused owner remains exclusive; kernel process
termination releases ownership. There is no lease timeout takeover, stale-lock
removal or file replacement. Every transaction/reconciliation checks the held
owner transaction and pinned main/owner file identities. This uses the existing
native dependency, adds no package and raises no Node engine requirement.

The durable import marker quarantines this database. Ordinary SQLiteEntityProvider
initialization rejects it, including ordinary EntityManager registration. Import
providers are privately issued and never registered as ordinary application
entity handles. Source tables reject UPDATE/DELETE, and receipts reject both
operations with native triggers. No historical overwrite, credential replacement,
release, activation or normal-writer permission is provided.

**Even a complete reconciliation returns `_quarantined:true` and
`_financial_ready:false`.** There is deliberately no release API in v1. A future
approved integration must perform independent product/financial qualification
and coordinate any activation contract; it must not remove the marker or use an
older runtime as a bypass. Filesystem ownership/host isolation and verified
runtime selection remain required. This is not protection against an adversary
with arbitrary native SQL, filesystem or trusted-code execution privileges.

## Preserving records and bounded receipts

`commit` accepts `_records`, optional existing `_lease` and `_valid_until`; it
does not accept caller `_unit_id`. Each approved source create has `_entity`,
original `_id`, `_expect:null` and complete `_create`. Read-only guards may use
full `_expect` records from the same approved inventory. Updates/deletes and
unapproved IDs/records fail closed. Original GUIDs and every supported field
value are preserved. ObjectId values and relationship closure retain the ordinary
provider schema contract; the approved source/preflight must establish the
meaning and integrity of cross-record relationships. No relationship is inferred.

Historical Hash fields require canonical 60-character bcrypt with revision
2a/2b/2y, valid base64 padding bits and cost 04–31. No plaintext, unsupported format,
replacement password, hash computation or credential reconstruction is used.
Required and supplied optional Hash values must be valid. Hash schema defaults
and enums are unsupported and rejected before destination creation, so credential
values cannot enter schema metadata through those options. Historical `_created_at`
and `_updated_at` must be exact canonical UTC millisecond ISO strings, creation
not later than update, and update not later than source capture. Other fields
must pass existing provider validation without coercion/truncation. Required
fields cannot be absent; undeclared fields are rejected. Missing optional fields
remain absent, including fields with schema defaults. Alternate date spellings
that would require normalization are unsupported rather than rewritten.

The original fixed limits apply **including the genuine maintenance receipt**:
standard-v1 has 8 records/4 writes/8 types/65,536 bytes; expanded-v1 has
10/5/8/65,536. Thus a batch imports at most three or four source records,
respectively. The receipt consumes one record, write, type and its complete bytes.
Read guards consume record/type/byte capacity. A source inventory may span more
than eight types across multiple batches; each actual native unit stays within
eight including maintenance. Existing local-unit bindings retain their original
eight-type binding limit and unchanged capacity/Hash descriptors.

The receipt is a new current maintenance fact in the provider-owned
`entity_historical_import_receipts` table, **not** a historical Ledger, settlement,
financial audit or pricing fact. Its deterministic GUID binds run/manifest and
the sorted created-record fingerprints. It records the exact proposal digest,
source references/root and actual trusted commit-clock time. Fingerprinting
occurs only after historical field/credential validation; no plaintext-password
proposal is hashed. Receipts contain neither imported records nor Hash strings.

The existing `SQLiteEntityProvider.commitLocalUnit` native transaction is reused.
Only a genuine private import token enables preserving preparation. In one
immediate WAL/FULL/FK transaction it rechecks ownership, schema/DDL, full expected
records, original lease/expiry checks and uniqueness, inserts approved records,
and inserts the receipt. Raw source unit plus complete receipt and native result
data stay within the fixed byte budget. Any pre-commit fault rolls everything
back, including the receipt. No notification exposes historical credentials.

## Restart, ambiguity and independent reconciliation

An identical batch replay reopens the existing receipt within the native
transaction and verifies its identity/proposal and all recorded source values.
It returns the original receipt with `_replayed:true` and creates nothing.
Changed proposals, overlapping regrouped writes, uniqueness conflicts or partial
unreceipted rows are not silently converted into success. Reconcile before
planning retries. An error or lost/mismatched commit acknowledgement means an
unknown outcome; it does not prove rollback and never authorizes a blind replay
of a financial business operation.

`reconcile()` opens an independent database read transaction, checks integrity,
FK status, pinned DDL/metadata and ownership, then validates every stored original
record and its physical indexed/timestamp columns against JSON and approved
fingerprints. It independently checks receipt identities, roots, exact source
coverage, absence of extra/duplicate imported rows and one receipt coverage per
present source record. Missing expected records produce `_complete:false`; extra,
corrupt or unreceipted records fail. Counts and roots are returned, with no raw
source or credential values. Every restart repeats this verification from the
trusted manifest and stored evidence; no cached success creates readiness.

## Verification record

Final build/provenance, exact changed-file inventory, test results, remaining
blockers and Drive synchronization are appended after immutable packaging. The
packaged contract precedes the final evidence appendix to avoid a self-referential
artifact checksum.

### Acceptance and source reports

**PASSED for the authorized shared Node 22.23.1 isolated synthetic scope.**
This is not a completed Router migration, financial qualification, production
readiness or R4-C. Broader Pulse/Node 24 qualification remains unresolved as
separately documented below; those failures are not relabeled as passing.

Read completely: [R4-B blocked migration/proposal](https://drive.google.com/file/d/1bbBo2RCvmm3QHtn41zCfK5NXHhTUpc7O/view),
[atomic Hash contract](https://drive.google.com/file/d/1Z_v_1R7aqoCx2JazJgvfSs2y8W17xDR1/view),
and [R4-A backup/restore](https://drive.google.com/file/d/16ILtpa7Hce8oZPp99Z2WrP-PuIVrliuw/view).
Applicable Xpell foundation/core/node/XDB/XVM/Flow/XVibe contracts and repository
instructions were applied. Google Drive skill/tooling handles this sanitized
report's synchronization; no source data or artifact archive is uploaded.

### Exact authored-file inventory

Against this task's starting content snapshot: **three modified and six new files**.
All paths below are relative to `packages/xnode`.

| File | Change |
|---|---|
| `src/XEntityManager/EntityHistoricalImport.ts` | New fixed capability/types, manifest approval, new-destination ownership/quarantine, bounded source-bound commits, maintenance receipts and independent reconciliation. |
| `src/XEntityManager/SQLiteEntityProvider.ts` | Add private-token preserving validation and native transaction integration; reject ordinary provider access to import quarantine; independently verify indexed rows. |
| `src/XEntityManager/XEntityManager.ts` | Add trusted binder and private issued-handle registry/commit operation; preserve ordinary operations and local units. |
| `src/index.ts` | Add binder, two descriptor/runtime exports and types; retain prior exports. |
| `tests/historical-import-fixture.mjs` | New synthetic historical record DTOs and approved manifest builder. |
| `tests/historical-import.test.mjs` | New 35-case preservation, boundary, security, ownership and reconciliation suite. |
| `tests/historical-import-worker.mjs` | New isolated real-process import/restart actor; no raw record/credential output. |
| `tests/historical-import-durability.test.mjs` | New nine-case process-crash, lost-acknowledgement and competing-owner suite. |
| `docs/protected-historical-import-v1.md` | New public contract, evidence, remaining gates and handoff. |

The generated ignored `.cache/historical-import/` bundle is separately enumerated
by its `SHA256SUMS`. Every other captured pre-existing file remains unchanged,
including the entire workspace `dist`, package metadata, canonical root lock,
existing Hash/local-unit tests and the atomic Hash contract implementation.
No Router/Pulse/MCP workspace implementation, test, pin, active setting or schema
was edited. Existing unrelated and parallel changes were preserved.

### Backward compatibility and security evidence

All 86 pre-existing XNode cases remain green, and the 44 new import cases pass.
The public capacity descriptor remains byte-for-byte version 2 with 8/4/8/65536
and 10/5/8/65536 fixed profiles. The version-1 `create-and-preserve-v1` descriptor
and binding/commit semantics are unchanged. Ordinary protected units continue
rejecting imported bcrypt and supplied runtime timestamps. Ordinary CRUD's
existing bcrypt and timestamp behavior is not globally tightened or relaxed.

The new suite proves complete GUID/field/link preservation and byte-identical
historical timestamps/password hashes, followed by real bcrypt verification.
It covers multi-batch inventories of 13 types without exceeding any individual
unit limit, immutable acknowledgements, source/schema/runtime/unknown-option
rejection, duplicate GUIDs, source record mismatch, native uniqueness rollback,
expected-null CAS for overlapping creates, full guards, lease rejection, changed
owner inode and competing-owner rejection. Neither malformed input nor an
existing destination is converted into ordinary CRUD.

Required/missing/invalid Hash values, unsupported prefixes, contradictory/future/
noncanonical timestamps, unknown fields and coercible numeric input are rejected
without partial rows. Hash defaults and enums are rejected before creating the
destination, preventing schema metadata from carrying credential values. No
Hash default is silently applied. Optional non-Hash defaults remain omitted
when absent from the approved original record.

Tests inspect native UPDATE/DELETE rejection on source rows and maintenance
receipts, altered-DDL rejection, partial-source quarantine, raw and receipt byte
budgets, standard/expanded write/record limits, and refusal of degraded FULL.
Indexed and timestamp columns are independently compared with preserved JSON.
A failed/rejected import is not counted as successful historical preservation.

Leakage checks scan synthetic destination SQLite/WAL/owner files for the generated
plaintext and capture successful/error/reconciliation responses and logs for
both plaintext and stored bcrypt strings. No imported credential is returned or
broadcast by the import API. Schema metadata contains bounded source identities
and roots, not the full source inventory or source records. Proposal/receipt
fingerprinting happens only after preserved-record/Hash validation.

These checks verify the supported JSON/provider contract. They do not infer
business relationships, normalize identities, fabricate missing financial proofs
or implement schema-only monetary validation. Existing nested-index enum and
safe-integer/cross-field financial limitations remain product/preflight gates.

### Crash, rollback and restart evidence

Injected failures after native writes 1–5, including the fifth-write maintenance
receipt, and before commit leave zero imported records and zero receipts. A
uniqueness error rolls back all earlier writes. An overlapping regrouped batch
fails native expected-null CAS and imports none of its remaining records.

Actual SIGKILL tests run after writes 1–5 and immediately before/after commit.
Fresh processes reopen under the same approved manifest, independently reconcile
counts/roots, verify exact preserved record fingerprints and actual bcrypt, and
check one receipt with no duplicate rows. Before-commit kills expose no imported
rows/receipt; an authorized retry imports all four records plus the receipt.
After-commit kills retain all four records and one receipt. A second restart
returns the identical evidence and idempotent replay outcome.

Lost acknowledgement returns failure/unknown outcome despite a committed unit.
Reopening and reconciliation establish the complete original result before any
retry. The exact batch replay is verified read-only against its original receipt.
A paused owner rejects a second process; SIGKILL releases the permanent owner
inode's kernel lock, and a new owner resumes without deleting files or timed
takeover. Complete reconciliation still withholds financial readiness.

This proves native transactions and process-crash recovery on the tested local
runtime. It does not certify sudden power loss, torn sectors, storage firmware,
NFS/remote locking, full disks or production-volume behavior. Initialization
interrupted before complete metadata remains quarantined and unsupported for
automatic adoption; use another new destination after explicit review.

### Clean build and immutable artifact

Node **22.23.1**, npm **10.9.8**, pnpm **10.25.0**, XNode TypeScript **5.9.3**.
The final build captured 475 hashed source/build/document/test inputs for nine
packages. A fresh frozen offline installation reused only dependency source
packages, disabled installation scripts/side-effects caching, explicitly rebuilt
SQLite from source and built all nine packages in order. No workspace `dist`,
node_modules, environment file, work record or borrowed native binary was used.

A separate empty consumer installed 227 packages from exact local tarballs and
its integrity-bearing npm lock, compiling native dependencies from source. A
second fresh installation ran the native-driver-absence/ownership tests alone.
Installed runtime identities stay inside those consumers. Actual readback is
better-sqlite3 **12.11.1**, SQLite **3.53.2**, bcryptjs **3.0.3**, node-fetch **3.3.2**
and ABI **127**. Engine compatibility remains `>=22.0.0`; no dependency was added
and no source package version was bumped.

Immutable candidate, relative to this package:

`.cache/historical-import/5ea7c2baae2469757b215816d61be40f75725625f69479ecb49b85f606a489db/`

Artifact: **`xpell-node-2.0.7.tgz`**. SHA256:

`5ea7c2baae2469757b215816d61be40f75725625f69479ecb49b85f606a489db`

| Provenance | SHA256 |
|---|---|
| Source set identity | `e1d1cdc6991397e2715e34617273366c5cfe1c6e80b7fd49c1bce5238798d573` |
| Canonical source pnpm lock | `24c7fbac90de221761643f8975d41c1710c34a0a5fc1dfa2d2ab6124a031db25` |
| Source archive | `2cc5cb9fabb563a843e58bd4cc6c11fd9f5430b9cf1e10778367fdd61d32f899` |
| Nine-package candidate manifest | `8d42186947ea5655876faa5689f74f07da38d1be339071093dc69c212fdb3350` |
| Tested independent consumer lock | `103ec3cf6b5cc9562c6adab2f6539429d99783c82379d4e1731fb596cb5014d0` |
| Installed distributed-file root | `370bb828a6f6f34bfab398d9da8674e1ea5f42d163abe5c7c9bd8e4945d5258c` |
| Verification manifest | `74f263160568282235ce67e10157ed22ec8baf0095e3c53f3f264e731f1a861e` |
| Source-only consumer capsule | `d1de3acebec24a74ffa451f9f91b52c3171c0e9036aac7cb55ac3f6a7abc3811` |

Every one of 873 distributed files from all nine tarballs was compared against
the independently installed bytes. All 157 previous namespace exports remain;
this extension adds three runtime exports, for 160. The eight non-XNode package
tarballs are unchanged from the prior approved Hash bundle. `candidate.json`
records their exact versions, tarball/manifest SHA256s, complete export set and
source identities. Both full dependency lock contexts, source archives and
file-level manifests are included, with no installed modules/native binaries
inside the source reproduction capsules.

`acknowledgements.json` records actual original capacity/Hash acknowledgements,
new import binding/commit acknowledgements, verified original descriptors,
WAL/FULL/FK, incomplete/complete reconciliation and restart replay, without raw
source records or credential values. Files in the new bundle are 0444 and its
directory 0555; consumers must still verify SHA256 rather than trust permissions
or the reused package version. Nothing was published or installed into active
Router pins. The final evidence appendix is added after packaging; the artifact
contains the contract before this appendix, avoiding a self-referential checksum.

Reproduction uses the existing source-only preparation/packing scripts, frozen
source lock and recorded build order. Build under the pinned Node/npm/pnpm,
explicitly compile the native addon, then pack after the source build completes.
For independent consumption, unpack `consumer-inputs.tgz`, provide the nine
verified tarballs in `artifacts/`, and run source-native offline `npm ci` against
its lock. The bundled verifier takes consumer root, output JSON path and prior
candidate manifest. Local test aliases must resolve to that installation.

### Final regression results

| Lane | Result |
|---|---|
| New historical import unit/security/native/process coverage | **44 passed**, no failures/skips/TODO. |
| All XNode tests in the final clean source build | **130 passed**, no failures/skips/TODO. |
| Same tests against independently installed final tarballs | **130 passed**, no failures/skips/TODO. |
| Existing XNode package script | Passed, including build and generic/conformance script. |
| Core, Agent/Channels, XNet and Providers compatibility | **207 passed**, no failures/skips/TODO. |
| MCP existing package tests | **33 passed**, no failures/skips/TODO. |
| File Service existing package script | Passed. |
| XVibe existing package script | Passed with freshly source-built UI/dashboard fixtures. |
| Router FinancialIntegrity, SpendingSafety, AimeAuthModule, XAIRouterModule, AtomicSignupGate and AtomicSignup | **260 passed, 2 existing live-call skips**, no failures/TODO (262 cases). |
| Router native absence/ownership/readiness/default FS/REST/WS in separate installation | **13 passed**, no failures/skips/TODO. |
| Focused Pulse storage-hardening/recovery/WhatsApp-XNet and Starter SQLite policy | **26 passed**, no failures/skips/TODO. |

All final required shared/selected-consumer Node-22 lanes pass. Repeated source,
installed-artifact and corrected-fixture probes are separate lanes, not added
into a misleading unique-test total. The two skipped live Document AI/vision
checks did not make external calls and are not successful acceptance cases.

Initial iterations exposed missing XNet build output after an early compilation
failure and one missing static Router view/flow fixture. Completing the full
source build and staging those definitions corrected the harness, without
changing consumer tests/runtime logic. Final coherent runs above have no such
failures. Final security review also added rejection/tests for Hash schema
credential defaults/enums, then repeated the clean build, immutable packaging,
independent install and complete final checks on the corrected artifact.

For the required engineering categories: unit/security, command/provider pipeline,
persistence/index identity, retry/idempotency, cross-entity composition, native
rollback/process restart and clean builds all passed for this shared contract.
No actual XDB directory extraction or Router migration is claimed: synthetic
historical JSON record DTOs use XDB GUID/runtime-field conventions; genuine
source freeze/approval remains the R4-B host's responsibility.

Broader **known Pulse failures** are carried forward, not rerun or marked passed:
its scenario child can exit 0 with a truncated 64,603-character JSON result line
that fails parsing at position 64,581; its web-identity assertion omits existing
`agent_profile`/`owner_user_profile` types. The prior occupied-port skip also
remains an independent environment condition. This task reran the focused Pulse
lanes above and did not alter a service on port 3111.

The **known Node 24 failure** is the native better-sqlite3
`node::RemoveEnvironmentCleanupHook` assertion `(env) != nullptr`, reproduced in
the earlier Hash-runtime task. Node 24 and the broader Pulse matrix were not
recertified for this candidate. Their issues remain open; engine range was not
raised or rewritten to conceal them. Full Router R4-A/R4-B acceptance with changed
artifact pins is likewise not claimed: their existing pinned-runtime verifier
must reject unapproved replacement artifacts until separate integration approval.

Local evidence is under `/private/tmp/xnode-import-evidence`; complete log hashes
are in the sealed bundle. Only this sanitized report is authorized for Drive.

### R4-B handoff and remaining gates

1. Independently verify this complete immutable package/dependency/source set in
   a new isolated Router consumer. Review a new pin/verifier context under the
   separately approved R4-B work; this task changes no active or approved pin.
2. Reuse R4-B's genuine frozen-source verification and classification, then issue
   the exact source/record/definition manifest and independently trusted approval
   anchor. Keep original GUIDs, bcrypt and timestamps. Unsupported records,
   collisions, missing evidence or unsupported transformations must fail or stay
   explicitly quarantined, never be coerced into compatibility.
3. Use source creates plus the real maintenance receipt in every bounded unit.
   Four source writes plus a receipt require expanded-v1; standard supports three.
   Verify full binding/commit import/capacity/durability acknowledgements. Treat
   missing/mismatched/lost acknowledgements as unknown and reconcile receipts and
   original records before retry. Do not reuse historical financial audits as
   migration receipts, use CRUD/raw SQL, strip the marker, or select an old runtime.
4. Independently reconcile every approved original record, type/count/index/link
   and receipt across the complete target. Missing Ledger/pricing/payment/signup/
   refund/recovery evidence remains a financial review gate; preserved source
   facts do not create those proofs or make an account financially qualified.
5. The v1 owner and quarantine belong only to this new import destination. They
   do not impersonate an existing Router owner or grant a release. Coordinate any
   future read/ownership handoff and activation contract explicitly, including
   R4-A's physical schema inspection for the two genuine maintenance tables.
   Complete actual R4-B import/rollback/crash/target reconciliation and migrated
   backup/restore acceptance before considering a later activation request.

There is no remaining blocker for the supported shared synthetic preservation
contract. Product integration, unsupported legacy facts, approved runtime pinning,
financial qualification, release/activation authority, off-host/key/device
certification and broader Pulse/Node-24 issues remain separate unresolved gates.
No real records/accounts/credentials were read, no live provider call or migration
ran, no Ledger history or Router configuration changed, and no deployment,
production restart, publication, activation or R4-C work occurred.

Drive copy: [protected-historical-import-v1.md](https://drive.google.com/file/d/1bZYvJJ7jPVnvh6vwP4bt312AtLT7iDEN/view?usp=drivesdk).
File ID: `1bZYvJJ7jPVnvh6vwP4bt312AtLT7iDEN`.
Destination folder: `1_lV8bcqMOMgSWX4Bu48Eurml3WSPUDoS`; its ownership was
verified against the connected Drive account before uploading this sanitized
Markdown. No source records, password hashes, credentials, financial records,
package archives or database backups were uploaded.
