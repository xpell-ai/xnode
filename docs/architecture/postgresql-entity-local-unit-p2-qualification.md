# EntityLocalUnit P2 qualification

Candidate evidence for owner review, not acceptance/deployment. Exact per-lane counts, source/package/lock/log hashes and iteration history are in `tests/fixtures/postgresql/qualification-p2.json`. P1 receipts remain unchanged historical evidence.

## Reproduce safely

Reuse PostgreSQL17.12 / pg8.23.1 / @types/pg8.23.1, Node22.23.1/24.22.3, SDK2.0.8 fixture locks and matching native SQLite ABI. Follow [P1 setup](../postgresql-provider-qualification.md) in a new owner-only `issue-74-` directory. Use an unused loopback port, short private Unix socket path (Darwin limit), new synthetic certificate/roles/databases and observed data_directory/version verification. Never use or stop an existing installation.

The fixture accepts only explicit Issue73/74-marked paths and the exact observed cluster/version before any creation/deletion. The network preload blocks external endpoints/protected local service ports. Synthetic secrets remain process-local, never printed. The fault proxy forwards only to the explicit disposable PG loopback port.

Install the existing fixture lock under the selected Node version, with a task-owned cache. No source workspace dependency/version rewrite, global installation or publication. Build with existing repository assets.

```sh
npm run build
node --import ./tests/postgresql-network-guard.mjs --test --test-concurrency=1 tests/postgresql-*.test.mjs tests/entity-provider-conformance.test.mjs
node --test --test-concurrency=1 tests/entity-provider-conformance.test.mjs tests/lifecycle.test.mjs tests/local-unit.test.mjs tests/local-unit-durability-contract.test.mjs tests/hash-local-unit.test.mjs tests/sqlite-durability.test.mjs tests/historical-import.test.mjs tests/historical-import-durability.test.mjs tests/historical-backup.test.mjs tests/historical-backup-durability.test.mjs
```

Lifecycle tests require the matching sibling `modules/xnet` fixture. This run copies the accepted P1 source/test fixture read-only, hashes the copied files, and builds against this candidate. Its historical source reference is not a newly authenticated Git checkout. No XNet source change is part of this PR.

Pack with `tests/fixtures/postgresql/pack-candidate.py` into a new external task directory. Only the existing five workspace dependencies resolve in that staging copy; packed dist hashes/npm integrity are verified and nothing is published. Install the archive into separate clean locked Node22/24 consumers with ABI-correct native dependencies. Run the PG lane from a copied harness whose `dist`/`node_modules` links target the installed candidate; compile the public `local-unit-types.ts` fixture. Record source/packed/installed dist equivalence. Do not sum overlapping reruns.

## Mandatory observations

- Native authority/remote denial, exact expected/absent records, capacity/Hash, precommit intent/results/expiry and one SERIALIZABLE client.
- Actual distinct process/backend PIDs; CAS/absence-cycle/unique-create/ordinary-CRUD conflicts, independent progress, real timeout/deadlock, no partial records/indexes/receipts or hidden retry.
- Retained append-only SQL privileges; current/stale/wrong/revoked and >2^53 epochs; shared/exclusive handover barrier and rollback on known revocation; real migration interruption and schema/role/protection drift.
- SIGKILL between all five writes/before COMMIT and after acknowledged commit, with fresh readback.
- Actual COMMIT wire loss before server submission and after server commit but before caller receipt. Both conservatively uncertain; independent readback establishes absent/committed facts without automatic replay.
- Exact legacy SQLite behavior plus explicitly opted-in receipt/bounds/expiry; existing historical import/backup/lifecycle and P1 schema/durability/startup regressions on the candidate.

Initial failures/corrections remain in local TAP evidence and the P2 receipt. Missing DB setup fails instead of skipping. The sole pre-existing named exceptional-Unicode SQLite parity skip remains explicit; no mandatory gap is a PASS.

Test-only trusted frames qualify the internal storage consumer, not production issuance. P3 owns dedicated-session/issuer/native consumer/Router readiness; P4 owns full Router business/backup/release acceptance. Native Darwin evidence does not establish Linux/container execution, HA, OS power-loss or production RPO/RTO.
