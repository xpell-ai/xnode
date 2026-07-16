import {
    XModule,
    XResponseOK,
    XResponseError,
    type XCommand,
    _xlog,
    type XpellSkill
} from "@xpell/core";

import XDB from "../XDB/XDB.js";
import type { XDBEntityPersisted } from "../XDB/IXDBStorage.js";
import { _xem } from "../XEM/XEventManager.js";
import { wsBroadcastScoped } from "../Wormholes/wh.index.js";
import type {
    EntityAggregationRequest,
    EntityPhysicalIdentity,
    EntityProvider,
    EntityProviderType,
    EntityStorageScope
} from "./EntityProvider.js";
import { aggregateEntityRecords } from "./EntityProvider.js";
import {
    createEntityProvider,
    resolveEntityProviderType
} from "./EntityProviderRegistry.js";

type EntityRegistryEntry = {
    _app_id: string;
    _env: string;
    _definition: any;
    _provider_type: string;
    _provider: EntityProvider;
    _physical_identity: EntityPhysicalIdentity;
};

type EntityMigrationMode = "dry-run" | "copy" | "move";

type EntityMigrationResources = {
    _files: Record<string, any>;
    _vectors: Record<string, number[]>;
    _vector_index?: any;
    _temp_files: Record<string, any>;
    _temp_csv?: string;
    _temp_copy_csv?: string;
};

const XENTITY_MANAGER_OPS = {
        _register: {
            _name: "_register",
            _scope: "module",
            _description: "Register runtime entity definition."
        },

        _unregister: {
            _name: "_unregister",
            _scope: "module",
            _description: "Remove entity registration."
        },

        _has: {
            _name: "_has",
            _scope: "module",
            _description: "Check if entity exists."
        },

        _get_schema: {
            _name: "_get_schema",
            _scope: "module",
            _description: "Get entity schema."
        },

        _get_entity: {
            _name: "_get_entity",
            _scope: "module",
            _description: "Get provider runtime entity handle."
        },

        _storage_diagnostics: {
            _name: "_storage_diagnostics",
            _scope: "module",
            _description: "Internal diagnostic report for logical entity scope and physical XDB storage identity."
        },

        _storage_migration_dry_run: {
            _name: "_storage_migration_dry_run",
            _scope: "module",
            _description: "Build an explicit dry-run report for migrating a legacy global XDB entity into scoped storage."
        },

        _storage_migrate: {
            _name: "_storage_migrate",
            _scope: "module",
            _description: "Explicitly copy or move a legacy global XDB entity into scoped storage."
        },

        _storage_migration_diagnostics: {
            _name: "_storage_migration_diagnostics",
            _scope: "module",
            _description: "List legacy global XDB entities, scoped XDB entities, and migration status."
        },

        _add: {
            _name: "_add",
            _scope: "module",
            _description: "Create record."
        },

        _get: {
            _name: "_get",
            _scope: "module",
            _description: "Get record."
        },

        _find: {
            _name: "_find",
            _scope: "module",
            _description: "Query records.",
            _params: {
                _filter: "Normal XDB equality/query filter.",
                _hash_filter: "Optional explicit Hash field verification map: { [hash_field_name]: plain_text_value }."
            }
        },

        _aggregate: {
            _name: "_aggregate",
            _scope: "module",
            _description: "Aggregate records."
        },

        _update: {
            _name: "_update",
            _scope: "module",
            _description: "Update record."
        },

        _delete: {
            _name: "_delete",
            _scope: "module",
            _description: "Delete record."
        },

        _list: {
            _name: "_list",
            _scope: "module",
            _description: "List records."
        }
    };

export class XEntityManager extends XModule {

    static _name = "entity-manager";
    static _skill: XpellSkill = {
        _id: "entity-manager",
        _title: "Entity Manager",
        _version: "1.0.0",
        _active: true,
        _type: "server-module-api",
        _requires: ["xdb"],

        _description:
            "Runtime entity registry and CRUD operations for provider-backed entities.",

        _exports: {
            _modules: [
                {
                    _name: "entity-manager",
                    _scope: "server",
                    _description:
                        "Register entities and perform CRUD operations.",
                    _ops: Object.values(XENTITY_MANAGER_OPS)
                }
            ]
        },

        _core_rules: [
            "Register entities before CRUD operations.",
            "Use add/get/find/update/delete for record management.",
            "Entity definitions are backed by internal entity providers.",
            "Use get_schema to inspect entity structure."
        ]
    };

    static _ops = XENTITY_MANAGER_OPS;

    private _entities: Map<string, EntityRegistryEntry> = new Map();

    constructor(opts: any = {}) {

        super({
            _name: XEntityManager._name
        });
    }

    /* -------------------------------------------------- */
    /* HELPERS                                            */
    /* -------------------------------------------------- */

    private getEntityKey(
        app_id: string,
        env: string,
        entity_id: string
    ) {
        return `${env}::${app_id}::${entity_id}`;
    }

    private getStoredEntity(params: any): EntityRegistryEntry {

        const app_id =
            params._app_id;

        const env =
            params._env ?? "default";

        const entity_id =
            params._entity ||
            params.entity ||
            params._entity_id;

        if (!entity_id) {
            throw new Error("missing entity id");
        }

        const key =
            this.getEntityKey(
                app_id,
                env,
                entity_id
            );

        const stored =
            this._entities.get(key);

        if (!stored) {
            throw new Error(
                `entity not found: ${entity_id}`
            );
        }

        return stored;
    }

    private createProvider(
        entity: any,
        physical_identity: EntityPhysicalIdentity
    ): EntityProvider {
        return createEntityProvider(
            entity,
            physical_identity
        );
    }

    private resolveStorageProvider(entity: any): EntityProviderType {
        return resolveEntityProviderType(
            entity?._storage?._provider
        );
    }

    private resolveStorageScope(entity: any): EntityStorageScope {
        const scope =
            String(
                entity?._storage?._scope ??
                "global"
            )
                .trim()
                .toLowerCase();

        if (
            scope === "global" ||
            scope === "app" ||
            scope === "server"
        ) {
            return scope;
        }

        throw new Error(
            `unsupported entity storage scope: ${scope}`
        );
    }

    private encodePhysicalEntityName(physical_identity: string) {
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

    private resolveEntityPhysicalIdentity(
        app_id: string,
        env: string,
        entity_id: string,
        entity: any
    ): EntityPhysicalIdentity {
        const provider =
            this.resolveStorageProvider(entity);

        const storage_scope =
            this.resolveStorageScope(entity);

        if (
            storage_scope === "app" &&
            !app_id
        ) {
            throw new Error(
                "app-scoped entity storage requires _app_id"
            );
        }

        const physical_identity =
            storage_scope === "global"
                ? entity_id
                : storage_scope === "app"
                    ? `${env}::${app_id}::${entity_id}`
                    : `server::${entity_id}`;

        const encoded =
            this.encodePhysicalEntityName(physical_identity);

        return {
            _logical_entity_id:
                entity_id,
            _physical_identity:
                physical_identity,
            _physical_entity_name:
                encoded._physical_entity_name,
            _physical_entity_encoding:
                encoded._physical_entity_encoding,
            _provider:
                provider,
            _provider_type:
                provider,
            _storage_scope:
                storage_scope,
            _is_global_storage:
                storage_scope === "global",
            _is_scoped_storage:
                storage_scope !== "global"
        };
    }

    private getEntityStorageDiagnostic(stored: EntityRegistryEntry) {

        const logical_entity_id =
            String(
                stored?._definition?._id ??
                stored?._physical_identity?._logical_entity_id ??
                ""
            );

        const physical_identity =
            stored._physical_identity;

        return {
            _app_id:
                stored?._app_id,
            _env:
                stored?._env,
            _entity:
                logical_entity_id,
            _entity_id:
                logical_entity_id,
            _logical_entity_id:
                logical_entity_id,
            _physical_entity_name:
                physical_identity._physical_entity_name,
            _physical_identity:
                physical_identity._physical_identity,
            _physical_entity_encoding:
                physical_identity._physical_entity_encoding,
            _storage_provider:
                physical_identity._provider,
            _provider:
                stored._provider_type,
            _provider_type:
                physical_identity._provider_type,
            _storage_scope:
                physical_identity._storage_scope,
            _is_global_storage:
                physical_identity._is_global_storage,
            _is_scoped_storage:
                physical_identity._is_scoped_storage
        };
    }

    private cloneJson<T>(value: T): T {
        if (value === undefined || value === null) {
            return value;
        }

        return JSON.parse(
            JSON.stringify(value)
        );
    }

    private stableStringify(value: any): string {
        if (value === null || value === undefined) {
            return String(value);
        }

        if (Array.isArray(value)) {
            return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
        }

        if (typeof value === "object") {
            return `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`)
                .join(",")}}`;
        }

        return JSON.stringify(value);
    }

    private normalizeIndexValue(value: any): string {
        if (value === undefined || value === null) {
            return "__null__";
        }

        if (typeof value === "object") {
            return JSON.stringify(value);
        }

        return String(value);
    }

    private stripRuntimeSchemaFields(schema: any) {
        const out =
            this.cloneJson(schema ?? {});

        delete out._id;
        delete out._created_at;
        delete out._updated_at;

        return out;
    }

    /*
     * Legacy XDB migration helpers intentionally stay at the EntityManager/XDB
     * boundary instead of inside providers. They operate on raw XDB physical
     * resources before a provider owns the target, while normal CRUD behavior
     * must continue to route only through EntityProvider methods.
     */
    private normalizeMigrationSchema(schema: any) {
        const out =
            this.cloneJson(schema ?? {});

        if (!out._id) {
            out._id = {
                _type: "String",
                _required: true,
                _index: {
                    _unique: true,
                    _primary: true
                }
            };
        }

        if (!out._created_at) {
            out._created_at = {
                _type: "Date",
                _required: false,
                _immutable: true
            };
        }

        if (!out._updated_at) {
            out._updated_at = {
                _type: "Date",
                _required: false
            };
        }

        return out;
    }

    private compareSchemas(global_schema: any, target_schema: any) {
        const global_normalized =
            this.stripRuntimeSchemaFields(global_schema);

        const target_normalized =
            this.stripRuntimeSchemaFields(target_schema);

        const missing_in_target: string[] = [];
        const extra_in_target: string[] = [];
        const conflicts: any[] = [];

        for (const field of Object.keys(global_normalized)) {
            if (!Object.prototype.hasOwnProperty.call(target_normalized, field)) {
                missing_in_target.push(field);
                continue;
            }

            if (
                this.stableStringify(global_normalized[field]) !==
                this.stableStringify(target_normalized[field])
            ) {
                conflicts.push({
                    _field: field,
                    _global: global_normalized[field],
                    _target: target_normalized[field]
                });
            }
        }

        for (const field of Object.keys(target_normalized)) {
            if (!Object.prototype.hasOwnProperty.call(global_normalized, field)) {
                extra_in_target.push(field);
            }
        }

        return {
            _missing_in_target: missing_in_target,
            _extra_in_target: extra_in_target,
            _conflicts: conflicts,
            _has_conflicts:
                missing_in_target.length > 0 ||
                conflicts.length > 0
        };
    }

    private buildMigrationIndices(schema: any, records: any[]) {
        const indices: Record<string, any> = {};

        for (const field of Object.keys(schema ?? {})) {
            const index_def =
                schema[field]?._index;

            if (
                field !== "_id" &&
                !index_def
            ) {
                continue;
            }

            const index_schema =
                typeof index_def === "object"
                    ? index_def
                    : {};

            indices[field] = {
                _id: field,
                _unique:
                    field === "_id" ||
                    index_schema?._unique === true,
                _primary:
                    field === "_id" ||
                    index_schema?._primary === true,
                _data: {}
            };
        }

        for (let index = 0; index < records.length; index++) {
            const record =
                records[index];

            for (const field of Object.keys(indices)) {
                if (
                    !record ||
                    !Object.prototype.hasOwnProperty.call(record, field)
                ) {
                    continue;
                }

                const idx =
                    indices[field];

                const raw_value =
                    record[field];

                const key =
                    this.normalizeIndexValue(raw_value);

                if (idx._primary) {
                    idx._data[key] = index;
                    continue;
                }

                if (idx._unique) {
                    idx._data[key] = record._id;
                    continue;
                }

                const stype =
                    String(schema[field]?._type ?? "")
                        .toLowerCase();

                if (
                    stype === "array" &&
                    Array.isArray(raw_value)
                ) {
                    for (const item of raw_value) {
                        const item_key =
                            this.normalizeIndexValue(item);

                        if (!Array.isArray(idx._data[item_key])) {
                            idx._data[item_key] = [];
                        }

                        idx._data[item_key].push(record._id);
                    }

                    continue;
                }

                if (!Array.isArray(idx._data[key])) {
                    idx._data[key] = [];
                }

                idx._data[key].push(record._id);
            }
        }

        return indices;
    }

    private getUniqueSchemaFields(schema: any) {
        return Object.keys(schema ?? {})
            .filter((field) => {
                const index_def =
                    schema[field]?._index;

                return (
                    field === "_id" ||
                    (
                        typeof index_def === "object" &&
                        index_def?._unique === true
                    )
                );
            });
    }

    private recordsEqualById(source_records: any[], target_records: any[]) {
        if (source_records.length !== target_records.length) {
            return false;
        }

        const target_by_id =
            new Map(
                target_records.map((record) => [
                    String(record?._id ?? ""),
                    record
                ])
            );

        for (const source_record of source_records) {
            const id =
                String(source_record?._id ?? "");

            const target_record =
                target_by_id.get(id);

            if (!target_record) {
                return false;
            }

            if (
                this.stableStringify(source_record) !==
                this.stableStringify(target_record)
            ) {
                return false;
            }
        }

        return true;
    }

    private collectMigrationFileIds(schema: any, records: any[]) {
        const file_fields =
            Object.keys(schema ?? {})
                .filter((field) =>
                    String(schema[field]?._type ?? "")
                        .toLowerCase() === "file"
                );

        const ids =
            new Set<string>();

        for (const record of records) {
            for (const field of file_fields) {
                const value =
                    record?.[field];

                if (typeof value === "string" && value) {
                    ids.add(value);
                }
            }
        }

        return Array.from(ids);
    }

    private collectMigrationVectorIds(payload: XDBEntityPersisted) {
        const ids =
            new Set<string>();

        const entity_vectors =
            payload?._entity_vectors_index ?? {};

        for (const record_vectors of Object.values(entity_vectors) as any[]) {
            if (!record_vectors || typeof record_vectors !== "object") {
                continue;
            }

            for (const field_vectors of Object.values(record_vectors) as any[]) {
                if (!Array.isArray(field_vectors)) {
                    continue;
                }

                for (const vector_id of field_vectors) {
                    if (typeof vector_id === "string" && vector_id) {
                        ids.add(vector_id);
                    }
                }
            }
        }

        return Array.from(ids);
    }

    private parseStoredJsonValue(value: string) {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    private async loadPhysicalEntityState(physical_entity_name: string) {
        const exists =
            XDB._engine?._xdb_data?._entities?.includes(physical_entity_name) === true;

        const payload =
            await XDB._engine.loadEntity({
                _name: physical_entity_name,
                _data: [],
                _schema: {},
                _indices: {},
                _entity_vectors_index: {},
                _entity_matrices_index: {},
                _meta: {
                    _name: physical_entity_name,
                    _records: 0
                }
            } as any);

        const records =
            Array.isArray(payload?._data)
                ? payload._data
                : [];

        return {
            _exists: exists,
            _record_count: records.length,
            _payload: {
                ...payload,
                _data: records,
                _schema: payload?._schema ?? {},
                _indices: payload?._indices ?? {},
                _entity_vectors_index: payload?._entity_vectors_index ?? {},
                _entity_matrices_index: payload?._entity_matrices_index ?? {},
                _meta: {
                    ...(payload?._meta ?? {}),
                    _name: physical_entity_name,
                    _records: records.length
                }
            } as XDBEntityPersisted
        };
    }

    private async readMigrationResources(
        physical_entity_name: string,
        payload: XDBEntityPersisted
    ): Promise<EntityMigrationResources> {
        const records =
            Array.isArray(payload?._data)
                ? payload._data
                : [];

        const resources: EntityMigrationResources = {
            _files: {},
            _vectors: {},
            _temp_files: {}
        };

        for (const file_id of this.collectMigrationFileIds(payload?._schema, records)) {
            const raw =
                await XDB._engine.loadFile(physical_entity_name, file_id);

            if (raw !== "") {
                resources._files[file_id] =
                    this.parseStoredJsonValue(raw);
            }
        }

        for (const vector_id of this.collectMigrationVectorIds(payload)) {
            const vector =
                await XDB._engine.loadVector(physical_entity_name, vector_id);

            if (Array.isArray(vector) && vector.length > 0) {
                resources._vectors[vector_id] =
                    vector;
            }
        }

        const vector_index =
            await XDB._engine.loadVectorIndex(physical_entity_name);

        if (vector_index !== undefined) {
            resources._vector_index =
                vector_index;
        }

        const temp_file_names =
            await XDB._engine.getAllTempFileNames(physical_entity_name);

        for (const temp_file_name of temp_file_names) {
            const temp_id =
                temp_file_name.endsWith(".json")
                    ? temp_file_name.slice(0, -5)
                    : temp_file_name;

            const raw =
                await XDB._engine.loadTempFile(physical_entity_name, temp_id);

            if (raw !== "") {
                resources._temp_files[temp_id] =
                    this.parseStoredJsonValue(raw);
            }
        }

        const temp_csv =
            await XDB._engine.loadTempCsv(physical_entity_name);

        if (temp_csv) {
            resources._temp_csv =
                temp_csv;
        }

        const temp_copy_csv =
            await XDB._engine.loadTempCsv(physical_entity_name, true);

        if (temp_copy_csv) {
            resources._temp_copy_csv =
                temp_copy_csv;
        }

        return resources;
    }

    private async writeMigrationResources(
        physical_entity_name: string,
        resources: EntityMigrationResources
    ) {
        for (const [file_id, value] of Object.entries(resources._files)) {
            await XDB._engine.saveFile(
                physical_entity_name,
                file_id,
                value
            );
        }

        for (const [vector_id, vector] of Object.entries(resources._vectors)) {
            await XDB._engine.saveVector(
                physical_entity_name,
                vector_id,
                vector
            );
        }

        if (resources._vector_index !== undefined) {
            await XDB._engine.saveVectorIndex(
                physical_entity_name,
                resources._vector_index
            );
        }

        for (const [temp_id, value] of Object.entries(resources._temp_files)) {
            await XDB._engine.saveTempFile(
                physical_entity_name,
                temp_id,
                value
            );
        }

        if (resources._temp_copy_csv) {
            await XDB._engine.clearTempCsv(physical_entity_name);
            await XDB._engine.appendCsv(
                physical_entity_name,
                resources._temp_copy_csv
            );
            await XDB._engine.copyTempCsv(physical_entity_name);
        }

        if (resources._temp_csv) {
            await XDB._engine.clearTempCsv(physical_entity_name);
            await XDB._engine.appendCsv(
                physical_entity_name,
                resources._temp_csv
            );
        }
    }

    private migrationCandidates(entity_id: string) {
        return Array.from(this._entities.values())
            .filter((stored) =>
                String(
                    stored?._definition?._id ??
                    stored?._physical_identity?._logical_entity_id ??
                    ""
                ) === entity_id
            )
            .map((stored) => ({
                _app_id: stored._app_id,
                _env: stored._env,
                _entity_id: entity_id,
                _storage_scope:
                    stored._physical_identity._storage_scope,
                _provider:
                    stored._physical_identity._provider,
                _physical_identity:
                    stored._physical_identity._physical_identity,
                _physical_entity_name:
                    stored._physical_identity._physical_entity_name,
                _definition:
                    stored._definition,
                _stored:
                    stored
            }));
    }

    private selectedMigrationTarget(
        params: any,
        entity_id: string,
        candidates: any[]
    ) {
        const target_app_id =
            params._target_app_id ??
            params._app_id;

        const target_env =
            params._target_env ??
            params._env;

        const target_entity_id =
            params._target_entity_id ??
            params._target_entity ??
            entity_id;

        const has_explicit_target =
            target_app_id !== undefined ||
            target_env !== undefined ||
            params._target_entity_id !== undefined ||
            params._target_entity !== undefined;

        if (has_explicit_target) {
            return candidates.find((candidate) =>
                candidate._app_id === String(target_app_id ?? "") &&
                candidate._env === String(target_env ?? "default") &&
                candidate._entity_id === String(target_entity_id)
            ) ?? null;
        }

        if (candidates.length === 1) {
            return candidates[0];
        }

        return null;
    }

    private detectUniquenessConflicts(
        target_schema: any,
        source_records: any[],
        target_records: any[]
    ) {
        const conflicts: any[] = [];

        for (const field of this.getUniqueSchemaFields(target_schema)) {
            const source_values =
                new Map<string, any[]>();

            for (const source_record of source_records) {
                const value =
                    source_record?.[field];

                if (value === undefined || value === null) {
                    continue;
                }

                const key =
                    this.normalizeIndexValue(value);

                if (!source_values.has(key)) {
                    source_values.set(key, []);
                }

                source_values.get(key)?.push(source_record);
            }

            for (const [value, records] of source_values) {
                if (records.length > 1) {
                    conflicts.push({
                        _type: "duplicate_in_source",
                        _field: field,
                        _value: value,
                        _source_record_ids: records.map((record) => record._id)
                    });
                }
            }

            const target_values =
                new Map<string, any[]>();

            for (const target_record of target_records) {
                const value =
                    target_record?.[field];

                if (value === undefined || value === null) {
                    continue;
                }

                const key =
                    this.normalizeIndexValue(value);

                if (!target_values.has(key)) {
                    target_values.set(key, []);
                }

                target_values.get(key)?.push(target_record);
            }

            for (const [value, source_value_records] of source_values) {
                const target_value_records =
                    target_values.get(value) ?? [];

                const conflicting_target_records =
                    target_value_records.filter((target_record) =>
                        !source_value_records.some((source_record) =>
                            source_record?._id === target_record?._id
                        )
                    );

                if (conflicting_target_records.length > 0) {
                    conflicts.push({
                        _type: "target_conflict",
                        _field: field,
                        _value: value,
                        _source_record_ids:
                            source_value_records.map((record) => record._id),
                        _target_record_ids:
                            conflicting_target_records.map((record) => record._id)
                    });
                }
            }
        }

        return conflicts;
    }

    private migrationTargetPublic(candidate: any) {
        if (!candidate) {
            return null;
        }

        return {
            _app_id: candidate._app_id,
            _env: candidate._env,
            _entity_id: candidate._entity_id,
            _storage_scope: candidate._storage_scope,
            _provider: candidate._provider,
            _physical_identity: candidate._physical_identity,
            _physical_entity_name: candidate._physical_entity_name
        };
    }

    private async buildStorageMigrationReport(
        params: any,
        mode: EntityMigrationMode
    ) {
        const entity_id =
            String(
                params._entity_id ??
                params._entity ??
                params.entity ??
                ""
            );

        if (!entity_id) {
            throw new Error("missing entity id");
        }

        const global_entity_name =
            String(
                params._global_entity_name ??
                entity_id
            );

        const source_state =
            await this.loadPhysicalEntityState(global_entity_name);

        const source_records =
            Array.isArray(source_state._payload._data)
                ? source_state._payload._data
                : [];

        const candidates =
            this.migrationCandidates(entity_id);

        const target =
            this.selectedMigrationTarget(
                params,
                entity_id,
                candidates
            );

        const conflicts: string[] = [];
        let target_state: any = null;
        let schema_differences: any = null;
        let uniqueness_conflicts: any[] = [];
        let target_already_contains_migrated_data = false;
        let source_missing_after_move = false;
        const warnings: string[] = [];

        const ambiguous_ownership =
            !target &&
            candidates.length > 1;

        if (ambiguous_ownership) {
            conflicts.push("ambiguous_ownership");
        }

        if (!target && !ambiguous_ownership) {
            conflicts.push("target_definition_not_found");
        }

        if (target && target._storage_scope !== "app") {
            conflicts.push("target_not_app_scoped");
        }

        if (
            target &&
            target._provider !== "xdb"
        ) {
            conflicts.push("target_provider_not_xdb");
        }

        if (target) {
            target_state =
                await this.loadPhysicalEntityState(
                    target._physical_entity_name
                );

            const target_schema =
                target._definition?._schema ?? {};

            schema_differences =
                this.compareSchemas(
                    source_state._payload._schema ?? {},
                    target_schema
                );

            if (schema_differences._has_conflicts) {
                conflicts.push("schema_conflict");
            }

            const target_records =
                Array.isArray(target_state?._payload?._data)
                    ? target_state._payload._data
                    : [];

            const target_migrated_from_source =
                target_state?._payload?._meta?._migrated_from?._physical_entity_name ===
                global_entity_name;

            target_already_contains_migrated_data =
                !source_state._exists && target_migrated_from_source
                    ? true
                    : target_records.length > 0 &&
                        this.recordsEqualById(
                            source_records,
                            target_records
                        );

            source_missing_after_move =
                !source_state._exists &&
                target_already_contains_migrated_data;

            if (target_already_contains_migrated_data) {
                warnings.push("target_already_contains_migrated_data");
            }

            uniqueness_conflicts =
                this.detectUniquenessConflicts(
                    this.normalizeMigrationSchema(target_schema),
                    source_records,
                    target_records
                );

            if (uniqueness_conflicts.length > 0) {
                conflicts.push("uniqueness_conflict");
            }

            if (
                target_records.length > 0 &&
                !target_already_contains_migrated_data
            ) {
                conflicts.push("target_contains_records");
            }
        }

        if (
            !source_state._exists &&
            !source_missing_after_move
        ) {
            conflicts.push("source_not_found");
        }

        if (source_missing_after_move) {
            warnings.push("source_missing_target_has_migration_marker");
        }

        const unique_conflicts =
            Array.from(new Set(conflicts));

        const unique_warnings =
            Array.from(new Set(warnings));

        const status =
            unique_conflicts.length > 0
                ? "blocked"
                : target_already_contains_migrated_data
                    ? "already_migrated"
                    : "ready";

        const can_migrate =
            unique_conflicts.length === 0 &&
            !source_missing_after_move;

        return {
            _operation:
                "entity-manager.storage_migration",
            _mode:
                mode,
            _status:
                status,
            _can_migrate:
                can_migrate,
            _executed:
                false,
            _global_entity_name:
                global_entity_name,
            _logical_entity_id:
                entity_id,
            _global: {
                _entity_name:
                    global_entity_name,
                _physical_entity_name:
                    global_entity_name,
                _exists:
                    source_state._exists,
                _record_count:
                    source_state._record_count,
                _schema:
                    source_state._payload._schema ?? {}
            },
            _definitions:
                candidates.map((candidate) =>
                    this.migrationTargetPublic(candidate)
                ),
            _target:
                this.migrationTargetPublic(target),
            _target_existing_record_count:
                target_state?._record_count ?? 0,
            _target_already_contains_migrated_data:
                target_already_contains_migrated_data,
            _source_missing_after_move:
                source_missing_after_move,
            _schema_differences:
                schema_differences ?? {
                    _missing_in_target: [],
                    _extra_in_target: [],
                    _conflicts: [],
                    _has_conflicts: false
                },
            _uniqueness_conflicts:
                uniqueness_conflicts,
            _ambiguous_ownership:
                ambiguous_ownership,
            _required_selection:
                ambiguous_ownership
                    ? ["_target_app_id", "_target_env", "_target_entity_id"]
                    : [],
            _conflicts:
                unique_conflicts,
            _warnings:
                unique_warnings,
            _migration_readiness: {
                _status:
                    status,
                _ready:
                    status === "ready",
                _can_migrate:
                    can_migrate,
                _conflicts:
                    unique_conflicts,
                _warnings:
                    unique_warnings
            }
        };
    }

    private buildMigrationTargetPayload(
        source_payload: XDBEntityPersisted,
        target: any
    ): XDBEntityPersisted {
        const data =
            this.cloneJson(
                Array.isArray(source_payload?._data)
                    ? source_payload._data
                    : []
            );

        const schema =
            this.normalizeMigrationSchema(
                target?._definition?._schema ??
                source_payload?._schema ??
                {}
            );

        return {
            _meta: {
                ...(this.cloneJson(source_payload?._meta ?? {})),
                _name:
                    target._physical_entity_name,
                _records:
                    data.length,
                _migrated_from: {
                    _physical_entity_name:
                        source_payload?._meta?._name,
                    _at:
                        new Date().toISOString()
                }
            },
            _schema:
                schema,
            _data:
                data,
            _vectors:
                this.cloneJson(source_payload?._vectors ?? {}),
            _entity_vectors_index:
                this.cloneJson(source_payload?._entity_vectors_index ?? {}),
            _entity_matrices_index:
                this.cloneJson(source_payload?._entity_matrices_index ?? {}),
            _indices:
                this.buildMigrationIndices(schema, data)
        };
    }

    private async saveMigrationPayload(
        physical_entity_name: string,
        payload: XDBEntityPersisted
    ) {
        XDB._engine.addEntity(
            {
                _name:
                    physical_entity_name
            } as any,
            false
        );

        await XDB._engine.saveEntity(
            {
                _name:
                    physical_entity_name,
                _meta:
                    payload._meta,
                _schema:
                    payload._schema,
                _data:
                    payload._data,
                _vectors:
                    payload._vectors,
                _entity_vectors_index:
                    payload._entity_vectors_index,
                _entity_matrices_index:
                    payload._entity_matrices_index,
                _indices:
                    payload._indices
            } as any,
            true
        );

        await XDB._engine.commit();
    }

    private async createMigrationBackup(
        source_entity_name: string,
        target_physical_entity_name: string,
        source_payload: XDBEntityPersisted,
        resources: EntityMigrationResources
    ) {
        const backup_id =
            `entity-migration-backup::${Date.now()}::${source_entity_name}::${target_physical_entity_name}`;

        await XDB._engine.saveObject(
            backup_id,
            {
                _type:
                    "entity-migration-backup",
                _source_physical_entity_name:
                    source_entity_name,
                _target_physical_entity_name:
                    target_physical_entity_name,
                _created_at:
                    new Date().toISOString(),
                _payload:
                    source_payload,
                _resources:
                    resources
            }
        );

        return {
            _id:
                backup_id,
            _created:
                true,
            _strategy:
                "xdb-object-store",
            _source_physical_entity_name:
                source_entity_name,
            _target_physical_entity_name:
                target_physical_entity_name
        };
    }

    private async rollbackStorageMigration(
        source_entity_name: string,
        target_physical_entity_name: string,
        source_payload: XDBEntityPersisted,
        resources: EntityMigrationResources,
        target_was_written: boolean
    ) {
        const rollback: any = {
            _attempted: true,
            _source_restored: false,
            _target_removed: false,
            _errors: []
        };

        try {
            await this.saveMigrationPayload(
                source_entity_name,
                source_payload
            );

            await this.writeMigrationResources(
                source_entity_name,
                resources
            );

            rollback._source_restored =
                true;
        } catch (err: any) {
            rollback._errors.push({
                _phase:
                    "restore_source",
                _message:
                    err?.message ?? String(err)
            });
        }

        if (target_was_written) {
            try {
                await XDB._engine.deleteEntity(
                    target_physical_entity_name
                );

                rollback._target_removed =
                    true;
            } catch (err: any) {
                rollback._errors.push({
                    _phase:
                        "remove_partial_target",
                    _message:
                        err?.message ?? String(err)
                });
            }
        }

        rollback._ok =
            rollback._errors.length === 0;

        return rollback;
    }

    private async buildStorageMigrationDiagnostics(params: any) {
        const entity_filter =
            params._entity_id ??
            params._entity ??
            params.entity;

        const entity_names =
            Array.from(
                new Set<string>(
                    XDB._engine?._xdb_data?._entities ?? []
                )
            )
                .sort();

        const xdb_entries =
            Array.from(this._entities.values())
                .filter((stored) =>
                    stored._physical_identity._provider === "xdb"
                );

        const app_scoped_entries =
            xdb_entries
                .filter((stored) =>
                    stored._physical_identity._storage_scope === "app"
                )
                .filter((stored) =>
                    entity_filter === undefined ||
                    String(stored._physical_identity._logical_entity_id) === String(entity_filter)
                );

        const scoped_physical_names =
            new Set(
                xdb_entries
                    .filter((stored) =>
                        stored._physical_identity._storage_scope !== "global"
                    )
                    .map((stored) =>
                        stored._physical_identity._physical_entity_name
                    )
            );

        const global_entities: any[] = [];

        for (const entity_name of entity_names) {
            if (scoped_physical_names.has(entity_name)) {
                continue;
            }

            if (
                entity_filter !== undefined &&
                entity_name !== String(entity_filter)
            ) {
                continue;
            }

            const state =
                await this.loadPhysicalEntityState(entity_name);

            global_entities.push({
                _entity_name:
                    entity_name,
                _physical_entity_name:
                    entity_name,
                _exists:
                    state._exists,
                _record_count:
                    state._record_count,
                _schema:
                    state._payload._schema ?? {}
            });
        }

        const app_scoped_entities: any[] = [];
        const migration_status: any[] = [];

        for (const stored of app_scoped_entries) {
            const diagnostic =
                this.getEntityStorageDiagnostic(stored);

            const state =
                await this.loadPhysicalEntityState(
                    stored._physical_identity._physical_entity_name
                );

            app_scoped_entities.push({
                ...diagnostic,
                _record_count:
                    state._record_count,
                _schema:
                    state._payload._schema ?? {}
            });

            const report =
                await this.buildStorageMigrationReport(
                    {
                        _entity_id:
                            stored._physical_identity._logical_entity_id,
                        _target_app_id:
                            stored._app_id,
                        _target_env:
                            stored._env,
                        _target_entity_id:
                            stored._physical_identity._logical_entity_id
                    },
                    "dry-run"
                );

            migration_status.push({
                _logical_entity_id:
                    report._logical_entity_id,
                _global_entity_name:
                    report._global_entity_name,
                _target:
                    report._target,
                _status:
                    report._status,
                _can_migrate:
                    report._can_migrate,
                _source_record_count:
                    report._global?._record_count ?? 0,
                _target_record_count:
                    report._target_existing_record_count,
                _conflicts:
                    report._conflicts,
                _warnings:
                    report._warnings
            });
        }

        return {
            _operation:
                "entity-manager.storage_migration_diagnostics",
            _global_entities:
                global_entities,
            _app_scoped_entities:
                app_scoped_entities,
            _migration_status:
                migration_status
        };
    }

    private async executeStorageMigration(
        report: any,
        params: any
    ) {
        if (!report._can_migrate) {
            return report;
        }

        const source_entity_name =
            report._global_entity_name;

        const target =
            report._target;

        if (!target) {
            return {
                ...report,
                _status: "blocked",
                _can_migrate: false,
                _conflicts: [
                    ...report._conflicts,
                    "target_definition_not_found"
                ]
            };
        }

        const source_state =
            await this.loadPhysicalEntityState(source_entity_name);

        const target_entry =
            this.migrationCandidates(report._logical_entity_id)
                .find((candidate) =>
                    candidate._app_id === target._app_id &&
                    candidate._env === target._env &&
                    candidate._entity_id === target._entity_id
                );

        if (!target_entry) {
            return {
                ...report,
                _status: "blocked",
                _can_migrate: false,
                _conflicts: [
                    ...report._conflicts,
                    "target_definition_not_found"
                ]
            };
        }

        const resources =
            await this.readMigrationResources(
                source_entity_name,
                source_state._payload
            );

        const mode =
            report._mode as EntityMigrationMode;

        let backup:
            | any
            | undefined;
        let target_was_written =
            false;

        try {
            if (mode === "move") {
                backup =
                    await this.createMigrationBackup(
                        source_entity_name,
                        target._physical_entity_name,
                        source_state._payload,
                        resources
                    );
            }

            if (params._test_fail_after_backup === true) {
                throw new Error("test failure after backup");
            }

            if (!report._target_already_contains_migrated_data) {
                const target_payload =
                    this.buildMigrationTargetPayload(
                        source_state._payload,
                        target_entry
                    );

                await this.saveMigrationPayload(
                    target._physical_entity_name,
                    target_payload
                );

                target_was_written =
                    true;

                await this.writeMigrationResources(
                    target._physical_entity_name,
                    resources
                );
            }

            if (params._test_fail_after_target_write === true) {
                throw new Error("test failure after target write");
            }

            const verify_target =
                await this.loadPhysicalEntityState(
                    target._physical_entity_name
                );

            const verify_target_records =
                Array.isArray(verify_target._payload._data)
                    ? verify_target._payload._data
                    : [];

            const source_records =
                Array.isArray(source_state._payload._data)
                    ? source_state._payload._data
                    : [];

            const verified =
                verify_target._record_count === source_records.length &&
                this.recordsEqualById(
                    source_records,
                    verify_target_records
                );

            if (!verified) {
                throw new Error("migration target verification failed");
            }

            if (mode === "move") {
                await XDB._engine.deleteEntity(source_entity_name);
            }

            return {
                ...report,
                _status:
                    report._target_already_contains_migrated_data
                        ? "already_migrated"
                        : mode === "move"
                            ? "moved"
                            : "copied",
                _executed:
                    !report._target_already_contains_migrated_data ||
                    mode === "move",
                _backup:
                    backup,
                _verify: {
                    _source_count:
                        source_records.length,
                    _target_count:
                        verify_target._record_count,
                    _records_equal:
                        true,
                    _schema_verified:
                        this.compareSchemas(
                            source_state._payload._schema ?? {},
                            target_entry._definition?._schema ?? {}
                        )._has_conflicts === false
                }
            };
        } catch (err: any) {
            const rollback =
                mode === "move" && backup
                    ? await this.rollbackStorageMigration(
                        source_entity_name,
                        target._physical_entity_name,
                        source_state._payload,
                        resources,
                        target_was_written
                    )
                    : undefined;

            return {
                ...report,
                _status:
                    "failed",
                _executed:
                    false,
                _backup:
                    backup,
                _rollback:
                    rollback,
                _error: {
                    _message:
                        err?.message ?? String(err)
                }
            };
        }
    }

    private broadcastEntityMutation(event_name: string, stored: any, record: any) {
        const payload = {
            _app_id: stored._app_id,
            _env: stored._env,
            _entity: stored._definition?._id,
            _record: record
        };

        void _xem.fire(event_name, payload);

        try {
            wsBroadcastScoped(stored._app_id, stored._env, {
                _name: event_name,
                _args: [payload]
            });
        } catch (err) {
            _xlog.error("[entity-manager] scoped broadcast failed", err);
        }
    }

    /* -------------------------------------------------- */
    /* REGISTER                                           */
    /* -------------------------------------------------- */

    async _register(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const app_id = String(params._app_id ?? "");

            const env = String(params._env ?? "default");

            const entity: any =
                params.entity ||
                params._entity;

            if (!entity) {
                throw new Error("missing entity");
            }

            const entity_id =
                String(
                    entity._id ||
                    entity._name
                );

            if (!entity_id) {
                throw new Error(
                    "entity missing _id"
                );
            }

            const key =
                this.getEntityKey(
                    app_id,
                    env,
                    entity_id
                );

            const physical_identity =
                this.resolveEntityPhysicalIdentity(
                    app_id,
                    env,
                    entity_id,
                    entity
                );

            const existing =
                this._entities.get(key);

            if (existing?._provider) {
                const existing_physical_identity =
                    existing._provider.getPhysicalIdentity();

                const same_physical_identity =
                    existing_physical_identity._provider === physical_identity._provider &&
                    existing_physical_identity._storage_scope === physical_identity._storage_scope &&
                    existing_physical_identity._physical_entity_name === physical_identity._physical_entity_name;

                if (!same_physical_identity) {
                    await existing._provider.dispose();

                    const replacement_provider =
                        this.createProvider(
                            entity,
                            physical_identity
                        );

                    await replacement_provider.init();

                    existing._definition = entity;
                    existing._provider_type = replacement_provider._provider;
                    existing._provider = replacement_provider;
                    existing._physical_identity =
                        replacement_provider.getPhysicalIdentity();
                } else {
                    await existing._provider.syncSchema(entity);

                    existing._definition = entity;
                    existing._physical_identity =
                        existing._provider.getPhysicalIdentity();
                }

                _xlog.log(
                    `[entity-manager] updated '${entity_id}'`
                );

                return new XResponseOK({
                    _entity: entity_id,
                    _action: "update",
                    _registered: true
                }).toXData();
            }

            const provider =
                this.createProvider(
                    entity,
                    physical_identity
                );

            await provider.init();

            this._entities.set(key, {

                _app_id: app_id,

                _env: env,

                _definition: entity,

                _provider_type: provider._provider,

                _provider: provider,

                _physical_identity: provider.getPhysicalIdentity()
            });

            _xlog.log(
                `[entity-manager] registered '${entity_id}'`
            );

            return new XResponseOK({
                _entity: entity_id,
                _action: "create",
                _registered: true
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* UNREGISTER                                         */
    /* -------------------------------------------------- */

    async _unregister(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const app_id = String(params._app_id ?? "");

            const env = String(params._env ?? "default");

            const entity_id = String(params._entity_id ?? "");

            const key =
                this.getEntityKey(
                    app_id,
                    env,
                    entity_id
                );

            const stored =
                this._entities.get(key);

            const runtime_deleted =
                this._entities.delete(key);

            const dispose_result =
                stored
                    ? await stored._provider.dispose()
                    : {
                        _disposed: false,
                        _physical_unregistered: false,
                        _xdb_unregistered: false
                    };

            return new XResponseOK({
                _entity: entity_id,
                _deleted: runtime_deleted,
                _runtime_unregistered: true,
                _xdb_unregistered:
                    dispose_result._xdb_unregistered ??
                    dispose_result._physical_unregistered
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* HAS                                                */
    /* -------------------------------------------------- */

    async _has(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const app_id = String(params._app_id ?? "");

            const env = String(params._env ?? "default");

            const entity_id = String(
                params._entity ||
                params.entity ||
                params._entity_id
            );

            const key =
                this.getEntityKey(
                    app_id,
                    env,
                    entity_id
                );

            return new XResponseOK({
                _exists:
                    this._entities.has(key)
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* GET SCHEMA                                         */
    /* -------------------------------------------------- */

    async _get_schema(xcmd: XCommand) {

        try {

            const stored =
                this.getStoredEntity(
                    xcmd?._params || {}
                );

            return new XResponseOK({
                entity:
                    stored._provider.getSchema()
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* GET ENTITY                                         */
    /* -------------------------------------------------- */

    async _get_entity(xcmd: XCommand) {

        try {

            const stored =
                this.getStoredEntity(
                    xcmd?._params || {}
                );

            return new XResponseOK({
                entity:
                    stored._provider.getRuntimeEntityHandle()
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* STORAGE DIAGNOSTICS                                */
    /* -------------------------------------------------- */

    async _storage_diagnostics(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            if (
                params._entity ||
                params.entity ||
                params._entity_id
            ) {
                const stored =
                    this.getStoredEntity(params);

                return new XResponseOK({
                    _diagnostic:
                        this.getEntityStorageDiagnostic(stored)
                }).toXData();
            }

            const app_id =
                params._app_id;

            const env =
                params._env ?? "default";

            const diagnostics: any[] = [];

            for (const stored of this._entities.values()) {
                if (
                    app_id !== undefined &&
                    stored._app_id !== app_id
                ) {
                    continue;
                }

                if (
                    env !== undefined &&
                    stored._env !== env
                ) {
                    continue;
                }

                diagnostics.push(
                    this.getEntityStorageDiagnostic(stored)
                );
            }

            return new XResponseOK({
                _diagnostics: diagnostics
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* STORAGE MIGRATION DRY RUN                          */
    /* -------------------------------------------------- */

    async _storage_migration_dry_run(xcmd: XCommand) {

        try {

            const report =
                await this.buildStorageMigrationReport(
                    xcmd?._params || {},
                    "dry-run"
                );

            return new XResponseOK({
                _migration:
                    report
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* STORAGE MIGRATE                                    */
    /* -------------------------------------------------- */

    async _storage_migrate(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const mode =
                String(params._mode ?? "")
                    .trim()
                    .toLowerCase();

            if (
                mode !== "copy" &&
                mode !== "move"
            ) {
                throw new Error(
                    "_mode must be 'copy' or 'move'"
                );
            }

            const report =
                await this.buildStorageMigrationReport(
                    params,
                    mode as EntityMigrationMode
                );

            const migration =
                await this.executeStorageMigration(
                    report,
                    params
                );

            return new XResponseOK({
                _migration:
                    migration
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* STORAGE MIGRATION DIAGNOSTICS                      */
    /* -------------------------------------------------- */

    async _storage_migration_diagnostics(xcmd: XCommand) {

        try {

            const diagnostics =
                await this.buildStorageMigrationDiagnostics(
                    xcmd?._params || {}
                );

            return new XResponseOK({
                _migration_diagnostics:
                    diagnostics
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* CREATE RECORD                                      */
    /* -------------------------------------------------- */

    async _add(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const stored =
                this.getStoredEntity(
                    params
                );

            const data =
                params.data ??
                params._data;

            if (!data) {
                throw new Error(
                    "missing data"
                );
            }

            const result =
                await stored
                    ._provider
                    .add(data);

            this.broadcastEntityMutation("xdb:create", stored, result);

            return new XResponseOK({
                _record: result
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* GET RECORD                                         */
    /* -------------------------------------------------- */

    async _get(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const stored =
                this.getStoredEntity(
                    params
                );

            const id =
                String(
                    params.id ??
                    params._id ??
                    ""
                );

            const result =
                await stored
                    ._provider
                    .get(id);

            return new XResponseOK({
                _record: result
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* FIND                                               */
    /* -------------------------------------------------- */

    async _find(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const stored =
                this.getStoredEntity(
                    params
                );

            const filter =
                params.filter ??
                params._filter ??
                {};

            const rawSkip =
                params._skip ??
                params.skip;
            const skip =
                typeof rawSkip === "number" &&
                Number.isInteger(rawSkip)
                    ? Math.max(0, rawSkip)
                    : 0;

            const rawLimit =
                params._limit ??
                params.limit;
            const limit =
                typeof rawLimit === "number" &&
                Number.isInteger(rawLimit)
                    ? Math.max(0, rawLimit)
                    : 100000;

            const reverseOrder =
                params._reverse_order === true ||
                params.reverseOrder === true ||
                params.reverse_order === true;

            const sortInput =
                params._sort ??
                params.sort;

            const xdataDestination =
                typeof params._xdata_destination === "string"
                    ? params._xdata_destination
                    : undefined;

            _xlog.log("[entity-manager] find query", {
                _app_id:
                    params._app_id,
                _env:
                    params._env,
                _entity:
                    params._entity ??
                    params._entity_id,
                _filter:
                    filter,
                _sort:
                    sortInput,
                _skip:
                    skip,
                _limit:
                    limit,
                _reverse_order:
                    reverseOrder,
                _xdata_destination:
                    xdataDestination,
            });

            const result =
                await stored
                    ._provider
                    .find(
                        filter,
                        {
                            _skip: skip,
                            _limit: limit,
                            _include_schema: false,
                            _reverse_order: reverseOrder,
                            _sort: sortInput
                        }
                    );

            await stored._provider.applyHashFilter(
                result,
                params._hash_filter
            );

            _xlog.log("[entity-manager] find result", {
                _app_id:
                    params._app_id,
                _env:
                    params._env,
                _entity:
                    params._entity ??
                    params._entity_id,
                _records:
                    stored._provider.getRecordCount(result),
                _xdata_destination:
                    xdataDestination,
            });

            return new XResponseOK({
                _records: result
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* AGGREGATE                                          */
    /* -------------------------------------------------- */

    async _aggregate(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const aggregation =
                params._aggregation &&
                typeof params._aggregation === "object" &&
                !Array.isArray(params._aggregation)
                    ? params._aggregation as Record<string, any>
                    : (
                        params.aggregation &&
                        typeof params.aggregation === "object" &&
                        !Array.isArray(params.aggregation)
                    )
                        ? params.aggregation as Record<string, any>
                        : {};

            const op =
                String(
                    aggregation?._op ??
                    aggregation?.op ??
                    params._aggregation_op ??
                    params.aggregation_op ??
                    params._op ??
                    params.op ??
                    ""
                )
                    .trim()
                    .toLowerCase();

            const field =
                String(
                    aggregation?._field ??
                    aggregation?.field ??
                    params._field ??
                    params.field ??
                    ""
                )
                    .trim();

            if (op !== "sum") {
                throw new Error("Unsupported aggregation op");
            }

            if (!field) {
                throw new Error("Missing aggregation field");
            }

            const records =
                Array.isArray(params._records)
                    ? params._records
                    : Array.isArray(params.records)
                        ? params.records
                        : [];

            const aggregation_request = {
                _op: op,
                _field: field,
                _records: records
            };

            const aggregation_result =
                (
                    params._app_id !== undefined &&
                    (
                        params._entity ||
                        params.entity ||
                        params._entity_id
                    )
                )
                    ? await this
                        .getStoredEntity(params)
                        ._provider
                        .aggregate(aggregation_request)
                    : aggregateEntityRecords(aggregation_request);

            const value =
                aggregation_result._value;

            _xlog.log("[entity-manager] aggregate result", {
                _entity:
                    params._entity ??
                    params._entity_id,
                _op:
                    op,
                _field:
                    field,
                _records:
                    records.length,
                _value:
                    value,
                _xdata_key:
                    typeof params._result_xdata_key === "string"
                        ? params._result_xdata_key
                        : typeof params._xdata_destination === "string"
                            ? params._xdata_destination
                            : undefined,
            });
            _xlog.log("[entity-manager] aggregate value resolved", {
                _field:
                    field,
                _value:
                    value,
                _xdata_key:
                    typeof params._result_xdata_key === "string"
                        ? params._result_xdata_key
                        : typeof params._xdata_destination === "string"
                            ? params._xdata_destination
                            : undefined,
            });

            if (typeof params._xdata_destination === "string") {
                _xlog.warn("[entity-manager] aggregate _xdata_destination is deprecated for XVibe summaries; use the generated xd.set value extraction", {
                    _field:
                        field,
                    _xdata_destination:
                        params._xdata_destination,
                });
            }

            const response =
                new XResponseOK({
                    _aggregation: {
                        _op:
                            op,
                        _field:
                            field,
                        _value:
                            value,
                    },
                    _value:
                        value,
                }).toXData();

            _xlog.log("[xentity] aggregate response", {
                _entity:
                    params._entity ??
                    params._entity_id,
                _field:
                    field,
                _response_keys:
                    Object.keys(response),
                _result_type:
                    Array.isArray(response._result) ? "array" : typeof response._result,
                _result_keys:
                    response._result &&
                    typeof response._result === "object" &&
                    !Array.isArray(response._result)
                        ? Object.keys(response._result)
                        : undefined,
                _value_type:
                    typeof response._result?._value,
                _value:
                    response._result?._value,
            });

            return response;

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* UPDATE                                             */
    /* -------------------------------------------------- */

    async _update(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const stored =
                this.getStoredEntity(
                    params
                );

            const filter =
                params.filter ??
                params._filter;

            const updates =
                params.updates ??
                params._updates ??
                params.data ??
                params._data;

            const before_result =
                await stored._provider.find(filter);

            const before =
                stored._provider.getRecords(before_result);

            const result = await stored._provider.update(filter, updates);

            for (const row of before) {
                const record =
                    await stored._provider.get(row._id);

                if (!record) {
                    continue;
                }

                this.broadcastEntityMutation("xdb:update", stored, record);
            }

            return new XResponseOK(result).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }

    /* -------------------------------------------------- */
    /* DELETE                                             */
    /* -------------------------------------------------- */

    async _delete(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const stored =
                this.getStoredEntity(params);

            const filter =
                params.filter ??
                params._filter ??
                (
                    params.id ||
                        params._id
                        ? {
                            _id:
                                params.id ??
                                params._id
                        }
                        : null
                );

            if (!filter) {
                throw new Error(
                    "missing delete filter"
                );
            }

            const deleted_result =
                await stored._provider.find(filter);

            const deleted_records =
                stored._provider.getRecords(deleted_result);

            const result = await stored._provider.delete(filter);

            for (const record of deleted_records) {
                this.broadcastEntityMutation("xdb:delete", stored, record);
            }

            return new XResponseOK(result).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }
    /* -------------------------------------------------- */
    /* LIST                                               */
    /* -------------------------------------------------- */

    async _list(xcmd: XCommand) {

        try {

            const params =
                xcmd?._params || {};

            const app_id =
                params._app_id;

            const env =
                params._env ?? "default";

            const entities: string[] = [];

            for (const [key, value] of this._entities) {

                if (
                    value._app_id === app_id &&
                    value._env === env
                ) {
                    entities.push(
                        value._definition._id
                    );
                }
            }

            return new XResponseOK({
                entities
            }).toXData();

        } catch (err) {

            return new XResponseError(err)
                .toXData();
        }
    }
}
