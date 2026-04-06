// ─── Shared types for vault backends ─────────────────────────────────────────

export interface NoteResult {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  rawContent: string;
}

export interface SearchResult {
  path: string;
  matches: Array<{ line: number; text: string }>;
}

export interface WriteResult {
  path: string;
  created: boolean;
  backedUp?: boolean;
  backupPath?: string;
}

export interface DeleteResult {
  path: string;
  trashPath?: string;
}

export interface SyncStatus {
  conflicts: string[];
  recentlyModified: Array<{ path: string; modified: string }>;
  syncLogSnippet?: string;
  syncLogPath?: string;
  vaultStats: {
    totalNotes: number;
    totalFiles: number;
  };
}

export interface DailyNoteResult {
  path: string;
  exists: boolean;
  note?: NoteResult;
}

export interface CreateDailyNoteResult {
  path: string;
  created: boolean;
}

// ─── VaultBackend interface ──────────────────────────────────────────────────

export interface VaultBackend {
  /** Optional async initialization (e.g. CouchDB connection). Resolves when ready. */
  init?(): Promise<void>;

  listNotes(folder?: string): Promise<string[]>;

  readNote(notePath: string): Promise<NoteResult>;

  writeNote(
    notePath: string,
    content: string,
    frontmatter?: Record<string, unknown>,
    options?: { overwrite?: boolean }
  ): Promise<WriteResult>;

  appendNote(notePath: string, content: string): Promise<void>;

  deleteNote(
    notePath: string,
    options?: { permanent?: boolean }
  ): Promise<DeleteResult>;

  searchVault(
    query: string,
    options?: { folder?: string; caseSensitive?: boolean; maxResults?: number }
  ): Promise<SearchResult[]>;

  listTags(): Promise<Record<string, string[]>>;

  getDailyNote(dateStr?: string): Promise<DailyNoteResult>;

  createDailyNote(options?: {
    dateStr?: string;
    template?: string;
    overwrite?: boolean;
  }): Promise<CreateDailyNoteResult>;

  getSyncStatus(): Promise<SyncStatus>;
}
