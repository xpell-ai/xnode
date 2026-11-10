# XNode atomic-unit capacity — expanded-v1

2026-11-04. The approved shared extension is implemented and passes its synthetic
acceptance tests. **Overall acceptance: PARTIAL** because the full Pulse regression
run has two failures also reproduced with the unchanged pre-extension runtime.
No Router integration, package publication, activation, deployment or real-data
migration is included.

## Decision and scope

Source of truth: the complete [R3-C1B decision](https://drive.google.com/file/d/1g44dQ8MYrhMTncLZrR-TCtswkI-i_l3T/view),
also available at `xai-router/docs/atomic-audit-capacity-r3c1b.md`. Reviewed the actual
local-unit implementation and Pulse's `pulse-storage-hardening-v1.md` and
`pulse-messaging-recovery-v1.md`, including the native-driver/runtime limitations.
The implementation matches the approved assumptions: the native provider already
loops over validated writes inside one `BEGIN IMMEDIATE` transaction. Its SQL,
fault hooks and FULL durability implementation require no changes.

The expanded entity limit is **eight**, as approved. A future Router allocation
binding must omit its unused payment-event type to fit the dedicated audited
allocation unit; no required guard may be removed to meet capacity.

## Exact changed-file inventory

Paths are relative to the `xpell.ai` workspace. Changes are relative to the
captured working tree, which already contained unrelated uncommitted work.

| File | This task's change |
|---|---|
| `packages/xnode/src/XEntityManager/EntityLocalUnit.ts` | Fixed profile types, deeply frozen capability/acknowledgement descriptors, strict resolution and binding-limit validation. |
| `packages/xnode/src/XEntityManager/XEntityManager.ts` | Snapshot/freeze trusted binding configuration; store the resolved capacity privately; validate against it; acknowledge explicit profiles. |
| `packages/xnode/src/index.ts` | Public capability constant and capacity types. |
| `packages/xnode/tests/local-unit.test.mjs` | Seventeen added boundary, compatibility, authority, rollback, fencing, immutability and durability cases. |
| `packages/xnode/tests/sqlite-durability.test.mjs` | Nine added real-process crash, unknown-acknowledgement and contention cases. |
| `packages/xnode/docs/atomic-unit-capacity-expanded-v1.md` | This required report and verified Drive copy. |

No additional implementation files changed. In particular,
`SQLiteEntityProvider.ts`, XNode/Gateway bootstrap, package metadata, lockfiles,
installed dependencies and workspace `dist` outputs are unchanged. Snapshot
comparison covered 423 existing XNode files, 61 Router source/test/storage files
and 305 Pulse/Starter source/test/schema files; only the five listed code/test
files differ. Existing dirty files were preserved. No existing work store or
production configuration was opened.

## Public API and compatibility

The root `@xpell/node` entrypoint now exports:

- `EntityLocalUnitCapacityProfile = "standard-v1" | "expanded-v1"`.
- `EntityLocalUnitCapacityLimits`: readonly `_records`, `_writes`, `_entities`, `_bytes`.
- `EntityLocalUnitCapacity`: readonly `_version: 2`, `_profile`, `_limits`.
- `ENTITY_LOCAL_UNIT_CAPABILITIES`, deeply frozen, with `_version: 2` and both
  fixed profiles under `_profiles`.

| Profile | Records including guards | Create/update writes | Bound entity types | Canonical UTF-8 input bytes |
|---|---:|---:|---:|---:|
| `standard-v1` (omitted default) | 8 | 4 | 8 | 65,536 |
| `expanded-v1` (explicit opt-in) | 10 | 5 | 8 | 65,536 |

Trusted native bootstrap may add `_capacity_profile` to
`bindEntityLocalUnit` options after entity registration. Selection is resolved
before capability issuance; invalid profiles throw `E_ENTITY_LOCAL_UNIT_CAPACITY`.
The normalized binding, its copied entity array/entries and resolved capacity
descriptor/limits are frozen. The private registry supplies validation limits;
there is no arbitrary numeric-capacity configuration. The internal validator
accepts only the fixed limits objects, and its one-argument form remains standard.

Explicit requests for either supported profile return `bound._capacity`, and
successful commits return the same descriptor at `response._result._capacity`:

```json
{
  "_version": 2,
  "_profile": "expanded-v1",
  "_limits": { "_records": 10, "_writes": 5, "_entities": 8, "_bytes": 65536 }
}
```

Omitted-profile binding and success-result keys retain their previous shape,
with no `_capacity` field. `_durability` retains exactly
`{ "_journal_mode": "wal", "_synchronous": 2, "_foreign_keys": 1 }`.
No database schema/version or stored record changes are required by this API.

Units remain closed data: `_capacity_profile`, `_capacity` and `_limits` inside
them are invalid. Extra command parameters are unauthorized; transport `_ctx`
is rejected even with a genuine local capability key. Read-only grants remain
read-only. Mutating caller options after binding cannot escalate or downgrade
the resolved profile. No remote operation creates a binding.

**Old-runtime compatibility is fail-closed negotiation, not retroactive repair.**
A probe of the actual pre-extension build confirmed it silently ignores the
unknown binding option and provides no acknowledgement. Consumers must verify
the capability version, complete profile limits and binding acknowledgement
before admission. New tests reject missing, old-version and mismatched
descriptors. Merely accepting an option or reporting package version `2.0.7`
does not establish support.

## Transaction and durability evidence

The provider source is byte-for-byte unchanged. All five writes use its existing
single native transaction, with all expected-record and lease checks inside it.
No audit write, essential guard or effect is split into a separate commit.

Tests demonstrate:

- Omitted and explicit standard limits remain 8/4. Expanded commits ten records,
  five writes and eight types, including an append-only receipt and complete guards.
- Eleven records, six writes, nine bound types and unauthorized ninth-type access
  fail. Exactly 65,536 canonical bytes succeed; 65,537 and oversized multibyte
  UTF-8 input fail. Unknown/prototype-like profiles issue no capability.
- Injected native failures after writes 1–5 and before commit leave zero new
  effects/receipts and preserve all guards. A fifth-write unique violation,
  stale complete guard and concurrent duplicate units also leave no partial unit.
- Owner ID, epoch, version and lease-expiry mismatches fence the complete unit.
  Append-only atomic/ordinary update and ordinary delete fail; Hash-schema writes
  remain unsupported. Existing schema/provider/path/deadline checks remain green.
- Expanded readiness and commits reject degraded WAL, FULL or foreign-key
  readbacks. Actual successful writer/readiness checks verify WAL/FULL/FK and the
  existing 5,000 ms busy timeout; unrelated default connections remain NORMAL.
- Separate processes race the same expanded unit: exactly one five-write commit,
  one immutable receipt, no duplicated effects. Existing busy-timeout and engine
  ownership/lifecycle tests remain green. No application-owner takeover mechanism
  was introduced by this capacity extension.
- Actual SIGKILL at each `after_write_1` through `after_write_5`, `before_commit`
  and `after_commit` is verified by both signal and synchronous checkpoint marker.
  A new process reopens each database: pre-commit deaths expose zero writes;
  post-commit death exposes all five with identical GUIDs/values/timestamps.
  Retry after rollback commits once; retry after committed receipt fails CAS.
  Another reopen verifies exactly one complete result and SQLite integrity.
- A deliberately lost acknowledgement returns an error while all five writes
  remain committed. A new process reconciles complete durable evidence, rejects
  replay and blocks receipt mutation. An error response is never counted as a
  successful recovery.

These are process-crash tests, not proof of machine/power-loss or storage-device
failure behavior. WAL/FULL still depends on SQLite/VFS/filesystem guarantees.

## Runtime, builds and regression results

All execution used temporary synthetic stores and an isolated build/dependency
tree. Runtime: Node **22.23.1**, native ABI **127**, better-sqlite3 **12.11.1**,
SQLite **3.53.2**, TypeScript **5.9.3**. No live provider transport was used.

The initial untouched environment failed: installed better-sqlite3 had no native
binary, and the isolated XNode build could not resolve the existing `node-fetch`
import. For verification only, the temporary dependency tree included the cached
`node-fetch@3.3.2` package and the exact installed driver's previously built Node
22 binary from the Pulse durability work. Final tests used a materialized
temporary native package, with **no NODE_OPTIONS preloader**. The shared install,
manifests and lockfiles were not repaired. This is explicit test-environment
evidence, not a clean-install or release-image certification. Pulse's documented
Node 24 native cleanup failure was not retested or declared resolved.

| Validation | Result |
|---|---|
| Pre-extension local-unit + SQLite durability baseline with temporary dependencies | 16 passed |
| XNode `npm run build` and `npm test` in isolated copy | Passed; generic package/conformance tests passed |
| XNode `node --test tests/*.test.mjs` | **54 passed, 0 failed/skipped/TODO** (28 existing + 26 new) |
| Isolated Starter server and Pulse TypeScript builds | Both passed |
| Focused Pulse/Starter runtime-policy, storage-hardening, recovery and WhatsApp/XNet suites | **26 passed, 0 failed/skipped/TODO** |
| All Pulse test files + Starter runtime-policy, application-scope and Message V4 suites | **272 passed, 2 failed, 1 skipped** |
| Two failing Pulse files with pre-extension XNode source rebuilt in the same isolated environment | Same two failures reproduced; 5 other cases passed |
| Scope/hash comparison and changed-file whitespace check | Passed |

The full Pulse regression gate is not green:

1. `plugins/pulse/test/pulse.integration.test.mjs` fails during top-level scenario
   result parsing. A separate pre-extension probe returned child exit 0 but a
   64,603-character result line with `Unterminated string in JSON at position
   64581`. It reproduces without the capacity change; the output/fixture defect
   was not changed in this shared task.
2. `plugins/pulse/test/web-identity.integration.test.mjs`, "Pulse contributes durable
   web identity through its XVM application", expects an entity list omitting
   the existing `agent_profile` and `owner_user_profile` definitions. This exact
   assertion fails before and after the extension.
3. The existing occupied-port guard test skipped because port 3111 belongs to
   another service. That service was not inspected, restarted or interrupted.

Earlier staging attempts exposed missing fixture copies, duplicate linked module
instances and discarded native-preloader settings in child environments. Those
test-tree issues were corrected without workspace edits; the results above are
from the final coherent isolated dependency tree. One initial new assertion used
the wrong error-envelope field; it was corrected to `_result._code` and rerun.

Local evidence logs: `/private/tmp/xnode-capacity-{build,package-regressions,all-tests-final,pulse-server-build,pulse-build,pulse-regressions-final,pulse-before-comparison,pulse-critical-final}.log`.
Runtime/output probes: `/private/tmp/xnode-capacity-{runtime,pulse-output-probe}.json`.
The temporary compiled `dist` tree SHA256 is
`aae6f3e92ee4feecfda7708cae26502a54e15b961c02025443287c53f2a24e1c`
(hash sorted relative file names, NUL, individual SHA256, newline). This identifies
test output; it is not a published release or an updated Router pin.

## Remaining integration and release dependencies

The requested fixed shared contract is available in source. No additional shared
SQL or transaction API is required for R3-C1B's proposed 10/5/8 shapes. Remaining
gates are explicit:

1. The Pulse owner must resolve the two pre-existing regression failures and rerun
   the occupied-port test in an isolated available-port environment. This task
   deliberately makes no Pulse implementation/test changes.
2. Establish a correctly installed native driver and complete declared dependency
   resolution on the supported release runtime; rerun acceptance on that immutable
   build. The source package still identifies itself as `2.0.7`; that version
   alone cannot distinguish this uncommitted extension from older local builds.
3. Under separate Router integration approval, pin the exact accepted XNode
   artifact/version and refresh Router's approved-runtime fingerprints only after
   verification. Do not silently consume mutable workspace `dist` output.
4. Before Router recovery admission, feature-detect the public capability version
   and full expanded limits, request `_capacity_profile: "expanded-v1"` from trusted
   bootstrap, and compare the complete binding acknowledgement. Missing/old or
   mismatched descriptors must fail closed; never split the transaction or fall
   back to the standard profile.
5. Verify each successful commit's `_capacity` and unchanged WAL/FULL/FK descriptor.
   An absent/mismatched or lost commit acknowledgement means an unknown outcome:
   reconcile immutable receipts after restart rather than replaying blindly.
6. In that separate Router task, test all three actual audited recovery transitions
   with complete running-Action guards, dedicated audit creates, exact payload
   budgets and minimized eight-type bindings. Re-run Router financial, ingress,
   ownership, reconciliation and crash regressions. Capacity availability alone
   does not close R3-C1 or establish production readiness.

**Acceptance:** shared capacity functionality and XNode regressions **PASSED**;
the requested overall acceptance remains **PARTIAL** for the documented full
Pulse/runtime release gates. No Router financial implementation was modified,
and no R3-C2 work was started.
