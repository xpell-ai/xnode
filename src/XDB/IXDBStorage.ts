// IXDBStorage.ts — Storage adapter contract for XDB (no maintenance)
// Keeps XDBEngine storage-agnostic (FS, SQLite, Mongo, etc.)

export type XDBData = {
  _engine: string;
  _security: string;
  _number_of_cached_entities: number;
  _entities: string[];
  _last_commit?: Date | string;
};

export type XDBEntityPersisted = {
  _meta?: any;
  _schema?: any;
  _data?: any;
  _vectors?: any;
  _entity_vectors_index?: any;
  _entity_matrices_index?: any;
  _indices?: any;
};

export interface IXDBStorage {
  // lifecycle
  open(): Promise<void>;
  close(): Promise<void>;

  // meta (global xdb state)
  loadXdbMeta(): Promise<Partial<XDBData> | null>;
  saveXdbMeta(meta: XDBData): Promise<void>;

  // entities
  listEntities(): Promise<string[]>;
  loadEntity(entityName: string): Promise<XDBEntityPersisted | null>;
  saveEntity(entityName: string, payload: XDBEntityPersisted, saveSchema: boolean): Promise<void>;

  // object store
  saveObject(objectName: string, value: string | object): Promise<void>;
  loadObject(objectName: string): Promise<string | null>;
  hasObject(objectName: string): Promise<boolean>;

  // vectors
  saveVector(entityName: string, vectorId: string, vector: number[]): Promise<void>;
  deleteVector(entityName: string, vectorId: string): Promise<void>;
  loadVector(entityName: string, vectorId: string): Promise<number[] | null>;

  // binary vectors
  saveVectorBinary(entityName: string, vectorId: string, buffer: Buffer): Promise<void>;
  loadVectorBinary(entityName: string, vectorId: string): Promise<Buffer | null>;
  loadVectorAsBase64(entityName: string, vectorId: string): Promise<string>;

  // vector index
  saveVectorIndex(entityName: string, index: any): Promise<void>;
  loadVectorIndex(entityName: string): Promise<any | null>;

  // entity files (_files)
  saveFile(entityName: string, fileId: string, data: any): Promise<void>;
  deleteFile(entityName: string, fileId: string): Promise<void>;
  loadFile(entityName: string, fileId: string): Promise<string | null>;

  // temp (_temp)
  loadTempCsv(entityName: string, copy?: boolean): Promise<string | null>;
  appendCsv(entityName: string, data: string): Promise<void>;
  clearTempCsv(entityName: string): Promise<void>;
  copyTempCsv(entityName: string): Promise<void>;

  saveTempFile(entityName: string, fid: string, data: any): Promise<void>;
  loadTempFile(entityName: string, fid: string): Promise<string | null>;
  deleteTempFile(entityName: string, fid: string): Promise<void>;
  getAllTempFileNames(entityName: string): Promise<string[]>;
}
