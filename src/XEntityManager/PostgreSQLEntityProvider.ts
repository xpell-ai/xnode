import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { aggregateEntityRecords, unsupportedEntityProviderCapabilityError, type EntityProvider, type EntityProviderCapability,
    type EntityProviderCapabilityName, type EntityProviderConstructionOptions, type EntityProviderFindOptions, type EntityAggregationRequest } from "./EntityProvider.js";
import { PostgreSQLRuntime, getPostgreSQLRuntime } from "./PostgreSQLRuntime.js";
import { verifyEntitySchema, assertPostgreSQLIdentity, verifyPostgreSQLFence } from "./PostgreSQLSchema.js";
import { localUnitError, type EntityLocalUnit } from "./EntityLocalUnit.js";
import type { LocalUnitExecution } from "./EntityLocalUnitBackend.js";
import { preparePostgreSQLUnit, executePostgreSQLUnit, type PostgreSQLUnitEntity } from "./PostgreSQLLocalUnit.js";
import { layoutFor, pgError, prepareRecord, projected, quote, sqliteStringKey, type PGLayout } from "./PostgreSQLValues.js";
import { exactCount, orderSQL, pageOptions, PG_OPERATORS, whereSQL } from "./PostgreSQLQuery.js";

export class PostgreSQLEntityProvider implements EntityProvider {
    readonly _provider = "postgresql" as const;
    readonly _provider_type = "postgresql-entity";
    readonly _physical_entity_name: string;
    #identity: EntityProviderConstructionOptions["_physical_identity"];
    #runtime: PostgreSQLRuntime;
    #layout: PGLayout;
    #initialized = false;
    #disposed = false;

    constructor(options: EntityProviderConstructionOptions) {
        assertPostgreSQLIdentity(options._definition, options._physical_identity);
        const runtime = getPostgreSQLRuntime(options._runtime_context?._postgresql);
        if (!(runtime instanceof PostgreSQLRuntime) || options._physical_identity._provider !== "postgresql"
            || runtime.resolveProvider(options._definition, options._physical_identity) !== "postgresql") throw pgError("CONFIG");
        this.#runtime = runtime;
        this.#identity = JSON.parse(JSON.stringify(options._physical_identity));
        this._physical_entity_name = this.#identity._physical_entity_name;
        this.#layout = layoutFor(options._definition, this.#identity._physical_identity);
    }

    #namespace = (name: string) => this.#runtime.namespace(this.#identity, name);
    async init() {
        this.#initialized = false;
        await this.#runtime.transaction(this.#identity, false, client => verifyEntitySchema(client, this.#namespace, this.#layout));
        this.#disposed = false; this.#initialized = true;
    }
    async syncSchema(definition: any) {
        const layout = layoutFor(definition, this.#identity._physical_identity);
        if (layout._definition_hash !== this.#layout._definition_hash || layout._layout_hash !== this.#layout._layout_hash) throw pgError("SCHEMA_MISMATCH");
        await this.init();
    }
    async #operation<T>(write: boolean, action: (client: PoolClient) => Promise<T>) {
        if (!this.#initialized || this.#disposed) throw pgError("UNAVAILABLE");
        return this.#runtime.transaction(this.#identity, write, async client => {
            await verifyEntitySchema(client, this.#namespace, this.#layout);
            if (write && this.#runtime.localUnitStore([this.#identity])._schema_version === 3) {
                // P2 has no production issuer. Ordinary CRUD must not bypass a required fence.
                const store = this.#runtime.localUnitStore([this.#identity]);
                await verifyPostgreSQLFence(client, this.#namespace, store._id);
            }
            return action(client);
        });
    }
    private static localUnitState(providers: ReadonlyMap<string, PostgreSQLEntityProvider>) {
        const list = [...providers.values()], first = list[0];
        if (!first || list.some(p => !p.#initialized || p.#disposed || p.#runtime !== first.#runtime || p.#identity._storage_scope !== "app")) throw localUnitError("E_ENTITY_LOCAL_UNIT_STORAGE");
        const store = first.#runtime.localUnitStore(list.map(p => p.#identity));
        const entities = new Map<string, PostgreSQLUnitEntity>([...providers].map(([name, p]) => [name, { _layout: p.#layout, _namespace: p.#namespace }]));
        return { first, store, entities };
    }
    /** Internal native bounded adapter. No SQL/client handle is returned. */
    static async verifyLocalUnit(providers: ReadonlyMap<string, PostgreSQLEntityProvider>, o: LocalUnitExecution) {
        const { store } = this.localUnitState(providers);
        await this.commitLocalUnit(providers, { _unit_id: randomUUID(),
            _records: [{ _entity: providers.keys().next().value!, _id: randomUUID() }] }, { ...o, _fault: undefined });
        return store;
    }
    static async commitLocalUnit(providers: ReadonlyMap<string, PostgreSQLEntityProvider>, unit: EntityLocalUnit, o: LocalUnitExecution) {
        // An opaque consumer slot is reserved; production issuance/lifecycle belongs to P3.
        if (o._owner_context !== undefined) throw localUnitError("E_ENTITY_LOCAL_UNIT_FENCED");
        const { first, store, entities } = this.localUnitState(providers);
        const revalidate = () => { o._revalidate(); this.localUnitState(providers); };
        const execution = { ...o, _revalidate: revalidate };
        const prepared = await preparePostgreSQLUnit(entities, unit, execution);
        revalidate(); o._fault?.("after_prepare");
        let finalize: (() => void) | undefined;
        return first.#runtime.transaction(first.#identity, true, async client => {
            const result = await executePostgreSQLUnit(client, entities, prepared, store, execution);
            finalize = result._finalize;
            return { _records: result._records, _changed: result._changed, _durability: result._durability, _ownership: result._ownership };
        }, () => { if (!finalize) throw localUnitError(); finalize(); });
    }
    #columns() { return ["_json", ...this.#layout._fields.map(f => f._column)]; }
    #values(record: any) { return [JSON.stringify(record), ...this.#layout._fields.map(f => projected(f, record[f._name]))]; }

    async add(input: any) {
        const record = await prepareRecord(this.#layout, input);
        return this.#operation(true, async client => {
            const columns = ["_row_key", ...this.#columns()], values = [randomUUID(), ...this.#values(record)];
            await client.query(`INSERT INTO ${this.#namespace(this.#layout._table)} (${columns.map(quote).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`, values);
            return record;
        });
    }
    async get(id: string) {
        const where = whereSQL(this.#layout, { _id: id });
        return this.#operation(false, async client => {
            const rows = (await client.query(`SELECT _json FROM ${this.#namespace(this.#layout._table)}${where._sql}`, where._values)).rows;
            if (rows.length > 1) throw pgError("CONSTRAINT");
            return rows.length ? JSON.parse(rows[0]._json) : null;
        });
    }
    async find(query: any = {}, options: EntityProviderFindOptions = {}) {
        const where = whereSQL(this.#layout, query), page = pageOptions(options), order = orderSQL(this.#layout, options);
        return this.#operation(false, async client => {
            const total = exactCount((await client.query(`SELECT count(*)::text AS total FROM ${this.#namespace(this.#layout._table)}${where._sql}`, where._values)).rows[0].total);
            const rows = (await client.query(`SELECT _json FROM ${this.#namespace(this.#layout._table)}${where._sql}${order} LIMIT $${where._values.length + 1} OFFSET $${where._values.length + 2}`, [...where._values, page._limit, page._skip])).rows;
            const data = rows.map(r => JSON.parse(r._json));
            return { _meta: { _name: this.#identity._logical_entity_id, _skip: page._skip, _limit: page._limit,
                _total_records: total, _records: data.length, ...(options._include_schema ? { _schema: JSON.parse(JSON.stringify(this.#layout._schema)) } : {}) },
                _data: data, _vectors_ids: {}, _matrices: {} };
        });
    }
    async count(query: any = {}) {
        const where = whereSQL(this.#layout, query);
        return this.#operation(false, async client => exactCount((await client.query(`SELECT count(*)::text AS total FROM ${this.#namespace(this.#layout._table)}${where._sql}`, where._values)).rows[0].total));
    }
    async update(filter: any, updates: any) {
        if (this.#layout._append_only) throw pgError("APPEND_ONLY");
        if (!filter || !Object.keys(filter).length) throw pgError("QUERY_UNSUPPORTED");
        const where = whereSQL(this.#layout, filter);
        // Hash work and input validation precede BEGIN. Existing Hash values are not rehashed.
        const prepared = await prepareRecord(this.#layout, updates, {});
        return this.#operation(true, async client => {
            const rows = (await client.query(`SELECT _row_key,_json FROM ${this.#namespace(this.#layout._table)}${where._sql}${orderSQL(this.#layout, { _sort: { _sort_by: "_id" } })} FOR UPDATE`, where._values)).rows;
            for (const row of rows) {
                const next = await prepareRecord(this.#layout, prepared, JSON.parse(row._json));
                const values = this.#values(next);
                await client.query(`UPDATE ${this.#namespace(this.#layout._table)} SET ${this.#columns().map((c, i) => `${quote(c)}=$${i + 1}`).join(",")} WHERE _row_key=$${values.length + 1}`, [...values, row._row_key]);
            }
            return { _updated: rows.length };
        });
    }
    async delete(filter: any) {
        if (this.#layout._append_only) throw pgError("APPEND_ONLY");
        if (!filter || !Object.keys(filter).length) throw pgError("QUERY_UNSUPPORTED");
        const where = whereSQL(this.#layout, filter);
        return this.#operation(true, async client => {
            const rows = (await client.query(`SELECT _row_key FROM ${this.#namespace(this.#layout._table)}${where._sql}${orderSQL(this.#layout, { _sort: { _sort_by: "_id" } })} FOR UPDATE`, where._values)).rows;
            for (const row of rows) await client.query(`DELETE FROM ${this.#namespace(this.#layout._table)} WHERE _row_key=$1`, [row._row_key]);
            return { _deleted: rows.length };
        });
    }
    getSchema() { return JSON.parse(JSON.stringify(this.#layout._definition)); }
    getRecords(result: any): any[] { return Array.isArray(result?._data) ? result._data : []; }
    getRecordCount(result: any) { return this.getRecords(result).length; }
    async applyHashFilter(result: any, filter: any) {
        if (filter == null) return result;
        if (typeof filter !== "object" || Array.isArray(filter)) throw pgError("VALUE");
        const entries = Object.entries(filter), records = this.getRecords(result);
        if (!entries.length) return result;
        if (records.length > 25) throw pgError("HASH_FILTER_UNBOUNDED");
        for (const [name, value] of entries) if (typeof value !== "string" || String(this.#layout._schema[name]?._type).toLowerCase() !== "hash") throw pgError("VALUE");
        const data = [];
        for (const record of records) {
            let matches = true;
            for (const [name, value] of entries) {
                try { if (typeof record[name] !== "string" || !await bcrypt.compare(value as string, record[name])) matches = false; }
                catch { throw pgError("VALUE"); }
            }
            if (matches) {
                const copy = { ...record };
                for (const f of this.#layout._fields) if (f._type === "hash") delete copy[f._name];
                data.push(copy);
            }
        }
        return { ...result, _data: data, ...(result?._meta ? { _meta: { ...result._meta, _records: data.length, _total_records: data.length } } : {}) };
    }
    async aggregate(request: EntityAggregationRequest) { return aggregateEntityRecords(request); }
    getCapabilities(): EntityProviderCapability[] {
        return (["hash-verification", "aggregation", "transactions", "operation-atomic-writes", "app-local-atomic-unit", "persistent-storage",
            "server-side-pagination", "exact-count", "unique-scalar-indexes", "query-operators", "runtime-entity-handle", "physical-unregister"] as EntityProviderCapabilityName[])
            .map(name => ({ _name: name, _supported: !["transactions", "runtime-entity-handle", "physical-unregister"].includes(name),
                ...(name === "query-operators" ? { _operators: [...PG_OPERATORS] } : name === "aggregation" ? { _operators: ["sum"] } : {}),
                _description: "Portable PostgreSQL with negotiated bounded native atomic units; no public transaction or raw-client authority. Production ownership issuance is a P3 dependency." }));
    }
    getCapability(name: EntityProviderCapabilityName) { return this.getCapabilities().find(c => c._name === name) ?? { _name: name, _supported: false }; }
    assertCapability(name: EntityProviderCapabilityName) { const c = this.getCapability(name); if (!c._supported) throw unsupportedEntityProviderCapabilityError(this, name); return c; }
    getPhysicalIdentity() { return JSON.parse(JSON.stringify(this.#identity)); }
    getRuntimeEntityHandle(): never { throw unsupportedEntityProviderCapabilityError(this, "runtime-entity-handle"); }
    async dispose() { this.#disposed = true; this.#initialized = false; return { _disposed: true, _physical_unregistered: false }; }
}
