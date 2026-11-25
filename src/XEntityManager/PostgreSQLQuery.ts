import type { EntityProviderFindOptions } from "./EntityProvider.js";
import { filterValue, pgError, quote, type PGLayout } from "./PostgreSQLValues.js";

export const PG_OPERATORS = ["=", "_eq", "_equals", ">", ">=", "<", "<=", "_gt", "_gte", "_lt", "_lte", "_in"];
const SQL_OP: Record<string, string> = { "=": "=", _eq: "=", _equals: "=", ">": ">", _gt: ">", ">=": ">=", _gte: ">=", "<": "<", _lt: "<", "<=": "<=", _lte: "<=" };

export function whereSQL(layout: PGLayout, query: any = {}, offset = 0) {
    if (!query || typeof query !== "object" || Array.isArray(query)) throw pgError("QUERY_UNSUPPORTED");
    const clauses: string[] = [], values: any[] = [];
    const parameter = (value: any) => { values.push(value); return `$${offset + values.length}`; };
    for (const [name, input] of Object.entries(query)) {
        const f = layout._fields.find(f => f._name === name && f._indexed);
        if (!f) throw pgError("QUERY_UNSUPPORTED");
        const column = quote(f._column);
        let operator = "=", raw: any = input;
        if (input && typeof input === "object" && !(input instanceof Date)) {
            if (Array.isArray(input) || Object.keys(input).length !== 1) throw pgError("QUERY_UNSUPPORTED");
            [operator, raw] = Object.entries(input)[0];
        }
        if (operator === "_in") {
            if (!Array.isArray(raw)) throw pgError("QUERY_UNSUPPORTED");
            if (!raw.length) { clauses.push("FALSE"); continue; }
            const entries = raw.map(value => parameter(filterValue(layout, f, value)));
            clauses.push(`${column} IN (${entries.join(",")})`); continue;
        }
        const op = Object.hasOwn(SQL_OP, operator) ? SQL_OP[operator] : undefined;
        if (!op) throw pgError("QUERY_UNSUPPORTED");
        if (raw === null) {
            if (op !== "=") throw pgError("QUERY_UNSUPPORTED");
            clauses.push(`${column} IS NULL`); continue;
        }
        const parameterSQL = parameter(filterValue(layout, f, raw));
        clauses.push(f._sql === "BYTEA" && op === "="
            ? `(pg_catalog.sha256(${column}) = pg_catalog.sha256(${parameterSQL}::bytea) AND ${column} = ${parameterSQL})`
            : `${column} ${op} ${parameterSQL}`);
    }
    return { _sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", _values: values };
}

export function orderSQL(layout: PGLayout, options: EntityProviderFindOptions = {}) {
    const sort = options._sort;
    const name = sort ? String(sort._sort_by ?? "").trim() : "_created_at";
    const direction = sort ? String(sort._sort_order ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC"
        : options._reverse_order ? "DESC" : "ASC";
    const f = layout._fields.find(f => f._name === name && f._indexed);
    const id = layout._fields.find(f => f._name === "_id")!;
    if (!f) throw pgError("QUERY_UNSUPPORTED");
    const order = (column: string) => `${quote(column)} ${direction} NULLS ${direction === "ASC" ? "FIRST" : "LAST"}`;
    return ` ORDER BY ${order(f._column)}${name === "_id" ? "" : `, ${order(id._column)}`}`;
}

export function pageOptions(options: EntityProviderFindOptions) {
    const skip = options._skip ?? 0, limit = options._limit ?? 100000;
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 0) throw pgError("QUERY_UNSUPPORTED");
    return { _skip: skip, _limit: limit };
}

export function exactCount(value: string) {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) throw pgError("COUNT_RANGE");
    return count;
}
