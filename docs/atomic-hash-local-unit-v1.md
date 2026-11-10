# Trusted atomic Hash support for EntityManager v1

2026-11-05. This supplemental contract is opt-in trusted bootstrap authority for
`@xpell/node`. It does not implement Router signup or authorize activation.

## Public contract

`ENTITY_LOCAL_UNIT_HASH_CAPABILITIES` is deeply frozen and independent of the
unchanged version-2 `ENTITY_LOCAL_UNIT_CAPABILITIES`:

```json
{"_version":1,"_policies":{"create-and-preserve-v1":{"_create":"provider-bcrypt-10","_update":"preserve-existing-hash","_prehashed_create":"reject"}}}
```

Trusted `bindEntityLocalUnit` options add `_hash_policy: "create-and-preserve-v1"`.
The frozen binding and each successful commit acknowledge:

```json
{"_hash":{"_version":1,"_policy":"create-and-preserve-v1","_create":"provider-bcrypt-10","_update":"preserve-existing-hash","_prehashed_create":"reject"}}
```

Unknown policies fail with `E_ENTITY_LOCAL_UNIT_HASH_POLICY` before issuance.
The resolved, frozen acknowledgement lives in EntityManager's private binding
registry. Omission adds no `_hash` field and keeps rejecting Hash-schema writes.
No unit, command, REST or WebSocket policy selector is accepted. Transport
contexts cannot invoke the private capability, even with its genuine key.

The fixed capacity profiles remain standard-v1: 8 records / 4 writes / 8 types /
65,536 bytes; expanded-v1: 10 / 5 / 8 / 65,536. Explicit capacity acknowledgements
and implicit-standard response shapes retain their existing semantics.
The engine requirement remains Node >=22.0.0; verification uses Node 22.23.1.

## Credential and transaction semantics

Creates require explicit, nonempty strings for required Hash fields. Optional
Hash fields may be omitted; Hash defaults cannot supply credentials. No null,
coercion, encoded-hash import, or value beyond bcrypt's 72 UTF-8 byte limit is
accepted. Recognized encoded modular-crypt prefixes (including bcrypt/Argon2),
SHA/SSHA/MD5 wrappers and bare 32–128 character hex digests are rejected as
prehashed-looking input. XNode's existing provider performs bcrypt with cost 10;
ordinary CRUD's existing bcrypt import/verification behavior is unchanged.

Profile updates must omit every Hash field. Explicit writes, including null,
replacement and equal-value writes, fail with `E_ENTITY_LOCAL_UNIT_HASH_MUTATION`.
Stored Hash bytes are preserved. Credential rotation is outside this contract.
Hash-bearing read-only full-record guards remain supported with or without opt-in.

The provider snapshots and bounds input, prepares bcrypt asynchronously, and
bounds the prepared unit before opening the SQLite writer. Only declared create
Hash fields may differ between input and preparation; all other exact-intent
checks continue rejecting coercion/truncation. The native immediate transaction
revalidates EntityManager's pinned registrations, provider/schema/physical
identity, expiry, complete expected records, owner/lease fencing, uniqueness and
constraints. It checks result bytes before commit. Any failure rolls back all
writes; post-commit lost acknowledgement requires reconciliation.

The writer still verifies WAL, synchronous=2 (FULL), foreign_keys=1 and the
5-second busy timeout. Append-only triggers remain enforced. No public SQL,
transaction handle, new override, credential-preparation API or background loop
is introduced.

## Secret handling and R3-C3 integration

The extension never fingerprints raw units for audit/receipts. Its hashes cover
schema identity only; bcrypt is the sole credential transformation. Preparation
errors are generic codes without credential values. Opt-in mutation notifications
omit all Hash fields; trusted commit/read results retain stored hashes because
full guards need exact stored records. Public authentication replies must still
be sanitized by the consumer.

Trusted consumers must construct only safe receipt/audit fields. Never include
raw signup input, an ID token, credentials, or a fast digest of a plaintext
proposal in an operation/financial receipt. In particular, do not apply generic
`hash(records)` to a plaintext User-create unit. XNode does not interpret arbitrary
business String/Object fields as tokens or inspect an application's audit design.

Before future financial execution, verify the exact supplemental descriptor,
exact binding `_hash`, exact version-2 capacity profile/limits and native
durability. Verify successful commit `_hash` and capacity acknowledgements again.
Missing/mismatched descriptors or binding acknowledgement must prevent dispatch.
A missing/mismatched/lost commit acknowledgement means unknown outcome: withhold
completion, reopen under valid ownership and reconcile immutable receipts and
stored identities before any retry. Never fall back to ordinary CRUD/prehashing
or split an atomic unit.

The future separately approved Router task still owns verified identities,
normalized-email/provider-subject uniqueness, canonical GUID reuse, original
eligibility/amount snapshots, and atomic Account/User/welcome Ledger/operation/
audit composition. This extension alone closes none of those application gates.

## Verification record

Build, artifact provenance, regression results, failure classifications and Drive
verification are recorded after immutable packaging below. The packaged contract
is captured before this final verification record to avoid a self-referential
artifact checksum.

### Decision and exact scope

**Shared Hash extension on Node 22.23.1: PASSED. Overall requested matrix: PARTIAL.**
The remaining failures are the four now-obsolete Router opt-in characterizations,
two previously documented Pulse failures, and the separately reproduced Node 24
native cleanup failure. Skips/TODOs/aborts are not counted as successful acceptance.
This is an isolated integration candidate, not production readiness or R3-C3
Router completion.

Sources read completely:
[R3-C3 investigation/proposal](https://drive.google.com/file/d/1H0DgyG0DMF6BKdMpf4HWXepZ2a1Dj93q/view)
and [verified runtime report](https://drive.google.com/file/d/1Vfo1cpJybPQ2gAje7NNbzN6uhAySSGL4/view).
Current source, applicable AGENTS.md and Xpell foundation/core/node/XDB/XVM/Flow/
XVibe contracts were consulted. The connected Google Drive skill was used for
source retrieval and this report's synchronization.

Exactly seven authored files differ from this task's starting tree:

| File, relative to packages/xnode | Change |
|---|---|
| `src/XEntityManager/EntityLocalUnit.ts` | Supplemental frozen Hash capability, acknowledgement, trusted policy type/resolution and additive binding fields. |
| `src/XEntityManager/XEntityManager.ts` | Resolve/pin trusted policy, acknowledge binding/commit, revalidate registrations inside transaction, remove Hash fields from opt-in notifications. |
| `src/XEntityManager/SQLiteEntityProvider.ts` | Strict create preparation, preserve-only updates, prepared/result limits and transaction revalidation. Ordinary CRUD unchanged. |
| `src/index.ts` | Add descriptor and type exports; retain all previous exports. |
| `tests/hash-local-unit.test.mjs` | Twenty focused synthetic security, negotiation, concurrency and preparation-race tests. |
| `tests/sqlite-durability.test.mjs` | Extend the existing real-process crash actor to exercise Hash credentials. |
| `docs/atomic-hash-local-unit-v1.md` | Contract, sanitized evidence, remaining gates and handoff. |

Five existing files were modified and two files added. The generated ignored
bundle under `.cache/atomic-hash/` is listed separately by its `SHA256SUMS`.
A content snapshot verifies every other pre-existing source/test/script/doc file
and the entire workspace `dist` remain unchanged. Package metadata, root lock,
Router/Pulse implementation/tests, active runtime pins and business logic were
not edited. No changes were made in the MCP workspace.

### Clean build and immutable candidate

Two disposable source trees were prepared without workspace `dist`, node_modules,
work stores or environment files. The final tree captured 469 explicitly hashed
inputs across nine packages, installed 197 locked dependencies offline with
installation scripts/side-effects caching disabled, compiled its own SQLite
addon from source, and built the dependency chain in order. Cached dependency
source tarballs were reused; no installed native binary was borrowed.

Tools: Node **22.23.1**, npm **10.9.8**, pnpm **10.25.0**. XNode's locked compiler
is TypeScript **5.9.3**. The root pnpm lock is unchanged. The old ignored package
npm lock is not the dependency authority and was not rewritten.

Immutable bundle, relative to this package:

`.cache/atomic-hash/fbf06ba3705973a58bbbd2afb709026f5ae090109244189e6b4085aabcc4efe2/`

XNode artifact: **`xpell-node-2.0.7.tgz`**. SHA256:

`fbf06ba3705973a58bbbd2afb709026f5ae090109244189e6b4085aabcc4efe2`

| Provenance item | SHA256 |
|---|---|
| Source input map identity | `6c104e61a1ec06383265230f83c8834da7236a5842054b12b6071928e279b18a` |
| Canonical root pnpm lock | `24c7fbac90de221761643f8975d41c1710c34a0a5fc1dfa2d2ab6124a031db25` |
| Nine-package candidate manifest | `6a4477129fd74b394125c50433a34892b7bae12efc3c4f66fd4e57450a2bd683` |
| Clean consumer npm lock | `1c8bd855388325215fb8a274be3088e402f1d7b1ba68886bc9337fa86b59b7e7` |
| Verification manifest | `58d1b5d275117938e28c433b7e0440864396455ef39981f1148ceea938ef2938` |
| Source-only consumer capsule | `0181e1d7a220ebcdc2c503fbcb1d20ea14be47842a3eb86c3706acef53a03032` |

| Package | Version | Tarball SHA256 |
|---|---|---|
| @xpell/node | 2.0.7 | `fbf06ba3705973a58bbbd2afb709026f5ae090109244189e6b4085aabcc4efe2` |
| @xpell/core | 2.0.7 | `6742f5bd7dc5a34826d96618b96d72029b36d917f80ed9d896b01b5553662495` |
| @xpell/node-core | 2.0.7 | `a82df87353bd7e295518e048047e6513e87eb33fdca68c8be7674063a53efd2a` |
| @xpell/file-service | 0.1.0 | `8f42d9629893ed165deb40c0756209df7431431796a14ad9a47063145d554e4b` |
| @xpell/mcp | 2.0.7 | `dba7b3558723fce8ec1800e07d6561eea473ed29681f53babbe294a7b0d20bf6` |
| @xpell/vibe | 2.0.7 | `58eca44486e12c49bcddf912079829b0ad1a0f04edcb7e9f5c0588129e8fec6c` |
| @xpell/agent | 2.0.7 | `e20b961c129c84e5b0d44f59386367a4a38c6de6a7027fac9d9f03bead4df74a` |
| @xpell/agent-channels | 2.0.7 | `66be64a002bfcf80fc84e971f9a4223e6d3c36263a4b8c7c32d61d790307add9` |
| @xpell/xnet | 0.2.0 | `aee898dbed5bb5f2cef358f934f53603ac392d714a994c34a2523ae99200bd9c` |

The bundle contains source archives/manifests, all tarballs, the consumer package
and full integrity-bearing npm lock, acknowledgement JSON, a runtime verification
script, test-summary manifest and hashes of local evidence logs. Files are 0444
and the bundle directory 0555. Verify checksums rather than trusting permissions
or the unchanged package version. Nothing was published.

A separate empty consumer ran offline `npm ci` with native source builds: 227
packages installed. A second fresh consumer repeated this for Router's native
absence/ownership tests. Runtime identities resolve inside those installations,
not to workspace packages. Installed readback: better-sqlite3 **12.11.1**, SQLite
**3.53.2**, bcryptjs **3.0.3**, node-fetch **3.3.2**, native ABI **127**.
All 156 prior runtime exports remain; the supplemental descriptor makes 157.
`acknowledgements.json` records actual standard and expanded Hash binding/commit
acknowledgements and WAL/FULL/FK, without credentials or raw entity records.

All captured production/build/test inputs remained byte-identical after packing.
The final evidence appendix and Drive URL were added to the workspace document
only after packaging; the artifact contains the contract before this appendix.
Additional UI/dashboard fixtures for XVibe were source-built separately and
identified by `vibe-fixture-source-inputs.json`; they are not runtime substitutions.

Rebuild using the existing `scripts/prepare-expanded-runtime.mjs`, the frozen
pnpm lock and recorded build order; explicitly compile the native addon, build
all nine packages, then use `scripts/package-expanded-runtime.mjs`. For a new
consumer, unpack `consumer-inputs.tgz`, copy the nine tarballs into `artifacts/`,
verify identities, and use its npm lock with Node 22.23.1 and source native builds.
The runtime verifier accepts consumer root, output JSON and a prior candidate
manifest as arguments. Synthetic fixture aliases must resolve to that consumer's
installed packages, never to a workspace build.

### Security and atomic evidence

Twenty focused tests pass. They verify default rejection; exact descriptor and
binding/commit acknowledgements; unknown/forged policy rejection before issuance;
real bcrypt cost/comparison; multi-Hash preservation; explicit replacement/null/
equal-value rejection; prehashed/invalid/oversized/default input rejection;
read guards; unchanged ordinary bcrypt import; strict non-Hash equality; standard
and expanded limits; raw/prepared/result budgets; concurrent uniqueness/full CAS;
and registration/schema/expiry/lease changes while real bcrypt preparation waits.
The native writer revalidates those changes before admitting any write.

Every synthetic five-write unit includes Account-like, Hash User, Ledger-like,
operation and immutable audit effects. Injected failures after writes 1–5 and
before commit leave zero new rows. A fifth-write uniqueness failure rolls back
the earlier Hash and financial rows. Failed CAS/concurrent units leave no partial
effects. Existing append-only, ownership, lease and capacity tests still pass.

The real-process durability suite passes all **22** cases. Hash variants kill the
process after writes 1–5, immediately before commit and immediately after commit.
A fresh process checks integrity, exact row counts, bcrypt verification/cost,
immutable receipt and no duplicate replay. Pre-commit kills retain zero effects;
authorized retry commits all five. Post-commit kills and lost acknowledgements
retain exactly five effects and the stored hash across successive restarts.
No failure/unknown response is relabeled as successful financial completion.

Leakage tests scan temporary SQLite databases, WAL/SHM files, successful/error
responses, captured logs/events and operation/Ledger/audit records. They reject
occurrences of the generated plaintext and MD5/SHA1/SHA256 of both the credential
and complete raw unit. A bcrypt exception deliberately containing the synthetic
credential is converted to a generic error. Mutation notifications omit Hash
fields. No generic raw proposal/receipt hashing exists in this shared path.
These checks do not certify a future Router audit serializer: that separate
integration must eliminate its own raw-input/fast-digest persistence.

### Regression results and honest limits

| Lane | Final result |
|---|---|
| Clean nine-package dependency/source build | Passed. |
| XNode existing package script | Build passed; runtime script passed with local test listeners enabled. |
| All XNode test files from fresh source build | **86 passed, 0 failed/skipped/TODO**. |
| Same tests through independently installed tarballs | **86 passed, 0 failed/skipped/TODO**. |
| Core, Agent/Channels, XNet and provider consumer suites | **207 passed**, no failures/skips/TODO. |
| MCP existing compiled package tests | **33 passed**, no failures/skips/TODO. |
| File Service existing package script | Passed. |
| XVibe existing package script | Passed with freshly built UI/dashboard source fixtures. |
| Router runtime/ownership/native absence/default FS/REST/WS, alone in a second clean consumer | **13 passed**, no failures/skips/TODO. |
| Current Router server suites, excluding that separate runtime lane | **876 passed, 4 failed, 2 existing live skips, 9 TODOs** (891 cases). |
| Pulse plus relevant Starter suites | **283 passed, 2 known failures, 1 existing occupied-port skip** (286 cases). |
| Node 24.19.0 in a separate source-native installation | **19 reported cases passed; 3 test processes aborted**. Failed lane. |

The four Router failures are `omitted_password_create`, `profile_only_update`,
`password_update` and `prehashed_looking_input` in `AtomicSignupGate.test.mjs`.
Each first asserts that a trusted binding explicitly requesting the proposed
policy has `_hash === undefined`. That assertion now contradicts the requested
contract and fails before its subsequent operation assertion. They are actual
reported compatibility failures, not passes. Default bindings still reject all
Hash writes; password mutation and prehashed create are independently rejected
by the new tests. Router code/tests/pins remain unchanged for their owner to
update under separate integration approval. The seven blocked lifecycle TODOs
and two schema limitations remain TODOs, not completed signup gates.

Pulse's first known failure is a truncated scenario JSON result: the child exits
0 but its 64,603-character result line fails JSON parsing at position 64,581.
A bounded probe reproduced that exact prior report's condition without storing
or uploading its raw result. The second is the existing web-identity entity-list
assertion omitting `agent_profile` and `owner_user_profile`. The occupied-port
case skips because another service uses port 3111; that service was untouched.

The Node 24 lane reproduces `node::RemoveEnvironmentCleanupHook`, assertion
`(env) != nullptr`, from better-sqlite3 statement cleanup. The new Hash test
process and existing local-unit/durability processes abort. Native dependencies
were explicitly rebuilt for Node 24, not reused from ABI 127. This is the failure
class documented before this task, now reproduced with this candidate; Node 24
acceptance is not claimed and the minimum Node range is unchanged.

Initial restricted-environment runs denied local test listeners with EPERM;
those suites were rerun with loopback enabled. Temporary fixture setup initially
omitted Pulse's hard-coded Starter package aliases and Router's dedicated native
absence stage; coherent reruns supplied those paths using the same installed
candidate. An early test invocation targeted old workspace output and failed
import; acceptance uses only fresh source/installed artifacts. One byte-budget
fixture was corrected to reach the result-size boundary. These setup failures
are not included as passing cases. Local evidence and complete log hashes remain
under `/private/tmp/xnode-hash-evidence` and in the immutable verification bundle.

For the required engineering categories: unit/security, command/provider pipeline,
persistence, retry/restart and five-effect composition all passed in the shared
Node 22 lane; clean builds passed. No live authentication-provider or financial
business workflow was executed. Router signup, identity uniqueness/migration,
release-image/volume durability and production activation remain separate work.

### Remaining gates and R3-C3 handoff

1. Consume this exact checksum-verified artifact and complete dependency context
   in an isolated Router candidate. Do not replace active pins as part of this task.
2. Update only the obsolete opt-in capability characterizations in the separately
   approved Router work. Require exact Hash/capacity binding acknowledgements
   before dispatch, and exact commit acknowledgements before declaring completion.
3. Implement and test Router's own safe deterministic identity/operation/amount
   lifecycle and credential-free receipts. Preserve existing GUIDs, original
   amounts, audit history and financial restrictions. Never hash a raw signup
   proposal into a receipt, use Router-side prehashing or silently retry an
   unknown outcome.
4. Execute all seven currently blocked Router signup/welcome acceptance gates
   against its actual five-write composition and full guards. Capacity overflow,
   missing keys/conflicts, legacy incomplete records and acknowledgement mismatch
   must withhold financial authority rather than split writes or invent repairs.
5. Pulse's two known failures and the Node 24 native failure remain with their
   owners. Skips/TODOs and wider runtime/release certification remain unresolved.

No real accounts, financial records or credentials were read; no live provider
calls, real-data migration, Ledger history modification, SQLite activation,
production deployment or service restart occurred. Stop at the shared extension.

Drive copy: [atomic-hash-local-unit-v1.md](https://drive.google.com/file/d/1Z_v_1R7aqoCx2JazJgvfSs2y8W17xDR1/view?usp=drivesdk).
File ID: `1Z_v_1R7aqoCx2JazJgvfSs2y8W17xDR1`.
Destination: private `codex_investigations` folder
`1_lV8bcqMOMgSWX4Bu48Eurml3WSPUDoS`, whose owner was verified against the connected
Drive account. The initial automatic upload review required authorization/owner
evidence; the explicit task instruction, folder ownership and sanitized-payload
checks established that evidence, and the same upload then completed.
