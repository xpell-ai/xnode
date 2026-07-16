import {
    XModule,
    XResponseOK,
    XResponseError,
    type XCommand,
    _xlog,
    type XpellSkill
} from "@xpell/core";

import XDB from "../XDB/XDB.js";
import XDBEntity from "../XDB/XDBEntity.js";
import { _xem } from "../XEM/XEventManager.js";
import { wsBroadcastScoped } from "../Wormholes/wh.index.js";

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
            _description: "Get underlying XDBEntity."
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
            "Runtime entity registry and CRUD operations for XDB entities.",

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
            "Entity definitions are backed by XDBEntity.",
            "Use get_schema to inspect entity structure."
        ]
    };

    static _ops = XENTITY_MANAGER_OPS;

    private _entities: Map<string, any> = new Map();

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

    private getStoredEntity(params: any) {

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

    private async applyHashFilter(
        xdb_entity: XDBEntity,
        result: any,
        hash_filter: any
    ) {
        if (
            hash_filter === undefined ||
            hash_filter === null
        ) {
            return result;
        }

        if (
            typeof hash_filter !== "object" ||
            Array.isArray(hash_filter)
        ) {
            throw new Error(
                "_hash_filter must be an object"
            );
        }

        const entries =
            Object.entries(hash_filter);

        if (entries.length === 0) {
            return result;
        }

        const filtered_data = [];

        for (const record of result?._data ?? []) {
            let matches =
                true;

            for (const [field_name, plain_text] of entries) {
                if (typeof plain_text !== "string") {
                    throw new Error(
                        `_hash_filter.${field_name} must be a string`
                    );
                }

                const ok =
                    await xdb_entity.verifyHashField(
                        record,
                        field_name,
                        plain_text
                    );

                if (!ok) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                filtered_data.push(record);
            }
        }

        result._data =
            filtered_data;

        if (result._meta) {
            result._meta._records =
                filtered_data.length;
            result._meta._total_records =
                filtered_data.length;
        }

        return result;
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

            const existing =
                this._entities.get(key);

            if (existing?._xdb_entity) {
                await existing._xdb_entity.syncSchema(
                    entity._schema ?? {},
                    entity._meta ?? {}
                );

                existing._definition = entity;

                _xlog.log(
                    `[entity-manager] updated '${entity_id}'`
                );

                return new XResponseOK({
                    _entity: entity_id,
                    _action: "update",
                    _registered: true
                }).toXData();
            }

            const xdb_entity =
                XDB.create({

                    _type:
                        XDBEntity._xtype,

                    _id:
                        entity_id,

                    _name:
                        entity._name ??
                        entity._title ??
                        entity_id,

                    _schema:
                        entity._schema ?? {},

                    _meta:
                        entity._meta ?? {},

                    _description:
                        entity._description
                });

            await xdb_entity.syncSchema(
                entity._schema ?? {},
                entity._meta ?? {}
            );

            this._entities.set(key, {

                _app_id: app_id,

                _env: env,

                _definition: entity,

                _xdb_entity: xdb_entity
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

            const xdb_entity_name =
                stored?._xdb_entity?._name ??
                entity_id;

            const runtime_deleted =
                this._entities.delete(key);

            const xdb_unregistered =
                XDB._engine?.removeEntity?.(xdb_entity_name) === true;

            return new XResponseOK({
                _entity: entity_id,
                _deleted: runtime_deleted,
                _runtime_unregistered: true,
                _xdb_unregistered: xdb_unregistered
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
                    stored._definition
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
                    stored._xdb_entity
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
                    ._xdb_entity
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
                params.id ??
                params._id;

            const result =
                await stored
                    ._xdb_entity
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
                stored
                    ._xdb_entity
                    .find(
                        filter,
                        skip,
                        limit,
                        false,
                        reverseOrder,
                        sortInput
                    );

            await this.applyHashFilter(
                stored._xdb_entity,
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
                    Array.isArray(result?._data)
                        ? result._data.length
                        : 0,
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

            let value = 0;

            for (const record of records) {
                if (!record || typeof record !== "object") continue;
                const raw =
                    record[field];
                if (raw === undefined || raw === null || raw === "") continue;
                const numeric =
                    Number(raw);
                if (!Number.isFinite(numeric)) {
                    throw new Error(`Field ${field} contains a non-numeric value`);
                }
                value += numeric;
            }

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

            const before = stored._xdb_entity.find(filter)?._data ?? [];

            const result = await stored._xdb_entity.update(filter, updates);

            for (const record of before
                .map((x: any) => stored._xdb_entity.findById(x._id))
                .filter(Boolean)) {
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

            const deleted_records = stored._xdb_entity.find(filter)?._data ?? [];

            const result = await stored._xdb_entity.delete(filter);

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
