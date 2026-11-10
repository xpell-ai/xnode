# XNode packaging correction and verified expanded runtime

2026-11-05. **Recommend R3-C1C Gate 1 READY for the isolated Node 22.23.1
candidate identified below.** The dependency/build blocker is removed, and the
installed artifact executes both atomic-unit profiles. No newly introduced
HTTP, public-API or financial-runtime regression was found. The complete
multi-runtime/consumer matrix is **PARTIAL**, with the separately disclosed
existing failures and obsolete old-runtime assertion below; it is not all green.
No Router integration, pin update, publication, activation or deployment occurred.

## Sources and correction

Read the complete [blocked R3-C1C report](https://drive.google.com/file/d/1RrW6iIokoD6h-IFdDYMpItu5FEpiro6G/view)
and [expanded-v1 implementation report](https://drive.google.com/file/d/1l2HTTkITaH5j7SJjQ6NJcoP-R2GTQzcu/view),
current package/source/lock contracts and applicable Xpell skills. The existing
expanded implementation was not redesigned or edited.

Declared **`node-fetch: "3.3.2"`** as an exact runtime dependency and added only
its XNode importer edge to the canonical workspace `pnpm-lock.yaml`. That version,
its integrity and dependency snapshot already existed in the lock. XCDN's
`fetch`/`Blob`/`FormData` imports and all HTTP implementation code are unchanged.
This retains existing multipart, redirect and non-2xx JSON semantics; it does not
substitute Node's native HTTP APIs or depend on a transitive/hoisted package.

The ignored package-local npm lock is an old 2.0.4 artifact and was not used or
rewritten. This workspace's canonical lock is the root pnpm lock; the independent
consumer has its own complete npm lock, supplied with the candidate.

## Exact changed-file inventory

Relative to the captured starting working tree:

| File | Change |
|---|---|
| `packages/xnode/package.json` | Add only the exact `node-fetch` runtime dependency. |
| `pnpm-lock.yaml` | Add only three lines in the XNode importer; reuse existing locked resolution. |
| `packages/xnode/scripts/prepare-expanded-runtime.mjs` | New explicit source-only, hashed, disposable build preparation. |
| `packages/xnode/scripts/package-expanded-runtime.mjs` | New verified-input packing and read-only checksum manifest generation. |
| `packages/xnode/tests/xcdn-packaging.test.mjs` | Four actual localhost HTTP/multipart compatibility tests. |
| `packages/xnode/docs/expanded-runtime-packaging.md` | This sanitized report and verified Drive copy. |

Only the first two are modifications to existing files. All other captured
existing files remain unchanged, including every production TypeScript source,
XNode workspace `dist`, Router financial/test/schema/pin/bootstrap files and
Pulse source/tests. Earlier unrelated dirty work is preserved. The generated
18-file candidate bundle is under the already-ignored `.cache` directory; its
complete inventory is `SHA256SUMS`. No existing financial work store was read.

## Clean source build and dependency proof

Build preparation copied **466 explicitly hashed source/build/document inputs**
for nine packages: core, node-core, file-service, MCP, Vibe, Node, Agent,
Agent Channels and XNet. No workspace `dist`, node_modules, work stores or
environment files were copied. Documentation symlinks were omitted and listed;
source symlinks escaping the capture are rejected. Package manifests retain
their original workspace relationships during the source build.

Runtime/tooling: **Node 22.23.1, npm 10.9.8, pnpm 10.25.0**. XNode uses its
locked **TypeScript 5.9.3**; other packages use their own declared locked tools.
Native build tooling observed: Python 3.10.0, Apple Clang 21.0.0, Make 3.81.
Source builds require the usual compiler toolchain and matching Node headers;
the latter may be downloaded by node-gyp on a fresh machine. They do not require
an undocumented previously compiled addon.

A frozen install fetched 197 exact locked packages into a task-local pnpm store.
A second fresh source tree repeated the install offline, reusing package source
tarballs with side-effects caching disabled. Both builds compiled SQLite from
source in their own installation and built the dependency chain in order.
Neither used a borrowed `.node` binary, NODE_OPTIONS/NODE_PATH, or old workspace
build outputs. All XNode JavaScript/declaration/map outputs compared identically
between the two builds. Re-running the existing copy-assets script during the
first tree's package tests also creates an extra nested asset copy; the packed
candidate came from the fresh single-build tree, not that repeated-build output.

An AST-based audit of XNode `src` found **zero undeclared package imports**.
In particular, `node-fetch` resolves through XNode's own declared dependency.
The original missing-dependency `TS2307` is gone.

The source archive in the bundle contains the exact source/lock inputs and
`source-inputs.json` build order. Reproduce with the pinned tools:

```sh
node packages/xnode/scripts/prepare-expanded-runtime.mjs
# Enter the newly reported disposable source tree.
pnpm install --frozen-lockfile --ignore-scripts --side-effects-cache=false
# From the real installed better-sqlite3 package directory:
npm rebuild --build-from-source
# In source-inputs.json order, run npm run build in each package directory.
# From the original checkout, pack that completed source tree:
node packages/xnode/scripts/package-expanded-runtime.mjs /absolute/source-tree
```

The first offline attempt correctly reported absent registry tarballs; fetching
the already locked versions resolved that cache condition. No versions were
silently upgraded. Package installation scripts were initially disabled, then
the known SQLite addon was built explicitly. Package tests/builds use only
disposable synthetic files, databases and localhost listeners.

## Immutable local candidate and provenance

Stable bundle, relative to this package:

`.cache/expanded-runtime/53854f9e96d7ca0964266eb2da55a337b7993167f1d0941dd12f381e70ef7f8b/`

The XNode artifact is `xpell-node-2.0.7.tgz`, SHA256:

`53854f9e96d7ca0964266eb2da55a337b7993167f1d0941dd12f381e70ef7f8b`

Other exact identities:

| Identity | SHA256 |
|---|---|
| Source-input map (466 files) | `7b884bfe766fefac672b6840b613a2df0a9dc256815f7569d7cb6282316b9f56` |
| Canonical root pnpm lock | `24c7fbac90de221761643f8975d41c1710c34a0a5fc1dfa2d2ab6124a031db25` |
| Candidate manifest | `a84fec691059a879a7940e1a4366f2a93af2bcf0491e8386668a9fec0f1e4a53` |
| Tested consumer npm lock | `55c3824164db19694b3b5ebb34e926a399b4f429cfd3af2c72bdd39437e9e944` |

`candidate.json` records all nine package versions/tarball checksums, source
manifest identities, build tooling, full source archive checksum and sorted
public export names. `SHA256SUMS` covers every other bundle file. Files are
read-only (0444) and the bundle directory is 0555; future consumers must still
verify content hashes rather than trusting permissions or version `2.0.7`.
No source package version was bumped, and nothing was published.

The bundle includes `source-inputs.tgz`, `consumer-inputs.tgz`, both dependency
lock contexts, source identities, dependency audit and actual acknowledgement
JSON. The consumer capsule contains sources/test fixtures, packaged artifacts
and schema/view definitions, not installed modules, native binaries or work
records. It allows a new installation/build without the mutable workspace.

## Independent artifact consumption and compatibility

A separate empty npm consumer installed only these local tarballs plus declared,
locked dependencies. Its native SQLite addon was compiled from source during
`npm ci`; it did not use the source build's binary. Actual runtime readback:
better-sqlite3 **12.11.1**, SQLite **3.53.2**, native ABI **127**.
The installed XNode path is inside that consumer; no runtime dependency resolves
back to the original workspace.

The tarball retains all original public entrypoints, exports policy, signatures,
scripts, defaults, file declarations and engine range. The installed namespace
matches the fresh source namespace exactly: **156 exports**. Every production
TypeScript source is unchanged from the starting expanded-capacity implementation.
The sole source-manifest difference is the new direct dependency; packing
normally converts existing `workspace:*` relationships to their exact versions.

The Node engine remains **`>=22.0.0`**. The added dependency's supported Node
range includes Node 16 and above and does not raise that minimum. Build-tool
pinning to 22.23.1 is the requested reproducible build target, not a runtime
engine change. Available Node 22.23.1 and 24.19.0 were tested independently;
other versions were not certified by this task.

Actual native execution, also saved in `acknowledgements.json`:

| Contract | Observed result |
|---|---|
| Omitted standard profile | Eight records/four writes succeeded; no `_capacity` added to binding or result. |
| Expanded profile | Ten records/five writes across eight types succeeded. |
| Explicit expanded binding and commit acknowledgement | Both returned version 2, profile `expanded-v1`, limits 10/5/8/65536. |
| Native durability | Exact WAL / synchronous 2 (FULL) / foreign_keys 1. |
| Limits and safety | Tests reject 11 records, six writes, nine types, 65,537 bytes, untrusted overrides and degraded durability; 65,536 bytes succeeds. |
| Atomicity | CAS/unique rollback, append-only, owner/lease fencing, every write 1–5, pre/post-commit SIGKILL and lost-ack restart reconciliation remain green. |

XCDN tests exercise real loopback HTTP: multipart file fields/bytes/name/MIME,
expiry validation, base64 PNG naming, URL helpers, redirects and the existing
behavior of returning a non-2xx JSON response. No HTTP implementation, billing,
authentication, provider or settlement logic was changed.

## Validation results and preserved failures

| Lane | Result |
|---|---|
| Two frozen-install source builds, all nine packages | Passed; no previous workspace artifacts/native binaries. |
| XNode existing `npm test` | Passed, including generic/conformance tests. |
| All XNode test files in source tree | **58 passed, zero failed/skipped/TODO**. |
| Same XNode tests against independently installed tarballs | **58 passed, zero failed/skipped/TODO**. |
| Existing XNet, core, Agent/Channels, MCP and provider regressions | **207 passed, zero failed/skipped/TODO**. |
| File Service existing package script | Passed. |
| XVibe existing package script with source-built UI/dashboard fixtures | Passed. |
| Router existing server suites, including R1-A schemas | **655 passed, one obsolete-capability assertion failed, two existing live skips, two existing schema TODOs** (660 cases). |
| Router R1 ownership/durability/native absence/REST/WS/default FS, separate consumer | **13 passed, zero failures/skips/TODO**. |
| Router existing UI source checks | **11 passed**, zero failures. |
| Focused Pulse policy/storage/recovery/WhatsApp-XNet | **26 passed**, zero failures/skips/TODO. |
| Broad Pulse plus Starter scope/policy/message suites | **272 passed, two known failures, one existing occupied-port skip**. |
| Node 24.19.0 XNode matrix | 30 reported cases passed; local-unit test process aborted with the known native cleanup assertion. Not a pass. |
| Node 24.19.0 focused Pulse/Owner matrix | 12 passed, two failed (Owner path and storage-hardening process); same native cleanup failure class. Not a pass. |

The two Pulse failures are the previously reproduced incomplete scenario JSON
in `pulse.integration.test.mjs` and the outdated entity list in
`web-identity.integration.test.mjs` (missing existing agent/owner profile types).
They were neither edited nor marked passed. The port-3111 skip did not interrupt
the service using that port.

Router's failing characterization is literally named "old XNode binding success
does not negotiate a proposed expanded capacity profile" and asserts that an
explicit expanded binding has no acknowledgement. It is incompatible with the
approved expanded implementation that already existed before this packaging
change. The unchanged runtime now correctly returns version-2 acknowledgement.
This is not a new dependency/HTTP/financial regression. Leave its fixture update
to the separately authorized R3-C1C integration; no Router test was changed here.
Other Router financial/auth/routing/payment tests and standard-profile safety
tests passed. Blocked audited transitions remain blocked by unchanged Router
logic and are not counted as successful recovery.

The Node 24 abort is `node::RemoveEnvironmentCleanupHook`, assertion
`(env) != nullptr`, also documented before this task by the Pulse recovery work
and referenced in the expanded implementation report. Fresh Node 24 installs
reproduced that existing native-runtime failure class. This task makes no claim
that Node 24 is release-ready, and does not fix it by changing engines, skipping
tests or altering transaction/provider code.

Temporary compatibility harness repairs supplied real artifact package manifests
and mapped legacy hard-coded fixture paths to the same installed artifact.
They did not substitute runtime implementations or change consumer source/tests.
Provider consumer builds used their project's explicitly declared Node typings.
An initial extra standalone Providers build could not find Node typings in that
package's own metadata; it was not used to produce this candidate. Its source
then built in the declared Router consumer context and its regressions passed;
the unrelated standalone development-metadata gap was not silently patched.
Standalone XVibe tests additionally require browser UI/dashboard source fixtures;
those were built from source in the disposable validation tree, not borrowed
from workspace `dist`. They are outside the nine-package candidate dependency set.

Evidence logs use `/private/tmp/xnode-packaging-*`: source/final installation and
native builds, package/artifact tests, consumer regressions, Router/R1/UI,
Pulse focused/broad, and Node24 results. No live provider/PayPal calls, real
financial records, migrations, production configuration changes or service
restarts were used. Skips, TODOs, process aborts and rejected operations are not
successful acceptance cases.

## Handoff and remaining gates

**Node 22.23.1 packaging and R3-C1C Gate 1: READY for isolated integration.**
Verify the recorded tarball/checksum and complete dependency set before use.
The broader matrix remains PARTIAL for the explicit pre-existing/native and
legacy-fixture conditions; this is not a production-readiness recommendation.

In the next separately authorized Router task, consume the verified immutable
artifact/dependency context, update pins only after verification, negotiate
version 2 and full 10/5/8/65536 acknowledgements, retain standard unrelated
bindings, and test the three real audited financial transitions with all guards.
Do not silently resolve a different `2.0.7` package or assume existing approved
dependency artifacts are interchangeable with the tested source-built set.

The two Pulse failures and Node 24 native issue remain with their owners. Wider
Node-version certification, release-image acceptance and actual host/volume
durability are separate work. No artifact was installed into Router's active
runtime, no Router fingerprint/pin was changed, and R3-C2/R3-C3 were not begun.

Drive copy: [expanded-runtime-packaging.md](https://drive.google.com/file/d/1Vfo1cpJybPQ2gAje7NNbzN6uhAySSGL4/view?usp=drivesdk).
File ID: `1Vfo1cpJybPQ2gAje7NNbzN6uhAySSGL4`. Keep this Markdown and the same
Drive file in private folder `1_lV8bcqMOMgSWX4Bu48Eurml3WSPUDoS`.
