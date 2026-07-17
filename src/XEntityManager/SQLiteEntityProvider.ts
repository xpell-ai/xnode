import fs from "fs";
import path from "path";
import { createHash } from "crypto";

import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { XError } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import XDB from "../XDB/XDB.js";
import type {
    EntityAggregationRequest,
    EntityAggregationResult,
    EntityProvider,
    EntityProviderCapability,
    EntityProviderCapabilityName,
    EntityProviderDisposeResult,
    EntityProviderFindOptions,
    EntityPhysicalIdentity,
    EntityProviderType
} from "./EntityProvider.js";
import {
    aggregateEntityRecords,
    unsupportedEntityProviderCapabilityError
} from "./EntityProvider.js";

const BCRYPT_SALT_OR_ROUNDS = 10;
const BCRYPT_HASH_PREFIXES = ["$2a$", "$2b$", "$2y$"];
const SQLITE_HASH_FILTER_MAX_RECORDS = 25;

type SQLiteIndexedField = {
    _field_name: string;
    _column_name: string;
    _sql_type: string;
    _unique: boolean;
    _required: boolean;
};

export type SQLiteEntityProviderOptions = {
    _definition: any;
    _physical_identity: EntityPhysicalIdentity;
};

export class SQLiteEntityProvider implements EntityProvider {
    readonly _provider: EntityProviderType = "sqlite";
    readonly _provider_type = "sqlite-entity";
    readonly _physical_entity_name: string;

    private _definition: any;
    private readonly _physical_identity: EntityPhysicalIdentity;
    private _schema: Record<string, any> = {};
    private _db!: Database.Database;
    private _db_path: string;
    private _table_name: string;
    private _indexed_fields: SQLiteIndexedField[] = [];
    private _loaded_rows = 0;

    constructor(opts: SQLiteEntityProviderOptions) {
        this._definition = opts._definition;
        this._physical_identity = opts._physical_identity;
        this._physical_entity_name =
            this._physical_identity._physical_entity_name;
        this._db_path =
            this.resolveDbPath(opts._definition);
        this._table_name =
            this.resolveTableName();
    }

    async init() {
        this.open();
        await this.syncSchema(this._definition);
    }

    private open() {
        if (this._db?.open) {
            return;
        }

        fs.mkdirSync(path.dirname(this._db_path), {
            recursive: true
        });

        this._db = new Database(this._db_path);
        this._db.pragma("foreign_keys = ON");
        this._db.pragma("journal_mode = WAL");
        this._db.pragma("synchronous = NORMAL");
        this._db.pragma("busy_timeout = 5000");
        this.initProviderSchema();
    }

    private resolveDbPath(definition: any) {
        const configured =
            definition?._storage?._sqlite?._db_path ??
            definition?._storage?._db_path;

        if (typeof configured === "string" && configured.trim()) {
            return path.resolve(configured);
        }

        const work_folder =
            (XDB as any)?._initOpts?.workFolder ??
            process.cwd();

        return path.join(
            work_folder,
            "xdb",
            "entity-provider.sqlite"
        );
    }

    private resolveTableName() {
        const digest =
            createHash("sha256")
                .update(this._physical_identity._physical_identity)
                .digest("hex")
                .slice(0, 16);

        const suffix =
            this._physical_identity._physical_entity_name
                .replace(/[^A-Za-z0-9_]/g, "_")
                .slice(0, 40);

        return `xent_${digest}_${suffix}`;
    }

    private quoteIdentifier(identifier: string) {
        return `"${String(identifier).replace(/"/g, "\"\"")}"`;
    }

    private initProviderSchema() {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS entity_provider_meta (
                physical_entity_name TEXT PRIMARY KEY,
                logical_entity_id TEXT NOT NULL,
                physical_identity TEXT NOT NULL,
                provider TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                storage_scope TEXT NOT NULL,
                table_name TEXT NOT NULL,
                schema_json TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entity_provider_indexes (
                physical_entity_name TEXT NOT NULL,
                field_name TEXT NOT NULL,
                column_name TEXT NOT NULL,
                sql_type TEXT NOT NULL,
                is_unique INTEGER NOT NULL,
                is_required INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (physical_entity_name, field_name)
            );
        `);
    }

    async syncSchema(definition: any) {
        this._definition = definition;
        this._schema =
            this.normalizeRuntimeSchema(definition?._schema ?? {});
        this._indexed_fields =
            this.resolveIndexedFields();

        this.assertSupportedSchema();
        this.createRecordTable();
        this.ensureIndexColumns();
        this.ensureSqliteIndexes();
        this.saveSchemaMetadata();
    }

    private normalizeRuntimeSchema(schema: Record<string, any>) {
        const normalized =
            JSON.parse(JSON.stringify(schema ?? {}));

        if (!Object.prototype.hasOwnProperty.call(normalized, "_id")) {
            normalized._id = {
                _type: "ObjectId",
                _required: false,
                _index: {
                    _unique: true,
                    _primary: true
                },
                _immutable: true
            };
        }

        normalized._created_at = {
            _type: "Date",
            _required: false,
            _immutable: true
        };

        normalized._updated_at = {
            _type: "Date",
            _required: false
        };

        return normalized;
    }

    private fieldType(fieldName: string) {
        return String(this._schema[fieldName]?._type ?? "")
            .toLowerCase();
    }

    private sqliteTypeForField(fieldName: string) {
        const type =
            this.fieldType(fieldName);

        if (
            type === "string" ||
            type === "hash" ||
            type === "date" ||
            type === "objectid"
        ) {
            return "TEXT";
        }

        if (type === "number") {
            return "REAL";
        }

        if (type === "boolean" || type === "bool") {
            return "INTEGER";
        }

        throw this.providerError(
            "E_ENTITY_SQLITE_SCHEMA_UNSUPPORTED",
            `SQLite entity provider does not support indexed field type '${type}'`,
            {
                _field:
                    fieldName,
                _type:
                    type
            }
        );
    }

    private resolveColumnName(fieldName: string) {
        if (fieldName === "_id") {
            return "_id";
        }

        const digest =
            createHash("sha1")
                .update(fieldName)
                .digest("hex")
                .slice(0, 8);

        const suffix =
            fieldName
                .replace(/[^A-Za-z0-9_]/g, "_")
                .slice(0, 32);

        return `f_${digest}_${suffix}`;
    }

    private resolveIndexedFields(): SQLiteIndexedField[] {
        const fields: SQLiteIndexedField[] = [];

        for (const fieldName of Object.keys(this._schema)) {
            const field =
                this._schema[fieldName];

            if (
                fieldName !== "_id" &&
                !field?._index
            ) {
                continue;
            }

            const index_schema =
                typeof field?._index === "object"
                    ? field._index
                    : {};

            fields.push({
                _field_name:
                    fieldName,
                _column_name:
                    this.resolveColumnName(fieldName),
                _sql_type:
                    this.sqliteTypeForField(fieldName),
                _unique:
                    fieldName === "_id" ||
                    index_schema?._unique === true,
                _required:
                    fieldName === "_id" ||
                    field?._required === true
            });
        }

        return fields;
    }

    private assertSupportedSchema() {
        const supported =
            new Set([
                "string",
                "number",
                "boolean",
                "bool",
                "date",
                "hash",
                "objectid",
                "array",
                "object"
            ]);

        for (const [fieldName, field] of Object.entries(this._schema)) {
            const type =
                String((field as any)?._type ?? "")
                    .toLowerCase();

            if (!supported.has(type)) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_SCHEMA_UNSUPPORTED",
                    `SQLite entity provider does not support field type '${type}'`,
                    {
                        _field:
                            fieldName,
                        _type:
                            type
                    }
                );
            }

            if (
                (type === "array" || type === "object") &&
                (field as any)?._index
            ) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_SCHEMA_UNSUPPORTED",
                    `SQLite entity provider does not support indexed field type '${type}'`,
                    {
                        _field:
                            fieldName,
                        _type:
                            type
                    }
                );
            }
        }
    }

    private createRecordTable() {
        const column_defs =
            this._indexed_fields
                .filter((field) => field._field_name !== "_id")
                .map((field) => {
                    const not_null =
                        field._required
                            ? " NOT NULL"
                            : "";

                    return `${this.quoteIdentifier(field._column_name)} ${field._sql_type}${not_null}`;
                });

        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.quoteIdentifier(this._table_name)} (
                _id TEXT PRIMARY KEY NOT NULL,
                _created_at TEXT NOT NULL,
                _updated_at TEXT NOT NULL,
                _json TEXT NOT NULL
                ${column_defs.length > 0 ? `,\n${column_defs.join(",\n")}` : ""}
            );
        `);
    }

    private getTableColumns() {
        const rows =
            this._db
                .prepare(`PRAGMA table_info(${this.quoteIdentifier(this._table_name)})`)
                .all() as Array<{ name: string }>;

        return new Set(rows.map((row) => row.name));
    }

    private ensureIndexColumns() {
        const columns =
            this.getTableColumns();

        for (const field of this._indexed_fields) {
            if (
                field._field_name === "_id" ||
                columns.has(field._column_name)
            ) {
                continue;
            }

            this._db.exec(
                `ALTER TABLE ${this.quoteIdentifier(this._table_name)} ADD COLUMN ${this.quoteIdentifier(field._column_name)} ${field._sql_type}`
            );
        }
    }

    private ensureSqliteIndexes() {
        for (const field of this._indexed_fields) {
            if (field._field_name === "_id") {
                continue;
            }

            const index_name =
                `idx_${this._table_name}_${field._column_name}`;

            const unique =
                field._unique
                    ? "UNIQUE "
                    : "";

            const where =
                field._required
                    ? ""
                    : ` WHERE ${this.quoteIdentifier(field._column_name)} IS NOT NULL`;

            this._db.exec(
                `CREATE ${unique}INDEX IF NOT EXISTS ${this.quoteIdentifier(index_name)} ON ${this.quoteIdentifier(this._table_name)} (${this.quoteIdentifier(field._column_name)})${where}`
            );
        }
    }

    private saveSchemaMetadata() {
        const now =
            new Date().toISOString();

        const tx =
            this._db.transaction(() => {
                this._db.prepare(`
                    INSERT INTO entity_provider_meta (
                        physical_entity_name,
                        logical_entity_id,
                        physical_identity,
                        provider,
                        provider_type,
                        storage_scope,
                        table_name,
                        schema_json,
                        meta_json,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(physical_entity_name) DO UPDATE SET
                        logical_entity_id = excluded.logical_entity_id,
                        physical_identity = excluded.physical_identity,
                        provider = excluded.provider,
                        provider_type = excluded.provider_type,
                        storage_scope = excluded.storage_scope,
                        table_name = excluded.table_name,
                        schema_json = excluded.schema_json,
                        meta_json = excluded.meta_json,
                        updated_at = excluded.updated_at
                `).run(
                    this._physical_entity_name,
                    this._physical_identity._logical_entity_id,
                    this._physical_identity._physical_identity,
                    this._provider,
                    this._provider_type,
                    this._physical_identity._storage_scope,
                    this._table_name,
                    JSON.stringify(this._schema),
                    JSON.stringify(this._definition?._meta ?? {}),
                    now
                );

                this._db.prepare(
                    `DELETE FROM entity_provider_indexes WHERE physical_entity_name = ?`
                ).run(this._physical_entity_name);

                const insert_index =
                    this._db.prepare(`
                        INSERT INTO entity_provider_indexes (
                            physical_entity_name,
                            field_name,
                            column_name,
                            sql_type,
                            is_unique,
                            is_required,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);

                for (const field of this._indexed_fields) {
                    insert_index.run(
                        this._physical_entity_name,
                        field._field_name,
                        field._column_name,
                        field._sql_type,
                        field._unique ? 1 : 0,
                        field._required ? 1 : 0,
                        now
                    );
                }
            });

        tx();
    }

    private providerError(
        code: string,
        message: string,
        meta: Record<string, any> = {}
    ) {
        return new XError(
            code,
            message,
            {
                _meta: {
                    _provider:
                        this._provider,
                    _provider_type:
                        this._provider_type,
                    _physical_entity_name:
                        this._physical_entity_name,
                    _table_name:
                        this._table_name,
                    ...meta
                }
            }
        );
    }

    private isBcryptHash(value: any): boolean {
        return (
            typeof value === "string" &&
            BCRYPT_HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
        );
    }

    private async hashFieldValue(value: any): Promise<string> {
        const salt =
            await bcrypt.genSalt(BCRYPT_SALT_OR_ROUNDS);

        return await bcrypt.hash(
            String(value ?? ""),
            salt
        );
    }

    private async prepareHashFieldValue(value: any): Promise<string> {
        if (this.isBcryptHash(value)) {
            return value;
        }

        return await this.hashFieldValue(value);
    }

    private normalizeFieldValue(
        fieldName: string,
        value: any
    ) {
        const type =
            this.fieldType(fieldName);

        if (value === null) {
            return null;
        }

        if (type === "string" || type === "objectid") {
            let string_value =
                String(value ?? "");

            const field =
                this._schema[fieldName];

            if (
                field?._max_length &&
                string_value.length > field._max_length
            ) {
                string_value =
                    string_value.substring(0, field._max_length);
            }

            if (
                field?._min_length &&
                string_value.length < field._min_length
            ) {
                throw new Error(`field ${fieldName} too short`);
            }

            if (
                field?._enum &&
                !field._enum.includes(string_value)
            ) {
                throw new Error(`field ${fieldName} not in enum`);
            }

            if (field?._pattern) {
                const re =
                    new RegExp(field._pattern);

                if (!re.test(string_value)) {
                    throw new Error(`field ${fieldName} pattern mismatch`);
                }
            }

            return string_value;
        }

        if (type === "number") {
            const numeric_value =
                Number(value);

            if (Number.isNaN(numeric_value)) {
                throw new Error(`field ${fieldName} is not a number`);
            }

            const field =
                this._schema[fieldName];

            if (
                field?._min != null &&
                numeric_value < field._min
            ) {
                throw new Error(`field ${fieldName} below min`);
            }

            if (
                field?._max != null &&
                numeric_value > field._max
            ) {
                throw new Error(`field ${fieldName} above max`);
            }

            if (
                field?._enum &&
                !field._enum.includes(numeric_value)
            ) {
                throw new Error(`field ${fieldName} not in enum`);
            }

            return numeric_value;
        }

        if (type === "boolean" || type === "bool") {
            return value === true || value === "true" || value === 1;
        }

        if (type === "date") {
            return new Date(value);
        }

        if (type === "array") {
            if (!Array.isArray(value)) {
                throw new Error(`field ${fieldName} is not an array`);
            }

            return JSON.parse(JSON.stringify(value));
        }

        if (type === "object") {
            if (
                !value ||
                typeof value !== "object" ||
                Array.isArray(value)
            ) {
                throw new Error(`field ${fieldName} is not an object`);
            }

            return JSON.parse(JSON.stringify(value));
        }

        return value;
    }

    private async prepareFields(input: Record<string, any>): Promise<Record<string, any>> {
        const out: Record<string, any> = {};
        const errors: string[] = [];

        for (const key of Object.keys(this._schema)) {
            const field =
                this._schema[key];

            const type =
                this.fieldType(key);

            if (!Object.prototype.hasOwnProperty.call(input, key)) {
                if (Object.prototype.hasOwnProperty.call(field, "_default")) {
                    out[key] = field._default;
                } else if (field?._required) {
                    errors.push(`missing required field: ${key}`);
                }

                continue;
            }

            try {
                if (input[key] === null) {
                    if (field?._required) {
                        errors.push(`missing required field: ${key}`);
                    } else {
                        out[key] = null;
                    }

                    continue;
                }

                if (type === "hash") {
                    out[key] =
                        await this.prepareHashFieldValue(input[key]);
                } else {
                    out[key] =
                        this.normalizeFieldValue(
                            key,
                            input[key]
                        );
                }
            } catch (err: any) {
                errors.push(err?.message ?? String(err));
            }
        }

        if (errors.length > 0) {
            throw new Error(errors.join("\n"));
        }

        return out;
    }

    private serializeRecordValue(fieldName: string, value: any) {
        const type =
            this.fieldType(fieldName);

        if (value === undefined || value === null) {
            return value;
        }

        if (type === "date") {
            return value instanceof Date
                ? value.toISOString()
                : new Date(value).toISOString();
        }

        if (type === "boolean" || type === "bool") {
            return value === true;
        }

        if (type === "array" || type === "object") {
            return JSON.parse(JSON.stringify(value));
        }

        return value;
    }

    private sqliteValue(field: SQLiteIndexedField, record: any) {
        const value =
            record[field._field_name];

        if (value === undefined || value === null) {
            return null;
        }

        const type =
            this.fieldType(field._field_name);

        if (type === "date") {
            return value instanceof Date
                ? value.toISOString()
                : new Date(value).toISOString();
        }

        if (type === "boolean" || type === "bool") {
            return value === true ? 1 : 0;
        }

        return value;
    }

    private recordFromRow(row: any) {
        if (!row) {
            return null;
        }

        this._loaded_rows += 1;

        return JSON.parse(row._json);
    }

    async add(data: any) {
        const fixedData =
            await this.prepareFields(data);

        if (!fixedData._id) {
            fixedData._id = _xu.guid();
        }

        const now =
            new Date();

        const entityData: Record<string, any> = {
            _id:
                fixedData._id,
            _created_at:
                now.toISOString(),
            _updated_at:
                now.toISOString()
        };

        for (const fieldName of Object.keys(this._schema)) {
            const value =
                fixedData[fieldName];

            if (value !== undefined) {
                entityData[fieldName] =
                    this.serializeRecordValue(
                        fieldName,
                        value
                    );
            }
        }

        const indexed =
            this._indexed_fields
                .filter((field) => field._field_name !== "_id");

        const columns = [
            "_id",
            "_created_at",
            "_updated_at",
            "_json",
            ...indexed.map((field) => field._column_name)
        ];

        const values = [
            entityData._id,
            entityData._created_at,
            entityData._updated_at,
            JSON.stringify(entityData),
            ...indexed.map((field) => this.sqliteValue(field, entityData))
        ];

        const placeholders =
            columns.map(() => "?").join(", ");

        const sql =
            `INSERT INTO ${this.quoteIdentifier(this._table_name)} (${columns.map((column) => this.quoteIdentifier(column)).join(", ")}) VALUES (${placeholders})`;

        const tx =
            this._db.transaction(() => {
                this._db.prepare(sql).run(...values);
            });

        try {
            tx();
        } catch (err: any) {
            if (String(err?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_CONSTRAINT",
                    err?.message ?? "SQLite constraint failed",
                    {
                        _sqlite_code:
                            err?.code
                    }
                );
            }

            throw err;
        }

        return JSON.parse(JSON.stringify(entityData));
    }

    async get(id: string) {
        const row =
            this._db
                .prepare(`SELECT _json FROM ${this.quoteIdentifier(this._table_name)} WHERE _id = ?`)
                .get(id);

        return this.recordFromRow(row);
    }

    private indexedFieldByName(fieldName: string) {
        return this._indexed_fields.find(
            (field) => field._field_name === fieldName
        );
    }

    private escapeLikeValue(value: string) {
        return value
            .replace(/\\/g, "\\\\")
            .replace(/%/g, "\\%")
            .replace(/_/g, "\\_");
    }

    private addComparisonClause(
        clauses: string[],
        values: any[],
        field: SQLiteIndexedField,
        operator: string,
        rawValue: any
    ) {
        const column =
            this.quoteIdentifier(field._column_name);

        if (
            rawValue === null &&
            (
                operator === "_eq" ||
                operator === "_equals" ||
                operator === "="
            )
        ) {
            clauses.push(`${column} IS NULL`);
            return;
        }

        if (rawValue === null) {
            throw this.providerError(
                "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                "SQLite entity provider only supports null with equality filters",
                {
                    _field:
                        field._field_name,
                    _operator:
                        operator
                }
            );
        }

        const value =
            this.sqliteFilterValue(
                field,
                rawValue
            );

        if (
            operator === "_eq" ||
            operator === "_equals" ||
            operator === "="
        ) {
            clauses.push(`${column} = ?`);
            values.push(value);
            return;
        }

        if (
            operator === "_gt" ||
            operator === ">"
        ) {
            clauses.push(`${column} > ?`);
            values.push(value);
            return;
        }

        if (
            operator === "_gte" ||
            operator === ">="
        ) {
            clauses.push(`${column} >= ?`);
            values.push(value);
            return;
        }

        if (
            operator === "_lt" ||
            operator === "<"
        ) {
            clauses.push(`${column} < ?`);
            values.push(value);
            return;
        }

        if (
            operator === "_lte" ||
            operator === "<="
        ) {
            clauses.push(`${column} <= ?`);
            values.push(value);
            return;
        }

        if (operator === "_contains") {
            const type =
                this.fieldType(field._field_name);

            if (
                field._sql_type !== "TEXT" ||
                type === "hash"
            ) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                    "_contains is supported only for indexed text fields",
                    {
                        _field:
                            field._field_name,
                        _operator:
                            operator
                    }
                );
            }

            clauses.push(`${column} LIKE ? ESCAPE '\\'`);
            values.push(`%${this.escapeLikeValue(String(rawValue))}%`);
            return;
        }

        if (
            operator === "_starts_with" ||
            operator === "_starts"
        ) {
            if (field._sql_type !== "TEXT") {
                throw this.providerError(
                    "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                    `${operator} is supported only for indexed text fields`,
                    {
                        _field:
                            field._field_name,
                        _operator:
                            operator
                    }
                );
            }

            clauses.push(`${column} LIKE ? ESCAPE '\\'`);
            values.push(`${this.escapeLikeValue(String(rawValue))}%`);
            return;
        }

        if (
            operator === "_ends_with" ||
            operator === "_ends"
        ) {
            if (field._sql_type !== "TEXT") {
                throw this.providerError(
                    "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                    `${operator} is supported only for indexed text fields`,
                    {
                        _field:
                            field._field_name,
                        _operator:
                            operator
                    }
                );
            }

            clauses.push(`${column} LIKE ? ESCAPE '\\'`);
            values.push(`%${this.escapeLikeValue(String(rawValue))}`);
            return;
        }

        throw this.providerError(
            "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
            `SQLite entity provider does not support query operator '${operator}'`,
            {
                _field:
                    field._field_name,
                _operator:
                    operator
            }
        );
    }

    private buildWhere(query: any) {
        const keys =
            Object.keys(query || {});

        if (keys.length === 0) {
            return {
                _where:
                    "",
                _values:
                    []
            };
        }

        const clauses: string[] = [];
        const values: any[] = [];

        for (const key of keys) {
            const field =
                this.indexedFieldByName(key);

            if (!field) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                    `SQLite entity provider can only filter by _id or indexed fields`,
                    {
                        _field:
                            key
                    }
                );
            }

            const queryValue =
                query[key];

            if (
                queryValue &&
                typeof queryValue === "object" &&
                !Array.isArray(queryValue)
            ) {
                const operators =
                    Object.keys(queryValue);

                if (operators.length !== 1) {
                    throw this.providerError(
                        "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                        "SQLite entity provider supports one operator per indexed field in this phase",
                        {
                            _field:
                                key
                        }
                    );
                }

                const operator =
                    operators[0];

                if (operator === "_in") {
                    if (!Array.isArray(queryValue[operator])) {
                        throw this.providerError(
                            "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                            "_in requires an array",
                            {
                                _field:
                                    key
                            }
                        );
                    }

                    if (queryValue[operator].length === 0) {
                        clauses.push("1 = 0");
                        continue;
                    }

                    const in_values =
                        queryValue[operator].map((value: any) =>
                            this.sqliteFilterValue(field, value)
                        );

                    clauses.push(
                        `${this.quoteIdentifier(field._column_name)} IN (${in_values.map(() => "?").join(", ")})`
                    );
                    values.push(...in_values);
                    continue;
                }

                this.addComparisonClause(
                    clauses,
                    values,
                    field,
                    operator,
                    queryValue[operator]
                );
                continue;
            }

            this.addComparisonClause(
                clauses,
                values,
                field,
                "=",
                queryValue
            );
        }

        return {
            _where:
                ` WHERE ${clauses.join(" AND ")}`,
            _values:
                values
        };
    }

    private sqliteFilterValue(field: SQLiteIndexedField, value: any) {
        const type =
            this.fieldType(field._field_name);

        if (type === "boolean" || type === "bool") {
            return value === true || value === "true" || value === 1
                ? 1
                : 0;
        }

        if (type === "date") {
            return value instanceof Date
                ? value.toISOString()
                : new Date(value).toISOString();
        }

        if (type === "number") {
            return Number(value);
        }

        return String(value ?? "");
    }

    private resolveSortColumn(fieldName: string) {
        if (
            fieldName === "_created_at" ||
            fieldName === "_updated_at"
        ) {
            return fieldName;
        }

        const field =
            this.indexedFieldByName(fieldName);

        if (!field) {
            throw this.providerError(
                "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                "SQLite entity provider can only sort by _created_at, _updated_at, _id, or indexed fields",
                {
                    _field:
                        fieldName
                }
            );
        }

        return field._column_name;
    }

    private buildOrderBy(options: EntityProviderFindOptions = {}) {
        const sortInput =
            options._sort;

        if (
            sortInput &&
            typeof sortInput === "object"
        ) {
            const fieldName =
                String(sortInput._sort_by ?? "")
                    .trim();

            if (!fieldName) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_QUERY_UNSUPPORTED",
                    "SQLite entity provider sort requires _sort_by"
                );
            }

            const order =
                String(sortInput._sort_order ?? "asc")
                    .toLowerCase() === "desc"
                    ? "DESC"
                    : "ASC";

            return ` ORDER BY ${this.quoteIdentifier(this.resolveSortColumn(fieldName))} ${order}`;
        }

        return ` ORDER BY ${this.quoteIdentifier("_created_at")} ${options._reverse_order ? "DESC" : "ASC"}`;
    }

    async find(query: any = {}, options: EntityProviderFindOptions = {}) {
        const where =
            this.buildWhere(query);

        const skip =
            options._skip ?? 0;

        const limit =
            options._limit ?? 100000;

        const count =
            this._db
                .prepare(`SELECT COUNT(*) as count FROM ${this.quoteIdentifier(this._table_name)}${where._where}`)
                .get(...where._values) as any;

        const order_by =
            this.buildOrderBy(options);

        const sql =
            `SELECT _json FROM ${this.quoteIdentifier(this._table_name)}${where._where}${order_by} LIMIT ? OFFSET ?`;

        const rows =
            this._db
                .prepare(sql)
                .all(...where._values, limit, skip) as any[];

        const data =
            rows.map((row) => this.recordFromRow(row));

        return {
            _meta: {
                _name:
                    this._physical_identity._logical_entity_id,
                _skip:
                    skip,
                _limit:
                    limit,
                _total_records:
                    Number(count?.count ?? 0),
                _records:
                    data.length,
                ...(options._include_schema
                    ? {
                        _schema:
                            this._schema
                    }
                    : {})
            },
            _data:
                data,
            _vectors_ids:
                {},
            _matrices:
                {}
        };
    }

    async count(query: any = {}) {
        const where =
            this.buildWhere(query);

        const row =
            this._db
                .prepare(`SELECT COUNT(*) as count FROM ${this.quoteIdentifier(this._table_name)}${where._where}`)
                .get(...where._values) as any;

        return Number(row?.count ?? 0);
    }

    private checkUpdateField(
        fieldName: string,
        updateValue: any
    ) {
        const field =
            this._schema[fieldName];

        if (!field) {
            throw new Error(`Field ${fieldName} not in schema`);
        }

        if (field._immutable) {
            throw new Error(`Field ${fieldName} is immutable`);
        }

        if (
            updateValue === undefined ||
            updateValue === null
        ) {
            throw new Error(`Field ${fieldName} value is undefined/null`);
        }

        if (
            field._enum &&
            field._enum.length > 0 &&
            !field._enum.includes(updateValue)
        ) {
            throw new Error(`Field ${fieldName} value not in enum`);
        }
    }

    private async prepareUpdates(updates: any) {
        if (
            !updates ||
            typeof updates !== "object" ||
            Array.isArray(updates) ||
            Object.keys(updates).length === 0
        ) {
            throw new Error("Empty updates");
        }

        const prepared: Record<string, any> = {};

        for (const key of Object.keys(updates)) {
            this.checkUpdateField(key, updates[key]);

            const type =
                this.fieldType(key);

            prepared[key] =
                type === "hash"
                    ? await this.prepareHashFieldValue(updates[key])
                    : this.normalizeFieldValue(
                        key,
                        updates[key]
                    );
        }

        return prepared;
    }

    async update(filter: any, updates: any) {
        if (
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).length === 0
        ) {
            throw new Error("Empty filter");
        }

        const where =
            this.buildWhere(filter);

        const preparedUpdates =
            await this.prepareUpdates(updates);

        const update_indexed_fields =
            this._indexed_fields
                .filter((field) =>
                    field._field_name !== "_id" &&
                    Object.prototype.hasOwnProperty.call(preparedUpdates, field._field_name)
                );

        const select_sql =
            `SELECT _id, _json FROM ${this.quoteIdentifier(this._table_name)}${where._where}`;

        const set_columns = [
            `${this.quoteIdentifier("_updated_at")} = ?`,
            `${this.quoteIdentifier("_json")} = ?`,
            ...update_indexed_fields.map((field) =>
                `${this.quoteIdentifier(field._column_name)} = ?`
            )
        ];

        const update_sql =
            `UPDATE ${this.quoteIdentifier(this._table_name)} SET ${set_columns.join(", ")} WHERE _id = ?`;

        const tx =
            this._db.transaction(() => {
                const rows =
                    this._db
                        .prepare(select_sql)
                        .all(...where._values) as any[];

                const update_stmt =
                    this._db.prepare(update_sql);

                let updated =
                    0;

                for (const row of rows) {
                    const record =
                        JSON.parse(row._json);

                    const updated_at =
                        new Date().toISOString();

                    const nextRecord = {
                        ...record,
                        ...preparedUpdates,
                        _updated_at:
                            updated_at
                    };

                    const values = [
                        updated_at,
                        JSON.stringify(nextRecord),
                        ...update_indexed_fields.map((field) =>
                            this.sqliteValue(
                                field,
                                nextRecord
                            )
                        ),
                        row._id
                    ];

                    const result =
                        update_stmt.run(...values);

                    updated += result.changes;
                }

                return updated;
            });

        try {
            return {
                _updated:
                    tx()
            };
        } catch (err: any) {
            if (String(err?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
                throw this.providerError(
                    "E_ENTITY_SQLITE_CONSTRAINT",
                    err?.message ?? "SQLite constraint failed",
                    {
                        _sqlite_code:
                            err?.code
                    }
                );
            }

            throw err;
        }
    }

    async delete(filter: any) {
        if (
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).length === 0
        ) {
            throw new Error("Empty filter");
        }

        const where =
            this.buildWhere(filter);

        const tx =
            this._db.transaction(() =>
                this._db
                    .prepare(`DELETE FROM ${this.quoteIdentifier(this._table_name)}${where._where}`)
                    .run(...where._values)
            );

        const result =
            tx() as Database.RunResult;

        return {
            _deleted:
                result.changes
        };
    }

    getSchema() {
        return this._definition;
    }

    getRecords(result: any): any[] {
        return Array.isArray(result?._data)
            ? result._data
            : [];
    }

    getRecordCount(result: any): number {
        return this.getRecords(result).length;
    }

    async applyHashFilter(result: any, hash_filter: any) {
        if (
            hash_filter === undefined ||
            hash_filter === null
        ) {
            return result;
        }

        this.assertCapability("hash-verification");

        if (
            typeof hash_filter !== "object" ||
            Array.isArray(hash_filter)
        ) {
            throw new Error("_hash_filter must be an object");
        }

        const entries =
            Object.entries(hash_filter);

        if (entries.length === 0) {
            return result;
        }

        const records =
            this.getRecords(result);

        if (records.length > SQLITE_HASH_FILTER_MAX_RECORDS) {
            throw this.providerError(
                "E_ENTITY_SQLITE_HASH_FILTER_UNBOUNDED",
                "SQLite Hash field verification requires a bounded result set",
                {
                    _records:
                        records.length,
                    _max_records:
                        SQLITE_HASH_FILTER_MAX_RECORDS
                }
            );
        }

        const filtered_data = [];

        for (const record of records) {
            let matches =
                true;

            for (const [fieldName, plainText] of entries) {
                if (typeof plainText !== "string") {
                    throw new Error(`_hash_filter.${fieldName} must be a string`);
                }

                const field =
                    this._schema?.[fieldName];

                if (!field) {
                    throw new Error(`Field ${fieldName} not in schema`);
                }

                if (field._type !== "Hash") {
                    throw new Error(`Field ${fieldName} is not a Hash field`);
                }

                const hash =
                    record?.[fieldName];

                if (
                    typeof hash !== "string" ||
                    !await bcrypt.compare(plainText, hash)
                ) {
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

    async aggregate(
        request: EntityAggregationRequest
    ): Promise<EntityAggregationResult> {
        this.assertCapability("aggregation");

        return aggregateEntityRecords(request);
    }

    getCapabilities(): EntityProviderCapability[] {
        return [
            {
                _name: "hash-verification",
                _supported: true,
                _description: "Verify SQLite-backed Hash fields against plain text values after SQL filtering; verification is bounded to avoid unbounded plaintext scans."
            },
            {
                _name: "aggregation",
                _supported: true,
                _description: "Aggregate record arrays using EntityManager-compatible operators.",
                _operators: ["sum"]
            },
            {
                _name: "transactions",
                _supported: true,
                _description: "Use SQLite transactions for writes."
            },
            {
                _name: "persistent-storage",
                _supported: true,
                _description: "Persist records as SQLite rows in provider-owned tables."
            },
            {
                _name: "query-operators",
                _supported: true,
                _description: "Supports SQL-backed filters and sorting on _id, runtime timestamp fields, and indexed fields.",
                _operators: [
                    "=",
                    "_eq",
                    "_equals",
                    ">",
                    ">=",
                    "<",
                    "<=",
                    "_gt",
                    "_gte",
                    "_lt",
                    "_lte",
                    "_in",
                    "_contains",
                    "_starts_with",
                    "_starts",
                    "_ends_with",
                    "_ends"
                ]
            },
            {
                _name: "runtime-entity-handle",
                _supported: true,
                _description: "Expose the SQLite provider instance for internal diagnostics."
            },
            {
                _name: "physical-unregister",
                _supported: false,
                _reason: "SQLite provider unregister closes the provider and preserves record tables."
            }
        ];
    }

    getCapability(
        name: EntityProviderCapabilityName
    ): EntityProviderCapability {
        return this.getCapabilities().find(
            (capability) => capability._name === name
        ) ?? {
            _name:
                name,
            _supported:
                false,
            _reason:
                "Unknown entity provider capability."
        };
    }

    assertCapability(
        name: EntityProviderCapabilityName
    ): EntityProviderCapability {
        const capability =
            this.getCapability(name);

        if (!capability._supported) {
            throw unsupportedEntityProviderCapabilityError(
                this,
                name
            );
        }

        return capability;
    }

    getPhysicalIdentity(): EntityPhysicalIdentity {
        return {
            ...this._physical_identity,
            _logical_entity_id:
                String(this._physical_identity._logical_entity_id ?? ""),
            _physical_entity_name:
                this._physical_entity_name,
            _provider:
                this._provider,
            _provider_type:
                this._provider_type
        };
    }

    getRuntimeEntityHandle() {
        this.assertCapability("runtime-entity-handle");

        return this;
    }

    getDebugStats() {
        return {
            _provider:
                this._provider,
            _db_path:
                this._db_path,
            _table_name:
                this._table_name,
            _loaded_rows:
                this._loaded_rows
        };
    }

    async dispose(): Promise<EntityProviderDisposeResult> {
        if (this._db?.open) {
            this._db.close();
        }

        return {
            _disposed: true,
            _physical_unregistered: false,
            _xdb_unregistered: false
        };
    }
}
