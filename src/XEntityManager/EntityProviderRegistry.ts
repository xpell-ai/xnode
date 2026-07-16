import type {
    EntityPhysicalIdentity,
    EntityProvider,
    EntityProviderType
} from "./EntityProvider.js";
import { MemoryEntityProvider } from "./MemoryEntityProvider.js";
import { MongoEntityProvider } from "./MongoEntityProvider.js";
import { SQLiteEntityProvider } from "./SQLiteEntityProvider.js";
import { XDBEntityProvider } from "./XDBEntityProvider.js";

type EntityProviderConstructor = new (opts: {
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
}) => EntityProvider;

const ENTITY_PROVIDER_TYPES: EntityProviderType[] = [
    "xdb",
    "memory",
    "sqlite",
    "mongo"
];

const ENTITY_PROVIDER_REGISTRY: Record<EntityProviderType, EntityProviderConstructor> = {
    xdb:
        XDBEntityProvider,
    memory:
        MemoryEntityProvider,
    sqlite:
        SQLiteEntityProvider,
    mongo:
        MongoEntityProvider
};

export function resolveEntityProviderType(raw_provider: any): EntityProviderType {
    const provider =
        String(raw_provider ?? "xdb")
            .trim()
            .toLowerCase();

    if (ENTITY_PROVIDER_TYPES.includes(provider as EntityProviderType)) {
        return provider as EntityProviderType;
    }

    throw new Error(
        `unsupported entity storage provider: ${provider}`
    );
}

export function createEntityProvider(
    definition: any,
    physical_identity: EntityPhysicalIdentity
): EntityProvider {
    const Provider =
        ENTITY_PROVIDER_REGISTRY[physical_identity._provider];

    if (!Provider) {
        throw new Error(
            `unsupported entity storage provider: ${physical_identity._provider}`
        );
    }

    return new Provider({
        _definition:
            definition,
        _physical_identity:
            physical_identity
    });
}
