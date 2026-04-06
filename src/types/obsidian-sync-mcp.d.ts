declare module 'obsidian-sync-mcp/dist/vault-5Y35MEZS.js' {
  export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
  }

  export interface NoteListing {
    path: string;
    mtime: number;
  }

  export class Vault {
    constructor(config: VaultConfig);
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    getMetadata(path: string): Promise<{
      path: string;
      size: number;
      ctime: number;
      mtime: number;
    } | null>;
  }
}
