export type {
  VaultBackend,
  NoteResult,
  SearchResult,
  WriteResult,
  DeleteResult,
  SyncStatus,
  DailyNoteResult,
  CreateDailyNoteResult,
} from './types.js';

export { FilesystemBackend } from './filesystem.js';
export { CouchDBBackend } from './couchdb.js';
