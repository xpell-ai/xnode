import assert from "node:assert";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import XDB from "../XDB/XDB.js";
import XDBCache from "../XDB/XDBCache.js";
import XDBStorageFS from "../XDB/XDBStorageFS.js";
import XDBStorageSqlite from "../XDB/XDBStorageSqlite.js";
import type {
    EntityPhysicalIdentity,
    EntityProvider,
    EntityProviderRuntimeContext,
    EntityProviderType
} from "./EntityProvider.js";
import { createEntityProvider } from "./EntityProviderRegistry.js";
import { resolve_entity_scope_identity } from "./EntityScope.js";
import { MongoEntityProvider } from "./MongoEntityProvider.js";
import { SQLiteEntityProvider } from "./SQLiteEntityProvider.js";
import { XDBEntityProvider } from "./XDBEntityProvider.js";
import { XEntityManager } from "./XEntityManager.js";

type ConformanceProviderType = Exclude<EntityProviderType, "mongo">;

type EntityProviderConformanceCase = {
    _provider: ConformanceProviderType;
    _durable: boolean;
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
    _runtime_context: EntityProviderRuntimeContext;
    _create: () => EntityProvider;
};

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function definitionFor(provider: EntityProviderType, entityId: string) {
    return {
        _id:
            entityId,
        _storage: {
            _provider:
                provider,
            _scope:
                "app"
        },
        _schema: {
            name: {
                _type: "String",
                _required: true,
                _index: {
                    _unique: true
                }
            },
            category: {
                _type: "String",
                _required: true,
                _index: true
            },
            score: {
                _type: "Number",
                _required: true,
                _index: true
            },
            active: {
                _type: "Boolean",
                _required: true,
                _index: true
            }
        }
    };
}

function physicalIdentity(
    provider: EntityProviderType,
    entityId: string
) {
    return resolve_entity_scope_identity({
        _app_id:
            "entity-provider-conformance",
        _env:
            "test",
        _entity_id:
            entityId,
        _provider:
            provider,
        _storage_scope:
            "app"
    });
}

function records(provider: EntityProvider, result: any) {
    const out =
        provider.getRecords(result);

    assert.ok(Array.isArray(out));
    assert.equal(result?._meta?._records, out.length);

    return out;
}

async function assertRejects(action: () => Promise<any>) {
    await assert.rejects(action);
}

/**
 * Reusable portable V1 behavior suite. Provider-specific extensions are not
 * asserted here; this is the common EntityProvider boundary only.
 */
export async function runEntityProviderConformanceSuite(
    testCase: EntityProviderConformanceCase
) {
    const provider =
        testCase._create();

    await provider.init();

    const generated =
        await provider.add({
            name: "Alice",
            category: "alpha",
            score: 10,
            active: true
        });

    assert.match(generated._id, UUID_PATTERN);
    assert.ok(Number.isFinite(new Date(generated._created_at).getTime()));
    assert.ok(Number.isFinite(new Date(generated._updated_at).getTime()));

    const explicitId =
        "legacy-explicit-id";
    const explicit =
        await provider.add({
            _id: explicitId,
            name: "Bob",
            category: "beta",
            score: 20,
            active: false
        });

    // Current contract preserves caller-supplied ids; it does not newly reject
    // legacy non-GUID ids. Generated ids remain GUIDs.
    assert.equal(explicit._id, explicitId);

    const carol =
        await provider.add({
            name: "Carol",
            category: "alpha",
            score: 30,
            active: true
        });
    const dana =
        await provider.add({
            name: "Dana",
            category: "alpha",
            score: 40,
            active: false
        });

    assert.deepEqual(
        await provider.get(generated._id),
        generated
    );
    assert.equal(await provider.get("missing-id"), null);

    assert.deepEqual(
        records(provider, await provider.find({ category: "beta" }))
            .map((record) => record.name),
        ["Bob"]
    );
    assert.deepEqual(
        records(provider, await provider.find({ score: { _gt: 20 } }))
            .map((record) => record.name)
            .sort(),
        ["Carol", "Dana"]
    );
    assert.deepEqual(
        records(provider, await provider.find({ score: { _gte: 30 } }))
            .map((record) => record.name)
            .sort(),
        ["Carol", "Dana"]
    );
    assert.deepEqual(
        records(provider, await provider.find({ score: { _lt: 20 } }))
            .map((record) => record.name),
        ["Alice"]
    );
    assert.deepEqual(
        records(provider, await provider.find({ score: { _lte: 20 } }))
            .map((record) => record.name)
            .sort(),
        ["Alice", "Bob"]
    );
    assert.deepEqual(
        records(provider, await provider.find({ name: { _in: ["Alice", "Dana"] } }))
            .map((record) => record.name)
            .sort(),
        ["Alice", "Dana"]
    );

    assert.deepEqual(
        records(provider, await provider.find({}, {
            _sort: {
                _sort_by: "score",
                _sort_order: "desc"
            }
        })).map((record) => record.score),
        [40, 30, 20, 10]
    );
    assert.deepEqual(
        records(provider, await provider.find({}, {
            _sort: {
                _sort_by: "score",
                _sort_order: "asc"
            },
            _limit: 2
        })).map((record) => record.score),
        [10, 20]
    );
    assert.deepEqual(
        records(provider, await provider.find({}, {
            _sort: {
                _sort_by: "score",
                _sort_order: "asc"
            },
            _skip: 2,
            _limit: 2
        })).map((record) => record.score),
        [30, 40]
    );
    assert.deepEqual(
        records(provider, await provider.find({ category: "alpha" }, {
            _sort: {
                _sort_by: "score",
                _sort_order: "asc"
            },
            _skip: 1,
            _limit: 1
        })).map((record) => record.name),
        ["Carol"]
    );

    assert.equal(await provider.count({}), 4);
    assert.equal(await provider.count({ category: "alpha" }), 3);
    const limited =
        await provider.find({}, { _limit: 1 });
    assert.equal(records(provider, limited).length, 1);
    assert.equal(limited._meta._total_records, 4);
    assert.equal(await provider.count({}), 4);

    await assertRejects(() =>
        provider.add({
            name: "Alice",
            category: "duplicate",
            score: 50,
            active: true
        })
    );
    await assertRejects(() =>
        provider.update(
            { _id: carol._id },
            { name: "Alice" }
        )
    );
    assert.equal((await provider.get(carol._id)).name, "Carol");

    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const updateResult =
        await provider.update(
            { _id: explicitId },
            { score: 25 }
        );
    assert.equal(typeof updateResult?._updated, "number");
    assert.ok(updateResult._updated > 0);
    const updated =
        await provider.get(explicitId);
    assert.equal(updated.score, 25);
    assert.ok(
        new Date(updated._updated_at).getTime() >=
        new Date(updated._created_at).getTime()
    );

    const missingUpdate =
        await provider.update(
            { _id: "missing-id" },
            { score: 99 }
        );
    assert.equal(missingUpdate._updated, 0);
    const missingUniqueUpdate =
        await provider.update(
            { _id: "missing-id" },
            { name: "Alice" }
        );
    assert.equal(missingUniqueUpdate._updated, 0);

    const deleteResult =
        await provider.delete({ _id: dana._id });
    assert.equal(deleteResult._deleted, 1);
    assert.equal(await provider.get(dana._id), null);
    const missingDelete =
        await provider.delete({ _id: "missing-id" });
    assert.equal(missingDelete._deleted, 0);

    await assertRejects(() =>
        provider.find({
            score: {
                _portable_unsupported_operator: 20
            }
        })
    );

    assert.equal(provider.getCapability("exact-count")._supported, true);
    assert.equal(provider.getCapability("server-side-pagination")._supported, true);
    assert.equal(provider.getCapability("unique-scalar-indexes")._supported, true);
    assert.equal(
        provider.getCapability("persistent-storage")._supported,
        testCase._durable
    );

    await provider.dispose();

    const recreated =
        testCase._create();
    await recreated.init();

    assert.equal(
        await recreated.count({}),
        testCase._durable
            ? 3
            : 0
    );

    await recreated.dispose();
}

async function runEntityManagerEnvelopeSuite(
    provider: ConformanceProviderType,
    runtimeContext: EntityProviderRuntimeContext
) {
    const manager =
        new XEntityManager({
            _provider_runtime_context:
                runtimeContext
        });
    const entityId =
        `manager_contract_${provider}`;
    const definition =
        definitionFor(provider, entityId);

    if (provider === "xdb") {
        // Missing _storage remains xdb + app for compatibility.
        delete (definition as any)._storage;
    }

    const params = {
        _app_id: "manager-contract-app",
        _env: "test",
        _entity: entityId
    };
    const registered =
        await (manager as any)._register({
            _params: {
                ...params,
                _entity:
                    definition
            }
        });
    assert.equal(registered._ok, true, JSON.stringify(registered));

    const diagnostic =
        await (manager as any)._storage_diagnostics({
            _params:
                params
        });
    assert.equal(diagnostic._ok, true);
    assert.equal(diagnostic._result._diagnostic._provider, provider);
    assert.equal(diagnostic._result._diagnostic._storage_scope, "app");

    const added =
        await (manager as any)._add({
            _params: {
                ...params,
                _data: {
                    name: "Envelope",
                    category: "contract",
                    score: 1,
                    active: true
                }
            }
        });
    assert.equal(added._ok, true);
    assert.ok(added._result._record._id);

    const id =
        added._result._record._id;
    const got =
        await (manager as any)._get({
            _params: {
                ...params,
                _id:
                    id
            }
        });
    assert.equal(got._ok, true);
    assert.equal(got._result._record._id, id);

    const found =
        await (manager as any)._find({
            _params: {
                ...params,
                _filter: {
                    _id:
                        id
                }
            }
        });
    assert.equal(found._ok, true);
    assert.ok(Array.isArray(found._result._records._data));

    const updated =
        await (manager as any)._update({
            _params: {
                ...params,
                _filter: {
                    _id:
                        id
                },
                _updates: {
                    score: 2
                }
            }
        });
    assert.equal(updated._ok, true);
    assert.equal(typeof updated._result._updated, "number");

    const deleted =
        await (manager as any)._delete({
            _params: {
                ...params,
                _filter: {
                    _id:
                        id
                }
            }
        });
    assert.equal(deleted._ok, true);
    assert.equal(deleted._result._deleted, 1);

    const missing =
        await (manager as any)._get({
            _params: {
                ...params,
                _id:
                    id
            }
        });
    assert.equal(missing._ok, true);
    assert.equal(missing._result._record, null);

    const unregistered =
        await (manager as any)._unregister({
            _params:
                params
        });
    assert.equal(unregistered._ok, true);
}

async function runExactCountCapRegression() {
    const provider =
        Object.create(XDBEntityProvider.prototype) as XDBEntityProvider;
    (provider as any).find = async (_query: any, options: any) => {
        assert.equal(options._limit, 0);
        return {
            _meta: {
                _total_records: 100_001
            },
            _data: []
        };
    };

    assert.equal(await provider.count({}), 100_001);
}

async function runMongoNormalizationUnitCoverage() {
    const definition =
        definitionFor("mongo", "mongo_contract_unit");
    const provider =
        new MongoEntityProvider({
            _definition:
                definition,
            _physical_identity:
                physicalIdentity("mongo", definition._id)
        });

    (provider as any)._xdb_object = {
        updateManyRaw: async () => ({
            _matched: 2,
            _modified: 1
        })
    };

    const result =
        await provider.update(
            { score: { _gt: 10 } },
            { score: 11 }
        );

    assert.deepEqual(result, {
        _matched: 2,
        _modified: 1,
        _updated: 1
    });

    await assertRejects(async () => {
        (provider as any).translateFilter({
            score: {
                _in: "not-an-array"
            }
        });
    });
    await assertRejects(async () => {
        (provider as any).translateFilter({
            score: {
                _unsupported: 10
            }
        });
    });
}

async function runSQLiteSchemaRejectionCoverage(
    runtimeContext: EntityProviderRuntimeContext
) {
    const definition = {
        _id: "sqlite_indexed_array_rejection",
        _storage: {
            _provider: "sqlite",
            _scope: "app"
        },
        _schema: {
            participant_ids: {
                _type: "Array",
                _index: true
            }
        }
    };
    const provider =
        new SQLiteEntityProvider({
            _definition:
                definition,
            _physical_identity:
                physicalIdentity("sqlite", definition._id),
            _runtime_context:
                runtimeContext
        });

    try {
        await assertRejects(() => provider.init());
    } finally {
        await provider.dispose();
    }
}

async function runXDBSQLiteStorageRegression(workFolder: string) {
    const dbPath =
        path.join(workFolder, "xdb-storage-sqlite", "xdb.sqlite");
    const blobFolder =
        path.join(workFolder, "xdb-storage-sqlite", "blobs");
    const entityName =
        "whole_document_regression";
    const payload = {
        _meta: {
            _name:
                entityName,
            _records: 1
        },
        _schema: {
            name: {
                _type: "String"
            }
        },
        _data: [
            {
                _id: "sqlite-xdb-id",
                name: "Persisted"
            }
        ],
        _vectors: {},
        _entity_vectors_index: {},
        _entity_matrices_index: {},
        _indices: {}
    };

    let storage =
        new XDBStorageSqlite({
            dbPath,
            blobStorage:
                new XDBStorageFS({
                    xdbFolder:
                        blobFolder
                })
        });
    await storage.open();
    await storage.saveEntity(entityName, payload, true);
    await storage.saveObject("whole-document-object", {
        _ok: true
    });
    await storage.saveVector(entityName, "vector-1", [1, 2, 3]);
    await storage.saveFile(entityName, "file-1", {
        _kind: "file"
    });
    await storage.saveTempFile(entityName, "temp-1", {
        _kind: "temp"
    });
    await storage.appendCsv(entityName, "a,b");
    await storage.close();

    storage =
        new XDBStorageSqlite({
            dbPath,
            blobStorage:
                new XDBStorageFS({
                    xdbFolder:
                        blobFolder
                })
        });
    await storage.open();

    assert.deepEqual(
        await storage.loadEntity(entityName),
        payload
    );
    assert.deepEqual(
        JSON.parse((await storage.loadObject("whole-document-object")) ?? "null"),
        {
            _ok: true
        }
    );
    assert.deepEqual(
        await storage.loadVector(entityName, "vector-1"),
        [1, 2, 3]
    );
    assert.deepEqual(
        JSON.parse((await storage.loadFile(entityName, "file-1")) ?? "null"),
        {
            _kind: "file"
        }
    );
    assert.deepEqual(
        JSON.parse((await storage.loadTempFile(entityName, "temp-1")) ?? "null"),
        {
            _kind: "temp"
        }
    );
    assert.equal(
        await storage.loadTempCsv(entityName),
        "a,b\n"
    );

    await storage.close();
}

async function runXDBCacheRegression(workFolder: string) {
    const cacheFolder =
        path.join(workFolder, "xdb-cache") + path.sep;
    let cache =
        new XDBCache({
            cacheFolder
        });
    await cache.init();
    assert.equal(
        cache.set("provider-contract", {
            _value: 42
        }),
        true
    );
    cache.saveCache();

    cache =
        new XDBCache({
            cacheFolder
        });
    await cache.init();
    assert.deepEqual(
        cache.get("provider-contract"),
        {
            _value: 42
        }
    );
}

export async function run_entity_provider_conformance_tests() {
    const workFolder =
        await mkdtemp(
            path.join(tmpdir(), "xnode-entity-provider-conformance-")
        );
    const runtimeContext: EntityProviderRuntimeContext = {
        _work_folder:
            workFolder
    };

    try {
        XDB.init({
            storage:
                new XDBStorageFS({
                    xdbFolder:
                        path.join(workFolder, "xdb")
                }),
            workFolder,
            enableCache: false
        });
        await (XDB as any).onLoad();

        for (const providerType of ["xdb", "memory", "sqlite"] as const) {
            const entityId =
                `portable_v1_${providerType}`;
            const definition =
                definitionFor(providerType, entityId);
            const identity =
                physicalIdentity(providerType, entityId);
            const testCase: EntityProviderConformanceCase = {
                _provider:
                    providerType,
                _durable:
                    providerType !== "memory",
                _definition:
                    definition,
                _physical_identity:
                    identity,
                _runtime_context:
                    runtimeContext,
                _create: () =>
                    createEntityProvider(
                        definition,
                        identity,
                        runtimeContext
                    )
            };

            await runEntityProviderConformanceSuite(testCase);
            await runEntityManagerEnvelopeSuite(
                providerType,
                runtimeContext
            );
        }

        const sqlite =
            createEntityProvider(
                definitionFor("sqlite", "sqlite_runtime_context"),
                physicalIdentity("sqlite", "sqlite_runtime_context"),
                runtimeContext
            ) as SQLiteEntityProvider;
        await sqlite.init();
        assert.equal(
            sqlite.getDebugStats()._db_path,
            path.join(workFolder, "xdb", "entity-provider.sqlite")
        );
        assert.equal(sqlite.getCapability("transactions")._supported, false);
        assert.equal(sqlite.getCapability("operation-atomic-writes")._supported, true);
        await sqlite.dispose();

        await runSQLiteSchemaRejectionCoverage(runtimeContext);
        await runXDBSQLiteStorageRegression(workFolder);
        await runXDBCacheRegression(workFolder);
        await runExactCountCapRegression();
        await runMongoNormalizationUnitCoverage();
    } finally {
        await rm(workFolder, {
            recursive: true,
            force: true
        });
    }
}
