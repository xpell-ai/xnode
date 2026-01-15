// IXDBMaintenance.ts — optional maintenance/backup utilities.
// Not required for all storage adapters.

// IXDBMaintenance.ts — optional maintenance/FS utilities
// Keep separate from IXDBStorage so non-FS storages (Mongo/SQLite) don't implement it.

export interface IXDBMaintenance {
  // folder ops
  ensureFolder(folderPath: string): Promise<void>;
  deleteFolder(folderPath: string): Promise<void>;
  copyFolder(source: string, destination: string): Promise<void>;

  // optional archive ops (if you still want them)
  zipFolder(folderPath: string): Promise<void>;
  unzip(zipFilePath: string, destination?: string): Promise<void>;
}


export interface IXDBZipMaintenance {
  // legacy zip utilities (FS only)
  zipFolder(folder: string, destinationZip?: string): Promise<void>;
  unzip(zipFilePath: string, destination?: string): Promise<void>;
}

export interface IXDBBackup {
  // production backup/restore (SQLite should implement this)
  // implementation is storage-specific: copy DB file, VACUUM INTO, online backup API, etc.
  backup(destination: string): Promise<void>;
  restore(source: string): Promise<void>;
}
