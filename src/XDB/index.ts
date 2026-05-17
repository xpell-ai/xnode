/* -------------------------------------------------------------------------- */
/* XDB exports (auto-discovered)                                              */
/* -------------------------------------------------------------------------- */

export { default as XDB } from "./XDB.js";
export { XDBModule } from "./XDB.js";
export type { XDBModuleInitOptions } from "./XDB.js";

export { default as XDBEngine } from "./XDBEngine.js";
export type { IXDBEmbeddingProvider, IXDBVectorQueryProvider, XDBOptions } from "./XDBEngine.js";

export { default as XDBEntity } from "./XDBEntity.js";
export { default as XDBVector } from "./XDBVector.js";
export { default as XDBFile } from "./XDBFile.js";
export { default as XDBTemp } from "./XDBTemp.js";
export { default as XDBCache } from "./XDBCache.js";

export { default as XDBStorageFS } from "./XDBStorageFS.js";
export { default as XDBStorageSqlite } from "./XDBStorageSqlite.js";

export type { IXDBStorage, XDBData, XDBEntityPersisted } from "./IXDBStorage.js";
export type { IXDBMaintenance } from "./IXDBMaintenance.js";
export { XpellEmbeddingProvider } from "./providers/index.js";
