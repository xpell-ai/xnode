import type {
    EntityPhysicalIdentity,
    EntityProviderType,
    EntityStorageScope
} from "./EntityProvider.js";

export type EntityScopeIdentity = EntityPhysicalIdentity & {
    _registry_key: string;
    _app_id: string;
    _env: string;
};

export type ResolveEntityScopeIdentityInput = {
    _app_id?: unknown;
    _env?: unknown;
    _entity_id?: unknown;
    _provider: EntityProviderType;
    _storage_scope?: unknown;
    _require_app_scope?: boolean;
};

function normalize_scope_segment(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a non-empty string`);
    }

    const normalized =
        value
            .normalize("NFKC")
            .trim();

    if (!normalized) {
        throw new Error(`${field} must be a non-empty string`);
    }

    if (normalized.startsWith("$")) {
        throw new Error(`${field} is unresolved`);
    }

    return normalized;
}

function normalize_env(value: unknown): string {
    return normalize_scope_segment(value, "_env")
        .toLowerCase();
}

function normalize_storage_scope(value: unknown): EntityStorageScope {
    const scope =
        String(value ?? "app")
            .normalize("NFKC")
            .trim()
            .toLowerCase();

    if (scope === "app" || scope === "global" || scope === "server") {
        return scope;
    }

    throw new Error(`unsupported entity storage scope: ${scope}`);
}

function encode_scope_segment(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

export function encode_entity_physical_name(physical_identity: string) {
    if (/^[A-Za-z0-9._-]+$/.test(physical_identity)) {
        return {
            _physical_entity_name:
                physical_identity,
            _physical_entity_encoding:
                "plain"
        };
    }

    return {
        _physical_entity_name:
            `xent_${Buffer.from(physical_identity, "utf8").toString("base64url")}`,
        _physical_entity_encoding:
            "base64url"
    };
}

export function resolve_entity_scope_identity(
    input: ResolveEntityScopeIdentityInput
): EntityScopeIdentity {
    const logical_entity_id =
        normalize_scope_segment(input._entity_id, "_entity");

    const storage_scope =
        normalize_storage_scope(input._storage_scope);

    if (
        input._require_app_scope === true &&
        storage_scope !== "app"
    ) {
        throw new Error("generated app entities must use app-scoped storage");
    }

    let app_id = "";
    let env = "";
    let registry_key = "";
    let physical_identity = "";

    if (storage_scope === "app") {
        app_id =
            normalize_scope_segment(input._app_id, "_app_id");
        env =
            normalize_env(input._env);
        registry_key =
            `app::${encode_scope_segment(env)}::${encode_scope_segment(app_id)}::${encode_scope_segment(logical_entity_id)}`;
        physical_identity =
            registry_key;
    } else if (storage_scope === "server") {
        registry_key =
            `server::${encode_scope_segment(logical_entity_id)}`;
        physical_identity =
            registry_key;
    } else {
        registry_key =
            `global::${encode_scope_segment(logical_entity_id)}`;
        physical_identity =
            logical_entity_id;
    }

    const encoded =
        encode_entity_physical_name(physical_identity);

    return {
        _app_id:
            app_id,
        _env:
            env,
        _logical_entity_id:
            logical_entity_id,
        _registry_key:
            registry_key,
        _physical_identity:
            physical_identity,
        _physical_entity_name:
            encoded._physical_entity_name,
        _physical_entity_encoding:
            encoded._physical_entity_encoding,
        _provider:
            input._provider,
        _provider_type:
            input._provider,
        _storage_scope:
            storage_scope,
        _is_global_storage:
            storage_scope === "global",
        _is_scoped_storage:
            storage_scope !== "global"
    };
}

