import type Database from "better-sqlite3";
import type { EntityHistoricalImportManifest } from "./EntityHistoricalImport.js";
import type { EntityLocalUnitCapacity } from "./EntityLocalUnit.js";

/** Package-private authority. Neither JSON nor a structurally matching acknowledgement is an owner. */
export type HistoricalOwner = Readonly<{
    _file: string; _destination: string;
    _manifest: EntityHistoricalImportManifest; _manifest_sha256: string;
    _definitions: readonly any[]; _metadata: any; _capacity: EntityLocalUnitCapacity;
    _import: Readonly<Record<string, any>>; _ddl: readonly any[];
    _provider_meta: readonly any[]; _provider_indexes: readonly any[];
    assertOwned: () => void;
    inspectRecords: (connection: Database.Database) => any;
}>;
const owners = new WeakMap<object, HistoricalOwner>();
export function registerHistoricalOwner(handle: object, context: HistoricalOwner): void { owners.set(handle, context); }
export function aliasHistoricalOwner(alias: object, handle: object): void {
    const context = owners.get(handle);
    if (!context) throw new Error("E_ENTITY_HISTORICAL_BACKUP_OWNER");
    owners.set(alias, context);
}
export function requireHistoricalOwner(handle: object): HistoricalOwner {
    const context = owners.get(handle);
    if (!context) throw new Error("E_ENTITY_HISTORICAL_BACKUP_OWNER");
    context.assertOwned();
    return context;
}
