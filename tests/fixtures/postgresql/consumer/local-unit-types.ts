import { bindEntityLocalUnit, migratePostgreSQLStore, ENTITY_LOCAL_UNIT_DURABILITY_CAPABILITIES,
    type PostgreSQLMaintenanceOptions, type EntityLocalUnitDurability, type EntityLocalUnitOwnerContext } from "@xpell/node";

async function nativeConsumer() {
    const binding = await bindEntityLocalUnit({ _app_id: "synthetic", _env: "test",
        _entities: [{ _entity: "effects", _write: true }], _durability_contract: "provider-neutral-v1",
        _capacity_profile: "expanded-v1", _hash_policy: "create-and-preserve-v1" });
    const descriptor: EntityLocalUnitDurability | undefined = binding._durability_contract;
    if (descriptor?._store_identity._kind === "postgresql-store-v1") {
        const version: number = descriptor._store_identity._schema_version; void version;
    }
    return binding.commit({ _unit_id: "01234567-89ab-4cde-8fab-0123456789ab", _records: [
        { _entity: "effects", _id: "01234567-89ab-4cde-8fab-0123456789ac", _expect: null }
    ] });
}
// Compile only: no database/bootstrap or function invocation.
// @ts-expect-error Copied tuples do not grant opaque native authority.
const forged: EntityLocalUnitOwnerContext = {};
// @ts-expect-error Unsupported contracts fail statically and at runtime.
bindEntityLocalUnit({ _app_id: "synthetic", _env: "test", _entities: [], _durability_contract: "unknown" });
void nativeConsumer; void forged; void ENTITY_LOCAL_UNIT_DURABILITY_CAPABILITIES;

async function migrationConsumer(options: PostgreSQLMaintenanceOptions) {
    const oldVersion: 2 = (await migratePostgreSQLStore({ ...options, _from_version: 1, _to_version: 2 }))._schema_version;
    const newVersion: 3 = (await migratePostgreSQLStore({ ...options, _from_version: 2, _to_version: 3 }))._schema_version;
    return [oldVersion, newVersion];
}
void migrationConsumer;
