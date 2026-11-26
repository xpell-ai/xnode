import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { XError } from "@xpell/core";

export const pgError = (reason: string, meta: Record<string, unknown> = {}) =>
    new XError(`E_ENTITY_POSTGRESQL_${reason}`, "PostgreSQL entity operation rejected", { _meta: { _reason: reason, ...meta } });

export function canonicalJSON(value: any): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined || typeof value === "number" && !Number.isFinite(value)) throw pgError("VALUE");
    return encoded;
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const definitionDigest = (definition: any) => digest(canonicalJSON(definition));
export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Fixed WTF-8 codec. SQLite Node22 parity is qualified; Node24 lone-surrogate parity is explicitly deferred. */
export function sqliteStringKey(value: string): Buffer {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
        let cp = value.charCodeAt(i);
        const next = value.charCodeAt(i + 1);
        if (cp >= 0xd800 && cp <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + next - 0xdc00; i++;
        }
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | cp >> 6, 0x80 | cp & 63);
        else if (cp < 0x10000) bytes.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
        else bytes.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    }
    return Buffer.from(bytes);
}

export type PGField = { _name: string; _column: string; _type: string; _sql: string; _indexed: boolean; _unique: boolean; _required: boolean; _immutable: boolean };
export type PGLayout = { _definition: any; _schema: Record<string, any>; _fields: PGField[]; _table: string; _identity: string; _definition_hash: string; _layout_hash: string; _append_only: boolean };

export function layoutFor(definition: any, identity: string): PGLayout {
    definitionDigest(definition); // Reject executable/non-JSON schema values before cloning.
    const copy = JSON.parse(JSON.stringify(definition));
    if (copy._storage?._append_only !== undefined && typeof copy._storage._append_only !== "boolean") throw pgError("SCHEMA_UNSUPPORTED");
    if (!copy._schema || typeof copy._schema !== "object" || Array.isArray(copy._schema)) throw pgError("SCHEMA");
    const schema = copy._schema;
    schema._id ??= { _type: "ObjectId", _index: { _unique: true, _primary: true }, _immutable: true };
    schema._created_at = { _type: "Date", _immutable: true };
    schema._updated_at = { _type: "Date" };
    const fields: PGField[] = Object.keys(schema).map(name => {
        const f = schema[name], type = String(f?._type ?? "").toLowerCase();
        if (["_required", "_immutable"].some(key => f?.[key] !== undefined && typeof f[key] !== "boolean")
            || f?._index != null && typeof f._index !== "boolean" && (typeof f._index !== "object" || Array.isArray(f._index))
            || f?._index && typeof f._index === "object" && (Object.keys(f._index).some(key => !["_unique", "_primary"].includes(key))
                || ["_unique", "_primary"].some(key => f._index[key] !== undefined && typeof f._index[key] !== "boolean"))
            || name === "_id" && !["string", "objectid"].includes(type)) throw pgError("SCHEMA_UNSUPPORTED");
        const sql = ["string", "objectid", "hash", "date"].includes(type) ? "BYTEA"
            : type === "number" ? "DOUBLE PRECISION" : ["boolean", "bool"].includes(type) ? "BOOLEAN"
            : ["array", "object"].includes(type) ? "TEXT" : "";
        if (!sql || !name || name.includes("\0") || sql === "TEXT" && f._index) throw pgError("SCHEMA_UNSUPPORTED");
        return { _name: name, _column: `f_${digest(name).slice(0, 40)}`, _type: type, _sql: sql,
            _indexed: name === "_id" || name === "_created_at" || name === "_updated_at" || !!f._index,
            _unique: name === "_id" || f._index?._unique === true,
            _required: ["_id", "_created_at", "_updated_at"].includes(name) || f._required === true,
            _immutable: name === "_id" || name === "_created_at" || f._immutable === true };
    });
    if (new Set(fields.map(f => f._column)).size !== fields.length) throw pgError("SCHEMA_COLLISION");
    const result = { _definition: JSON.parse(JSON.stringify(definition)), _schema: schema, _fields: fields,
        _table: `ep_${digest(identity).slice(0, 48)}`, _identity: identity,
        _definition_hash: definitionDigest(definition), _layout_hash: "", _append_only: definition._storage?._append_only === true };
    result._layout_hash = digest(canonicalJSON({ _codec: "sqlite-wtf8-json-v1", _schema: schema, _fields: fields, _append_only: result._append_only }));
    return result;
}

export function normalizeScalar(layout: PGLayout, name: string, value: any): any {
    const field = layout._schema[name], type = String(field._type).toLowerCase();
    if (value === null) { if (field._required) throw pgError("REQUIRED"); return null; }
    let out: any;
    if (["string", "objectid"].includes(type)) {
        out = String(value ?? "");
        if (field._max_length && out.length > field._max_length) out = out.substring(0, field._max_length);
        if (field._min_length && out.length < field._min_length || field._pattern && !new RegExp(field._pattern).test(out)) throw pgError("VALUE");
    } else if (type === "number") {
        out = Number(value);
        if (!Number.isFinite(out) || field._min != null && out < field._min || field._max != null && out > field._max) throw pgError("VALUE");
    } else if (type === "date") {
        const date = new Date(value); if (!Number.isFinite(date.getTime())) throw pgError("VALUE"); out = date.toISOString();
    } else if (["boolean", "bool"].includes(type)) out = value === true || value === "true" || value === 1;
    else if (type === "hash") { if (typeof value !== "string") throw pgError("VALUE"); out = value; }
    else {
        if (type === "array" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value)) throw pgError("VALUE");
        out = JSON.parse(JSON.stringify(value));
    }
    if (field._enum && !field._enum.includes(out)) throw pgError("VALUE");
    return out;
}

export async function prepareRecord(layout: PGLayout, input: any, previous?: any) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw pgError("VALUE");
    const keys = Object.keys(input);
    if (previous && !keys.length) throw pgError("VALUE");
    for (const key of keys) {
        if (!Object.hasOwn(layout._schema, key)) throw pgError("UNKNOWN_FIELD");
        if (previous && (layout._fields.find(f => f._name === key)!._immutable || input[key] == null)) throw pgError("IMMUTABLE_OR_NULL");
    }
    const out: any = previous ? JSON.parse(JSON.stringify(previous)) : Object.create(null);
    for (const name of Object.keys(layout._schema)) {
        const field = layout._schema[name];
        const supplied = Object.hasOwn(input, name);
        if (!supplied && (previous || !Object.hasOwn(field, "_default"))) {
            if (!previous && field._required && !["_id", "_created_at", "_updated_at"].includes(name)) throw pgError("REQUIRED");
            continue;
        }
        let value = normalizeScalar(layout, name, supplied ? input[name] : field._default);
        if (String(field._type).toLowerCase() === "hash" && value !== null && !/^\$2[aby]\$/.test(value)) value = await bcrypt.hash(value, 10);
        out[name] = value;
    }
    if (!previous) {
        out._id ||= randomUUID();
        const now = new Date().toISOString(); out._created_at ??= now; out._updated_at ??= now;
    } else out._updated_at = new Date().toISOString();
    if (previous) return JSON.parse(JSON.stringify(out));
    const ordered: any = { _id: out._id, _created_at: out._created_at, _updated_at: out._updated_at };
    for (const name of Object.keys(layout._schema)) if (Object.hasOwn(out, name)) ordered[name] = out[name];
    return JSON.parse(JSON.stringify(ordered));
}

export function projected(field: PGField, value: any): any {
    if (value === undefined || value === null) return null;
    return field._sql === "BYTEA" ? sqliteStringKey(String(value)) : field._sql === "TEXT" ? JSON.stringify(value) : value;
}

export function filterValue(layout: PGLayout, field: PGField, value: any): any {
    const type = field._type;
    const out = ["boolean", "bool"].includes(type) ? value === true || value === "true" || value === 1
        : type === "date" ? new Date(value).toISOString() : type === "number" ? Number(value) : String(value ?? "");
    if (type === "number" && !Number.isFinite(out)) throw pgError("VALUE");
    return projected(field, out);
}
