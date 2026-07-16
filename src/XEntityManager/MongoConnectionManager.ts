import mongoose from "mongoose";
import type { Connection } from "mongoose";
import { XError, _xlog } from "@xpell/core";
import { _xs } from "../XSettings/XSettings.js";

export type MongoConnectionName = string;

export type MongoConnectionConfig = {
    _uri?: string;
    _uri_env?: string;
    _db_name?: string;
    _options?: Record<string, any>;
};

export type MongoConnectionState =
    | "idle"
    | "connecting"
    | "connected"
    | "disconnected"
    | "failed";

type MongoConnectionEntry = {
    _name: string;
    _config: MongoConnectionConfig;
    _connection?: Connection;
    _promise?: Promise<Connection>;
    _state: MongoConnectionState;
    _last_error?: any;
};

export type MongoConnectionFactory = (
    uri: string,
    options: Record<string, any>
) => Connection;

export type MongoConnectionManagerOptions = {
    _create_connection?: MongoConnectionFactory;
};

const DEFAULT_CONNECTION_NAME = "default";

function normalizeMongoConnectionName(name?: string) {
    const normalized =
        String(name ?? DEFAULT_CONNECTION_NAME)
            .trim()
            .toLowerCase();

    if (!normalized) {
        return DEFAULT_CONNECTION_NAME;
    }

    if (!/^[a-z0-9._-]+$/.test(normalized)) {
        throw new XError(
            "E_MONGO_CONNECTION_INVALID_NAME",
            `Invalid Mongo connection name: ${name}`,
            {
                _meta: {
                    _name:
                        name
                }
            }
        );
    }

    return normalized;
}

function envNameForConnection(name: string) {
    const envName =
        name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "_");

    return name === DEFAULT_CONNECTION_NAME
        ? "XPELL_MONGO_URI"
        : `XPELL_MONGO_${envName}_URI`;
}

function readEnv(name: string | undefined) {
    if (!name) {
        return undefined;
    }

    const value =
        process.env[name];

    return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined;
}

export class MongoConnectionManager {
    private readonly _connections =
        new Map<string, MongoConnectionEntry>();

    private readonly _create_connection: MongoConnectionFactory;

    private readonly _default_create_connection: MongoConnectionFactory;

    constructor(opts: MongoConnectionManagerOptions = {}) {
        this._default_create_connection =
            (uri, options) =>
                mongoose.createConnection(
                    uri,
                    options
                );

        this._create_connection =
            opts._create_connection ??
            this._default_create_connection;
    }

    _setConnectionFactoryForTest(
        factory: MongoConnectionFactory
    ) {
        (this as any)._create_connection =
            factory;
    }

    async _resetForTest() {
        await this.disconnectAll();
    }

    _resetConnectionFactoryForTest() {
        (this as any)._create_connection =
            this._default_create_connection;
    }

    private resolveConfiguredConnection(name: string): MongoConnectionConfig {
        const direct =
            _xs.getPath(
                `entity_providers.mongo.${name}`,
                undefined
            );

        const nested =
            _xs.getPath(
                `entity_providers.mongo.connections.${name}`,
                undefined
            );

        const legacy =
            _xs.getPath(
                `mongo.connections.${name}`,
                undefined
            );

        const config =
            direct ??
            nested ??
            legacy ??
            {};

        if (
            !config ||
            typeof config !== "object" ||
            Array.isArray(config)
        ) {
            throw new XError(
                "E_MONGO_CONNECTION_INVALID_CONFIG",
                `Mongo connection '${name}' configuration must be an object`,
                {
                    _meta: {
                        _name:
                            name
                    }
                }
            );
        }

        return config as MongoConnectionConfig;
    }

    resolveConnectionConfig(name?: string): MongoConnectionConfig {
        const normalized =
            normalizeMongoConnectionName(name);

        const configured =
            this.resolveConfiguredConnection(normalized);

        const uriEnv =
            configured._uri_env ??
            envNameForConnection(normalized);

        const envUri =
            readEnv(uriEnv) ??
            (
                normalized === DEFAULT_CONNECTION_NAME
                    ? readEnv("MONGO_URI")
                    : undefined
            );

        const uri =
            configured._uri ??
            envUri;

        if (!uri) {
            throw new XError(
                "E_MONGO_CONNECTION_MISSING_URI",
                `Mongo connection '${normalized}' is missing _uri or _uri_env`,
                {
                    _meta: {
                        _name:
                            normalized,
                        _uri_env:
                            uriEnv
                    }
                }
            );
        }

        return {
            ...configured,
            _uri:
                uri,
            _uri_env:
                uriEnv,
            _options:
                configured._options ?? {}
        };
    }

    getConnection(name?: string): Connection | undefined {
        const normalized =
            normalizeMongoConnectionName(name);

        return this._connections.get(normalized)?._connection;
    }

    getConnectionState(name?: string): MongoConnectionState {
        const normalized =
            normalizeMongoConnectionName(name);

        return this._connections.get(normalized)?._state ?? "idle";
    }

    private bindConnectionEvents(entry: MongoConnectionEntry) {
        const connection =
            entry._connection as any;

        if (!connection?.on) {
            return;
        }

        connection.on("connected", () => {
            entry._state = "connected";
            entry._last_error = undefined;
        });

        connection.on("reconnected", () => {
            entry._state = "connected";
            entry._last_error = undefined;
        });

        connection.on("disconnected", () => {
            if (entry._state !== "failed") {
                entry._state = "disconnected";
            }
        });

        connection.on("error", (err: any) => {
            entry._state = "failed";
            entry._last_error = err;
            _xlog.error(
                `Mongo connection '${entry._name}' error: ${err?.message ?? err}`
            );
        });
    }

    async connect(name?: string): Promise<Connection> {
        const normalized =
            normalizeMongoConnectionName(name);

        const existing =
            this._connections.get(normalized);

        if (existing?._connection) {
            return existing._connection;
        }

        if (existing?._promise) {
            return existing._promise;
        }

        const config =
            this.resolveConnectionConfig(normalized);

        const entry: MongoConnectionEntry = {
            _name:
                normalized,
            _config:
                config,
            _state:
                "connecting"
        };

        this._connections.set(
            normalized,
            entry
        );

        const options = {
            ...(config._options ?? {}),
            ...(config._db_name
                ? {
                    dbName:
                        config._db_name
                }
                : {})
        };

        const promise =
            Promise.resolve()
                .then(() =>
                    this._create_connection(
                        String(config._uri),
                        options
                    )
                )
                .then(async (connection: any) => {
                    entry._connection =
                        connection as Connection;
                    this.bindConnectionEvents(entry);

                    if (typeof connection?.asPromise === "function") {
                        await connection.asPromise();
                    }

                    entry._state =
                        "connected";
                    entry._last_error =
                        undefined;
                    entry._promise =
                        undefined;

                    return connection as Connection;
                })
                .catch(async (err: any) => {
                    entry._state =
                        "failed";
                    entry._last_error =
                        err;
                    entry._promise =
                        undefined;

                    try {
                        await entry._connection?.close?.();
                    } catch {
                        // Ignore close errors while reporting the original failure.
                    }

                    this._connections.delete(normalized);

                    throw new XError(
                        "E_MONGO_CONNECTION_FAILED",
                        `Mongo connection '${normalized}' failed: ${err?.message ?? err}`,
                        {
                            _meta: {
                                _name:
                                    normalized
                            },
                            _cause:
                                err
                        } as any
                    );
                });

        entry._promise =
            promise;

        return promise;
    }

    async disconnect(name?: string): Promise<boolean> {
        const normalized =
            normalizeMongoConnectionName(name);

        const entry =
            this._connections.get(normalized);

        if (!entry) {
            return false;
        }

        try {
            await entry._promise;
        } catch {
            // Failed connects are already cleaned up by connect().
        }

        await entry._connection?.close?.();

        this._connections.delete(normalized);

        return true;
    }

    async disconnectAll(): Promise<void> {
        const names =
            Array.from(this._connections.keys());

        await Promise.all(
            names.map((name) =>
                this.disconnect(name)
            )
        );
    }
}

export const MongoConnections =
    new MongoConnectionManager();

export default MongoConnections;
