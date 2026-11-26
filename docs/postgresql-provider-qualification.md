# PostgreSQL provider qualification

This is an opt-in real-database test lane. Missing PostgreSQL configuration fails; it is not silently skipped. Existing offline/SQLite tests remain independently runnable.

## Exact reference environment

- PostgreSQL 17.12, UTF8, C locale; fsync/full_page_writes enabled and synchronous_commit on.
- Direct pg 8.23.1 / @types/pg 8.23.1.
- Reference Node 22.23.1; additional Node 24.22.3 qualification is recorded separately.
- TypeScript 5.9.3, @types/node 22.20.7, isolated @xpell SDK 2.0.8 dependencies and better-sqlite3 12.11.1 / SQLite 3.53.2.
- Official server-source SHA-256 `9cf136a703d8ee2f83465c43be4e9e8e7930c82b0bfba13be7e2537be769ac55`.
- Official `postgres:17.12-bookworm` multi-platform manifest digest `sha256:1eff563f6c868b9b433566e9f3cf6e5c79fbd3b95bf70ec7277d376cdbfc50d7`. Resolving this digest is not a Linux/container test PASS.

Use the fixture-owned package manifest/lock in `tests/fixtures/postgresql/consumer`. Do not install into an existing workspace or rewrite its workspace dependencies/lock. Example from a fresh isolated xnode clone using the exact Node22 reference:

```sh
npm ci --prefix tests/fixtures/postgresql/consumer --no-audit --no-fund
ln -s tests/fixtures/postgresql/consumer/node_modules node_modules
./node_modules/.bin/tsc -p .
```

`node_modules` is a local link, not a source artifact. If Git treats it as an untracked symlink, exclude that link locally; never commit it. The fixture locks concrete dependencies for source qualification; normal package workspace dependency declarations remain intact.

## Clean candidate package

After building, stage the candidate into a new directory outside the source tree:

```sh
python3 tests/fixtures/postgresql/pack-candidate.py /absolute/path/to/new-task-directory
```

This helper packs offline with scripts disabled, skips external symlinks/local private planning notes, resolves only the existing five workspace dependencies to the exact consumer fixture versions in that copy, and verifies every packed dist hash plus npm integrity. The source package declarations remain unchanged. `pack-result.json` and `provenance.json` identify the local archive; nothing is published.

Install that archive as a `file:` dependency in separate disposable consumers with the fixture's dependencies, using each exact Node version so better-sqlite3 has the matching native ABI. Copy the PostgreSQL test files and entity-provider-conformance runner into a harness whose `dist` and `node_modules` links target the installed candidate. Run the commands below from that harness, with `--test-reporter=tap` when recording TAP evidence. Never replace an existing checkout's installed package.

For the full existing build's asset-copy step, use the normal complete workspace assets. This isolated source qualification restored only `dist/assets` from the verified public `@xpell/node@2.0.8` artifact (npm SHA512 integrity `sha512-0N7zNwQtzjuMoasxszmfvX7Tsdujouefb0lxsEohBe13PgSyDEI1gMjv2l6p/6V4a3itfwkaFL5X7rveDuy3bA==`) into the new clone's ignored `public/assets` directory. No installed or business assets were read or changed. The TypeScript-only source build above does not require that copy.

## Explicit disposable server

Use an already verified PostgreSQL17.12 binary directory or build the exact official source under a new test directory. Never use an existing business cluster. Choose an unused loopback port, a new owner-only directory whose name contains `issue-73-`, and a private Unix socket directory. Example setup, with `XP_TEST_PG_BIN` pointing to the verified binary directory:

```sh
XP_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/issue-73-pg.XXXXXX")"
XP_TEST_ROOT="$(cd "$XP_TEST_ROOT" && pwd -P)"
mkdir -m 700 "$XP_TEST_ROOT/socket"
"$XP_TEST_PG_BIN/initdb" -D "$XP_TEST_ROOT/data" --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$XP_TEST_ROOT/server.key" -out "$XP_TEST_ROOT/server.crt" -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'
chmod 600 "$XP_TEST_ROOT/server.key"
"$XP_TEST_PG_BIN/pg_ctl" -D "$XP_TEST_ROOT/data" -l "$XP_TEST_ROOT/server.log" -o "-h 127.0.0.1 -p 55473 -k $XP_TEST_ROOT/socket -c ssl=on -c ssl_cert_file=$XP_TEST_ROOT/server.crt -c ssl_key_file=$XP_TEST_ROOT/server.key" start
export XPELL_PG_TEST_CLUSTER="$XP_TEST_ROOT/data"
export XPELL_PG_TEST_SOCKET="$XP_TEST_ROOT/socket"
export XPELL_PG_TEST_PORT=55473
export XPELL_PG_TEST_CA="$XP_TEST_ROOT/server.crt"
```

These are new synthetic certificate files, not production credentials. Use an OpenSSL build supporting `-addext`. Quoting/paths and the port are explicit local choices, not production configuration. The harness independently checks server data_directory and exact version before any database/role creation or cleanup, creates random `ep73_*` stores/roles and secret references only for each test, and cleans only those owned resources. It never connects using a guessed business URI. It does not stop the server automatically: the caller owns that new cluster's lifecycle.

Run the real PG and offline-provider lanes with external-network blocking:

```sh
node --import ./tests/postgresql-network-guard.mjs --test --test-concurrency=1 tests/postgresql-*.test.mjs tests/entity-provider-conformance.test.mjs
```

The preload rejects external AI/payment hosts and the protected local application ports. It permits only synthetic loopback traffic/explicit PG test sockets. Worker processes receive only synthetic configuration and use the same network guard. No live provider credentials or production data are required.

After tests, stop only the cluster created above:

```sh
"$XP_TEST_PG_BIN/pg_ctl" -D "$XP_TEST_ROOT/data" -m fast stop
```

Retain evidence outside source or remove only the caller-owned temporary directory after confirming the process stopped. Never point cleanup at an existing installation.

## Test coverage and evidence

The suites cover portable/manager envelopes; well-formed Unicode/NUL and JSON/date/null equivalence with real SQLite, plus independent PG exceptional-Unicode invariants; Hash; long keys and injected digest collisions; native constraints/roles; concurrent duplicate writers; whole-operation rollback; missing/wrong/partial schema; migration checksum/interruption/commit-uncertainty; pool queue/acquisition/lock/deadline/late checkout; idle/active loss; TLS; XNode-owned normal/failure shutdown; and child process-kill persistence. A real 100003-row fixture checks exact totals beyond the default page limit; its seeding-only planner preference is not a performance claim.

The original provider conformance function contains many assertions but is one named runner test, not one test per assertion. Report the actual TAP PASS/FAIL/SKIP/cancelled totals, exact source/artifact/lock hashes and commands for each lane. Do not add together overlapping reruns or substitute fixtures for required real persistence evidence. Node22/Node24 and native/container results are separate.

Relevant existing SQLite regressions include binding, local-unit, Hash, SQLite durability, historical import/backup and their durability suites. Existing `tests/lifecycle.test.mjs` also requires the matching XNet fixture at its established sibling `modules/xnet` path; recreate that fixture from a recorded clean source revision in the isolated test workspace, not by editing the user's checkout. Those tests are still SQLite regressions, not a PostgreSQL atomic-unit qualification.

Initial schema upgrades are limited to the reviewed metadata migration described in the [provider contract](./architecture/postgresql-entity-provider-v1.md). General entity migrations, atomic-unit/business/fence/backup/restore qualification, Linux/container execution, HA, OS power-failure and production-readiness claims require their own evidence and authorization.

## Candidate run — 25 November 2026

**Historical candidate before the owner decision below; these results are retained.** The same clean candidate package (SHA-256 `061ad55503394238adfbb1e1f6b8e2d6a3e02bc9d6ff347b7f0a13acef2e0e29`) was installed in separate Node22/Node24 consumers. All 278 packed dist files matched the source build byte-for-byte. Only the five `workspace:*` dependencies were resolved to the fixture's exact SDK versions in a disposable packing stage; source declarations stayed unchanged. Package staging skipped symlinks and the private local planning document. Nothing was published.

| Executed lane | PASS | FAIL | SKIP | Cancelled |
| --- | ---: | ---: | ---: | ---: |
| Packed candidate, real PostgreSQL, Node22.23.1 | 40 | 0 | 0 | 0 |
| Same packed candidate, real PostgreSQL, Node24.22.3 | 38 | 2 | 0 | 0 |
| Existing relevant SQLite suites, final source, Node22.23.1 | 216 | 0 | 0 | 0 |

Separate clean-consumer strict TypeScript public-API checks passed on both Node versions. These cohorts overlap in coverage and are not added together as a unique-test total.

Both Node24 failures are the string-equivalence proof gate: native better-sqlite3 12.11.1 binds a lone UTF-16 surrogate as UTF-8 replacement bytes `EFBFBD` on Node24, versus WTF-8 `EDA080` on Node22. The PostgreSQL codec preserves Node22 behavior. SQLite on Node24 therefore also reports a uniqueness collision between that surrogate and U+FFFD in the shared value fixture. These failures do not prove parity for exceptional strings. The owner decision below defers this narrow cross-backend requirement; it does not turn the historical failures into passes.

## Owner decision and revised acceptance scope — 25 November 2026

The accountable owner explicitly directed that this specific SQLite discrepancy be disregarded for now and documented. The [Unicode compatibility exception](./architecture/postgresql-entity-provider-v1.md#unicode-compatibility-exception) defers only cross-backend parity for string keys containing unpaired UTF-16 surrogates. PostgreSQL keeps the same fixed WTF-8 representation across Node22/24; no runtime-specific normalization or Node22-only guard is introduced. Existing SQLite code/regressions and ordinary Unicode parity remain in scope.

The revised suite retains one explicitly skipped cross-backend exceptional-string assertion, keeps the well-formed Unicode/JSON parity tests, and adds PostgreSQL codec vectors plus real exceptional ID/value equality, uniqueness, ordering and reopened-store reads. Report that skip alongside actual results. No general SQLite compatibility waiver or malformed-Unicode migration policy is implied.

## Independent-review corrections — 26 November 2026

The two review findings were reproduced before source corrections on exact commit `1dc6c8a2e88bd80c59dde5e8be640067efaa08ac`; all 278 original dist hashes were verified against its qualified archive. The initial red cohort had **1 PASS /14 FAIL /0 SKIP**: the healthy real-XNode control passed, while six changed-trigger modes, four UNLOGGED entity/metadata relations, an invalid required index and three failed-registration startup cases violated the expected rejection assertions.

The invalid index is created by the non-superuser maintenance owner through a real failed `CREATE UNIQUE INDEX CONCURRENTLY` after synthetic duplicate values; `pg_get_indexdef` stays identical while validity/readiness flags become false. No system-catalog updates or mocked driver responses are used. Trigger/table changes are also ordinary maintenance-owner DDL.

`tests/postgresql-review.test.mjs` retains these negative cases and covers required apps/entities missing, trusted legacy-artifact PG placement, healthy PG/SQLite startup and unchanged unrelated registration-error behavior. Its child actor `postgresql-startup-worker.mjs` runs actual XNode/ServerXVM disk loading, not a patched load hook. Failure assertions cover rejected startup, `_started=false`, MCP not-ready, no `server:started`, stopped core/listeners and closed owned pools. Exact corrected-run counts and archive/log identities are recorded in `tests/fixtures/postgresql/qualification.json` and the task handoff. The existing Unicode exception remains one explicit deferred assertion per PG lane.
