// IXDBBackup.ts — production backup/restore contract (storage-specific)

export interface IXDBBackup {
  backup(destinationPath: string): Promise<void>;
  restore(sourcePath: string): Promise<void>;
}
