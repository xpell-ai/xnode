import {
    XModule,
    XResponseOK,
    XResponseError,
    type XCommand,
    _xlog
} from "@xpell/core";

import XDB from "../XDB/XDB.js";
import XDBEntity from "../XDB/XDBEntity.js";
import { _xem } from "../XEM/XEventManager.js";
import { wsBroadcastScoped } from "../Wormholes/wh.index.js";

export class XEntityManager extends XModule {

    static _name = "entity-manager";

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

            // already registered
            if (this._entities.has(key)) {

                return new XResponseOK({
                    entity: entity_id,
                    exists: true
                }).toXData();
            }

            const xdb_entity =
                XDB.create({

                    _type:
                        XDBEntity._xtype,

                    _id:
                        entity_id,

                    _name:
                        entity._title ??
                        entity_id,

                    _schema:
                        entity._schema ?? {},

                    _meta:
                        entity._meta ?? {},

                    _description:
                        entity._description
                });

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
                _entity: entity_id
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

            this._entities.delete(key);

            return new XResponseOK({
                _entity: entity_id,
                _deleted: true
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

            const result =
                stored
                    ._xdb_entity
                    .find(filter);

            return new XResponseOK({
                _records: result
            }).toXData();

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

            const before =stored._xdb_entity.find(filter)?._data ?? [];

            const result =await stored._xdb_entity.update(filter, updates);

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

            const deleted_records =stored._xdb_entity.find(filter)?._data ?? [];

            const result =await stored._xdb_entity.delete(filter);

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
