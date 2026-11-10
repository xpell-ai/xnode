# OPS-1A — Authoritative Hash create-input preflight

2026-11-08. Contract for the additive `@xpell/node` preflight capability. Verification and immutable-artifact evidence are appended after packaging; this contract is captured in the source/package inputs first to avoid a self-referential artifact checksum.

## Public API

```ts
assertEntityLocalUnitHashCreateInput(
  policy: EntityLocalUnitHashPolicy,
  value: unknown
): void;
```

Supported policy: `create-and-preserve-v1`. Success returns `undefined` and proves only supplied Hash-create input admissibility. It does not prove schema validity, ownership, uniqueness, CAS, capacity, durability or eventual commit success, and issues no capability or reservation.

Unknown policies, including omission from untyped JavaScript callers, throw `E_ENTITY_LOCAL_UNIT_HASH_POLICY`. Invalid supplied values throw `E_ENTITY_LOCAL_UNIT_HASH_INPUT`. Errors contain constant safe codes, not credentials. Validation neither normalizes/coerces nor hashes input, opens SQLite, creates records, logs or retains credential data.

`EntityLocalUnit.ts` owns the single predicate. Both this public API and native `SQLiteEntityProvider` create preparation call it. The predicate is extracted without policy changes: explicit nonempty string, at most 72 UTF-8 bytes, and the existing recognized encoded-hash rejection rules. Native preparation always validates again; a previous preflight is not a commit ticket.

The recognized rules remain anchored modular-crypt-looking prefixes, SHA/SSHA/MD5 wrappers and bare 32–128-character hex strings. This is the existing policy, not a universal encoded-hash detector. Unsupported wrappers/prefixes may be ordinary plaintext under that policy. No whitespace trimming, Unicode normalization, password complexity rule or new rejection class is introduced.

## Separate capability descriptor

```json
{
  "_version": 1,
  "_policies": {
    "create-and-preserve-v1": {"_create": "strict-plaintext-v1"}
  }
}
```

Export: `ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES`. The descriptor, policy map and policy object are deeply frozen. Trusted consumers must require this exact supported shape/version and the callable public validator from an independently verified immutable SDK. A package version string, copied descriptor or successful preflight does not establish storage authority.

The exact existing Hash/capacity/historical-import descriptors and binding/commit acknowledgement shapes are unchanged. This function is not a new EntityManager/Gateway operation and cannot select a trusted Hash binding. Transport authority remains unchanged.

## Compatibility boundaries

The validator applies to an explicitly supplied create value. It rejects `undefined`; it does not decide whether a schema permits omission. Native handling of optional omitted Hash fields, required/default Hash fields, profile-only updates, preserved stored bcrypt and read-only Hash guards is unchanged.

Nonhistorical atomic prehashed creates remain rejected; protected historical import bypasses ordinary create preparation under its existing authority and retains validated original bcrypt bytes. Existing ordinary EntityManager CRUD bcrypt import/verification is unchanged. Native bcrypt cost 10 remains provider-owned.

Standard 8/4/8/65,536 and expanded 10/5/8/65,536 capacities, CAS/lease/owner fencing, append-only and uniqueness enforcement, atomic rollback, WAL/FULL/FK and crash recovery are not modified. The declared Node support range remains `>=22.0.0`; acceptance uses Node 22.23.1.

## Router integration handoff

OPS-1B must verify the new immutable artifact and full dependency context, negotiate this descriptor/function before signup admission, translate constant input failures into sanitized input rejection, and keep credentials/tokens transient. It must retain exact existing Hash/capacity/durability checks and native commit validation. Also retain identity/initial-record/serialized-unit policy checks and reject deterministic invalid input before irreversible admission; preflight alone does not validate a complete business operation.

This shared task does not change Router implementation/pins, accepted RC-2B images, signed stores or the stopped STG-L1 environment. It does not implement operator no-effect disposition, relax readiness, authenticate incomplete signup or resolve OPS-1's separate recovery-policy blocker.

## Acceptance decision

**OPS-1A: PASSED for the shared contract and immutable candidate on Node 22.23.1, Darwin ARM64.** The native policy is unchanged and remains authoritative during commit. No Router pre-admission integration, operator recovery, Linux image qualification or financial activation is included. OPS-1 availability/recovery closure remains blocked until the separately authorized Router integration and approved operator disposition policy exist.

The complete source reports consulted are [OPS-1](https://drive.google.com/file/d/1ZyClAsUccagxRaPaaSOpl7NXU6pxP0I5/view), [original XNode Hash contract](https://drive.google.com/file/d/1Z_v_1R7aqoCx2JazJgvfSs2y8W17xDR1/view), [R3-C3B signup](https://drive.google.com/file/d/1BaMt-IOJB8DuHdcWklRjkoCcQGnJ4A3Q/view) and [STG-L1](https://drive.google.com/file/d/1SS0iFCUovb8tKwRbXJdfxhaFd8CuDK2E/view). The original Hash contract explicitly lacked credential preparation/preflight; this additive capability closes that shared dependency without introducing a hashing API. Source review covered EntityLocalUnit, SQLiteEntityProvider, root exports, native tests and the unchanged RouterSignupCapacity consumer.

## Changed-file inventory

Paths are relative to the workspace root.

| File | Change |
|---|---|
| `packages/xnode/src/XEntityManager/EntityLocalUnit.ts` | Shared supplied-input predicate, public assertion and separate frozen v1 descriptor. |
| `packages/xnode/src/XEntityManager/SQLiteEntityProvider.ts` | Calls the same assertion from the existing explicit Hash-create preparation branch. |
| `packages/xnode/src/index.ts` | Exactly two additive exports; existing type and runtime exports preserved. |
| `packages/xnode/tests/hash-local-unit.test.mjs` | 47-class differential matrix plus four API/security/revalidation/omission tests; original 20 tests retained. |
| `packages/xnode/docs/hash-create-preflight-ops1a.md` | Contract, acceptance evidence and handoff report. |

A new generated immutable candidate bundle contains 45 files beneath `packages/xnode/.cache/hash-create-preflight/5e9ac2948cbb4def2b33b41d9df43d6f6deb2039cc329edb521546b9337b9287/`. Its exact file inventory is appended below; `SHA256SUMS` covers every other bundle file. No existing cache entry is replaced.

The pre-task fingerprint inventory contained 915 existing files across shared source/tests/docs/dist, Router implementation/tests/runtime pins, lockfile and the STG-L1 host manifest. Exactly the four existing implementation/test files above changed; the other **911 fingerprints match**, including shared workspace `dist`, Router implementation/pins and preserved staging manifest. The report is newly added. Pre-task shared implementation matched 258 common source files in the prior approved candidate. No parallel source discrepancy required an architectural change. Git resolves to a broader parent repository here; scoped content fingerprints, rather than a misleading clean-tree or Git-commit claim, establish this snapshot's identity.

## Authoritative-predicate and differential evidence

The extracted condition and constant error are identical to the original provider branch after removing formatting whitespace. Native preparation still snapshots and validates the whole unit, checks schemas and required/default omission, calls this shared assertion for every explicit Hash create, performs provider-owned bcrypt cost-10 preparation, then revalidates transaction guards. Historical import retains its separate protected branch. No public validation result is passed as authority to the provider.

The 47-class matrix executes real native commits in fresh synthetic SQLite stores, rather than mocking the predicate. For each candidate input, the public assertion and native result agree with the preserved expected decision. A separate run executes the **same native cases against the actual prior sealed RC-2A packaged runtime**, where both new exports are confirmed absent. Its archive SHA256 is `7a088877be2c466f747302857f223df58bfd091cca6f5f4baa5ddc5645d0dffc`; release identity is `aeab03e5c4a5f28e4e1b8b03358629f016b67c6cf902719b10b6c9ed8a85f142`. All 8,757 sealed files and eight links were verified before adding test-only fixture paths in a fresh private extraction.

| Input class | Preserved result |
|---|---|
| Ordinary nonempty strings, one character, whitespace and embedded NUL | Admissible within the byte limit; no normalization. |
| OPS-1 48-character bare hex; MD5/SHA1/SHA256-shaped and uppercase hex | Rejected as recognized prehash-looking input. |
| Bare 31-character hex | Admissible plaintext under existing policy. |
| Recognized modular-looking prefixes, including bcrypt, argon2id and unknown alphanumeric format names | Rejected; unsupported algorithms do not acquire import permission. |
| Unterminated/hyphenated modular prefixes, unknown wrappers, leading-space hex | Preserve the existing plaintext classification; this API does not invent a stronger hash detector. |
| SHA/SSHA/SHA256/MD5/SMD5 wrappers | Rejected. |
| Empty, null, number, boolean, object, array, explicit undefined, boxed string, Symbol, BigInt | Rejected; no coercion. |
| ASCII 71/72/73 bytes; two-, three- and four-byte UTF-8 boundaries | 72 bytes admissible unless another original rule rejects it; over 72 rejected. |

Non-JSON JavaScript values can be rejected by native unit-envelope validation before reaching Hash preparation; the comparison for these values is rejection equivalence, not a claim of identical error codes across different validation layers. Ordinary JSON invalid Hash values retain `E_ENTITY_LOCAL_UNIT_HASH_INPUT`. Unknown policy retains the separate policy error. Optional omission is tested separately from explicit `undefined`.

Every matrix preflight is bracketed by SHA256 inventories of SQLite/WAL/SHM files; they remain unchanged. Rejected native attempts leave every proposed row absent. Accepted native creates store cost-10 bcrypt that verifies against the supplied synthetic value. No accepted preflight is advertised as guaranteed transaction success: modifying an already checked input to the OPS-1 hex case is rejected again by native commit, concurrent duplicates admit one commit, and stale full-record CAS fails without partial writes.

## Credential security

The assertion is synchronous and returns only `undefined` or constant-code errors. Tests trap coercion hooks, bcrypt salt/hash calls and console output: none run during preflight. Unknown policies and invalid supplied values do not echo credentials in serialized errors, create records, or change storage files. Descriptor layers reject mutation. Missing, old, malformed, mutable or incompatible input descriptors and absent callables are rejected by the test's trusted-consumer negotiation example; Router production negotiation is deliberately unchanged pending OPS-1B.

Existing native security tests still prove no plaintext or tested fast proposal digest in SQLite/WAL, receipts, logs, errors or events. Default bindings, commands and transport context cannot acquire Hash authority. The assertion does not expose a Gateway method, return a prepared credential or grant trusted storage authority.

## Runtime, builds and immutable artifact

The primary candidate is:

`packages/xnode/.cache/hash-create-preflight/5e9ac2948cbb4def2b33b41d9df43d6f6deb2039cc329edb521546b9337b9287/xpell-node-2.0.7.tgz`

**SHA256: `5e9ac2948cbb4def2b33b41d9df43d6f6deb2039cc329edb521546b9337b9287`.** The version remains 2.0.7 and is not capability evidence. This artifact was not published, installed into the active Router, incorporated into an existing image or used against an existing store.

| Provenance | Identity/evidence |
|---|---|
| Runtime/tooling | Node 22.23.1, ABI 127, npm 10.9.8, pnpm 10.25.0; Darwin ARM64. |
| Native toolchain | Apple clang 21.0.0, macOS SDK 27.2, Python 3.10.0, GNU Make 3.81; exact Node binary/header and dependency file inventories retained. |
| Source inventory | 721 input files; canonical identity `b01208a17b3b2e8f717c9e3930d372c42117ec8a5acb0dc1d3fcd95e2c806d08`. |
| Source archive SHA256 | `28b1080692cc56135ef715c7a187de216136d9585716b75991bbaeb90a0dd16f`. |
| Frozen source lock SHA256 | `24c7fbac90de221761643f8975d41c1710c34a0a5fc1dfa2d2ab6124a031db25`. |
| Frozen consumer lock SHA256 | `865d1552123ebb72a607e8b552bfbad9e4bb4b07fd87f27bfa4001d1487cdfd5`. |
| Source-only consumer capsule | 727 files; SHA256 `7726c3718ddec16aa97689543e40043f1b70baa6c229a9ddeff3b9dd1057923d`. |
| Dependencies loaded in both consumers | better-sqlite3 12.11.1 / SQLite 3.53.2; fs-ext 2.1.1; bcryptjs 3.0.3; node-fetch 3.3.2. |
| SDK package inventory | Nine exact local tarballs; all 882 packed files match each consumer installation. Eight companion tarballs are byte-identical to the prior approved bundle. |
| Complete installed inventories | Producer: 11,178 files/673 links. Each consumer: 7,690 files/eight links, including generated native outputs. SHA256, size/mode and symlink targets recorded. |

The fresh producer copied source-only inputs, with no workspace `dist`, `node_modules`, native addon, live `work`, credentials or active settings. It installed 281 locked packages offline with lifecycle scripts initially disabled and side-effect caching disabled; the SQLite addon was absent before the explicit native source rebuild. All nine SDK source builds passed, plus UI/dashboard source fixtures used by existing package tests. XNode's existing `npm test` build/generic/conformance path passed.

Two independent empty consumer directories then installed the exact nine tarballs using the frozen npm lock, offline package archives and `--build-from-source --foreground-scripts`. Each installed 227 packages and independently compiled SQLite and fs-ext using the exact local Node headers. Neither reused the producer's native binaries or the other consumer's installation. Native files have distinct inodes; fs-ext binaries have different hashes because native outputs may carry build-path differences. This is a reproducible source build and verified runtime, not a claim of bit-identical native output. Both consumers compiled Router, provider, Starter and Pulse TypeScript against the installed candidate.

The complete dependency provenance is in `candidate.json`, both lockfiles/capsules and the full source/packed/installed SHA256 inventories, rather than a package version alone. Every local SDK lock entry resolves to its exact `file:artifacts/` tarball with verified SHA512 integrity. No arbitrary registry `@xpell/node@2.0.7` substitution occurs. The offline archive stores are external build prerequisites; they supply registry source archives, not previously compiled native side effects.

Reproduction uses new private directories, the included source/consumer capsules, exact Node 22.23.1 headers, complete lock-matching offline caches and distinct empty npm user/global configuration files. Representative executed commands (exact paths/order/exit results are retained in `build-commands.json` and captured tools):

```sh
pnpm install --frozen-lockfile --offline --ignore-scripts --side-effects-cache=false --package-import-method=copy --store-dir <verified-pnpm-store>
# In the fresh better-sqlite3 package directory, with npm_config_nodedir
# pointing to Node 22.23.1 and npm_config_build_from_source=true:
npm rebuild --build-from-source
# Source build order: core, node-core, file-service, mcp, vibe, node,
# agent, agent-channels, xnet, then UI/dashboard test fixtures:
npm run build
# In each fresh source-only consumer extraction:
npm ci --offline --build-from-source --foreground-scripts --cache <verified-npm-cache>
# XNode source and installed-consumer package directories:
node --test --test-concurrency=1 tests/*.test.mjs
```

Both packed and installed TypeScript declarations expose the exact public assertion signature and readonly descriptor. All prior **165 runtime exports remain**, with exactly two additions. Existing capacity/Hash/import/backup descriptors, historical runtime identity strings and acknowledgements compare exactly with the prior approved runtime. Source manifests, Node `>=22.0.0`, dependency values and all parsed packed manifests are unchanged; pnpm reordered XNode's packed dependency keys only. No Node support minimum, dependency implementation or default setting was changed.

## Test results and failure accounting

Counts below are per execution lane; repeated executions are not additional distinct tests.

| Lane | Final result |
|---|---|
| Focused new/current Hash test file, source | **71 passed**, zero failures/skips/TODOs: original 20 + 47 matrix + four API tests. Included in the 220 below. |
| Prior sealed native Hash differential | **67 passed**, zero failures; four explicit new-API-only skips because the old runtime lacks those exports. All 47 native input cases and original 20 execute. No skipped new-runtime acceptance. |
| All XNode source test files | **220 passed**, zero failures/skips/TODOs. |
| All XNode tests, installed consumer A | **220 passed**, zero failures/skips/TODOs. |
| All XNode tests, independent installed consumer B | **220 passed**, zero failures/skips/TODOs. |
| Existing XNode `npm test` | Passed source build and generic/conformance execution. |
| Router AtomicSignup + AtomicSignupGate, unchanged consumer | **91 passed**, zero failures/skips/TODOs. |
| Router RuntimeFoundation ownership/durability/native absence/FS/REST/WS | **13 passed**, zero failures/skips/TODOs, after fixture correction described below. |
| Providers, mocked transports | **36 passed**, zero failures/skips/TODOs. |
| Selected Pulse storage-hardening + recovery integration | **15 passed**, zero failures/skips/TODOs. |

The 220-test suites include genuine five-write native rollback at writes 1–5 and before commit; standard/expanded boundary and byte-limit enforcement; CAS, uniqueness, lease/epoch/expiry and owner fencing; degraded WAL/FULL/FK rejection; append-only mutation protection; competing processes; actual plain and Hash SIGKILL windows before/after commit; lost acknowledgement and exactly-once receipt reconciliation. Protected historical import still preserves original GUIDs, bcrypt bytes, timestamps and immutable receipts. Authenticated quarantined backup/restore includes corruption/wrong-key rejection, completeness checks, crash windows and exclusive owner recovery. No failure hook or transaction assertion was removed.

The initial Router ownership run was **12 passed/one failed**: its protective native-driver-absence test required `upstream-artifacts.json`, which was missing from the private consumer capsule. It stopped before hiding a native file. The actual new `candidate.json` provenance was added as that marker to both private fixtures; the unchanged suite then passed all 13. The finalized 727-file consumer capsule includes that truthful marker. Original failure status and log hash remain alongside the final result, not silently rewritten. Package-path aliases/manifests are test-only paths to the same installed SDK, never substituted implementations.

Earlier private legacy-fixture setup attempts hit an existing test directory, a read-only extraction and an incorrect relative alias before execution; a fresh sealed extraction with the correct alias produced the final baseline above. Private inventory scripts also needed the actual local Python/tool paths and semantic JSON comparison for reordered manifest keys. These setup/verification attempts are not passing acceptance runs and caused no product/runtime changes. Raw logs are retained privately and fingerprinted in `log-inventory.json`; no credential-bearing log or database is uploaded.

Known broader failures are carried forward separately and were **not rerun or marked passed**: Pulse's truncated scenario-child JSON in `pulse.integration.test.mjs`, the stale profile-entity expectation in `web-identity.integration.test.mjs`, and Node 24's native `RemoveEnvironmentCleanupHook` assertion. The two existing Router schema TODOs (nested enum enforcement and schema-only safe-integer/cross-field arithmetic), live Google Document AI/vision skips and OPS-1 operator-policy blocker are also not closed by this change. This task does not claim the broad Router financial/browser suite, a new Linux image or historical-store activation was qualified.

## OPS-1B handoff and remaining blockers

1. Review and pin this exact XNode SHA256 with the eight compatible companion artifacts and frozen dependency context in a separately authorized Router candidate. Preserve old pins/images/staging until that acceptance finishes; package version 2.0.7 alone is insufficient.
2. Before signup admission, require the exact new v1 descriptor, all frozen layers and callable assertion, in addition to the existing Hash/capacity/durability/ownership checks. Fail closed on absent/old/malformed support. Call the public assertion with the original transient supplied credential; map constant errors to sanitized input rejection. Do not copy the regex, prehash, normalize or probe writes.
3. Validate the complete deterministic business intent before admission as well. A valid Hash input does not validate identity fields, welcome snapshots, initial schema records or serialized native-unit size. Keep native commit revalidation and independent receipt reconciliation.
4. Add Router-level proof that the OPS-1 hex case and every other deterministic invalid request leave no admission/audit, while valid password/Google/duplicate/concurrent flows and unrelated holds remain unchanged. Independently qualify the new Linux image/native dependencies before any separately authorized staging replacement.
5. Keep unresolved pre-existing admissions fail-closed. Approve and implement the distinct versioned, CAS-fenced, immutable-audit no-financial-effect disposition/startup policy before claiming recovery closure. This shared API neither repairs an admitted record nor supplies missing retrospective credentials or operator authority.

There is no remaining shared-contract blocker for this preflight on the tested Node 22.23.1 runtime. The declared wider Node support range is preserved, not newly certified. No real users/accounts/financial rows, live Google identity/AI/PayPal operations, existing DBs, operator recovery, migration, package publication, production/staging deployment or active configuration changes were used. Only this sanitized Markdown is authorized for Drive synchronization; candidate archives, keys, databases, backups and raw test outputs stay local. Stop after OPS-1A.

## Generated bundle file inventory

All paths below are relative to the new candidate directory. `SHA256SUMS` records the exact SHA256 of each other file.

```text
README.md
SHA256SUMS
a-installed-dependency-inventory.json
approved-source-comparison.json
artifact-file-inventories.json
b-installed-dependency-inventory.json
baseline-public-contract.json
before-after-compatibility.json
build-commands.json
candidate.json
captured-tools/final-verification.py
captured-tools/legacy-differential.py
captured-tools/package-candidate.py
captured-tools/prepare-build.py
captured-tools/prepare-consumers.py
captured-tools/run-consumer-tests.py
consumer-a-public.json
consumer-b-public.json
consumer-inputs.json
consumer-inputs.tgz
consumer-package-lock.json
consumer-package.json
consumer-test-status.json
log-inventory.json
node-headers-inventory.json
producer-installed-dependency-inventory.json
public-compatibility.json
report.md
router-ownership-final-status.json
source-change.patch
source-inputs.json
source-inputs.tgz
source-test-status.json
verification.json
verify-bundle.py
verify-public.mjs
xpell-agent-2.0.7.tgz
xpell-agent-channels-2.0.7.tgz
xpell-core-2.0.7.tgz
xpell-file-service-0.1.0.tgz
xpell-mcp-2.0.7.tgz
xpell-node-2.0.7.tgz
xpell-node-core-2.0.7.tgz
xpell-vibe-2.0.7.tgz
xpell-xnet-0.2.0.tgz
```
