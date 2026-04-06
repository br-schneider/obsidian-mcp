/**
 * CouchDB backend — reads/writes from CouchDB via Self-hosted LiveSync format.
 * Uses the obsidian-sync-mcp Vault class which bundles livesync-commonlib.
 */

import matter from 'gray-matter';
import * as path from 'path';

import { Vault as LiveSyncVault } from 'obsidian-sync-mcp/dist/vault-5Y35MEZS.js';

import type {
  VaultBackend,
  NoteResult,
  SearchResult,
  WriteResult,
  DeleteResult,
  SyncStatus,
  DailyNoteResult,
  CreateDailyNoteResult,
} from './types.js';

export interface CouchDBBackendConfig {
  url: string;
  database: string;
  username: string;
  password: string;
  encryptionPassphrase?: string;
  dailyNoteFolder?: string;
  dailyNoteDateFormat?: string;
}

export class CouchDBBackend implements VaultBackend {
  private vault!: LiveSyncVault;
  private config: CouchDBBackendConfig;
  private dailyNoteFolder: string;
  private dailyNoteDateFormat: string;
  private initTime: number = Date.now();
  private lastSuccessfulRead: number | null = null;

  constructor(config: CouchDBBackendConfig) {
    this.config = config;
    this.dailyNoteFolder = config.dailyNoteFolder ?? 'Journal';
    this.dailyNoteDateFormat = config.dailyNoteDateFormat ?? 'YYYY-MM-DD';
  }

  async init(): Promise<void> {
    this.vault = new LiveSyncVault({
      couchdbUrl: this.config.url,
      couchdbUser: this.config.username,
      couchdbPassword: this.config.password,
      database: this.config.database,
      passphrase: this.config.encryptionPassphrase,
    });
    await this.vault.init();
    this.initTime = Date.now();
    console.log(`✅  CouchDB backend connected: ${this.config.url}/${this.config.database}`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private validatePath(notePath: string): void {
    if (!notePath || notePath.startsWith('/') || notePath.includes('\0') || notePath.includes('..') || notePath.length > 1000) {
      throw new Error(`Invalid path: ${notePath}`);
    }
  }

  private formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[date.getDay()];

    switch (this.dailyNoteDateFormat) {
      case 'MM-DD-YYYY DayOfWeek':
        return `${m}-${d}-${y} ${dayName}`;
      case 'MM-DD-YYYY':
        return `${m}-${d}-${y}`;
      case 'YYYY-MM-DD':
      default:
        return `${y}-${m}-${d}`;
    }
  }

  private parseFormattedDate(dateStr: string): Date | null {
    const mdyDay = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})\s+\w+$/);
    if (mdyDay) return new Date(`${mdyDay[3]}-${mdyDay[1]}-${mdyDay[2]}T12:00:00`);

    const mdy = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (mdy) return new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}T12:00:00`);

    const ymd = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T12:00:00`);

    return null;
  }

  private parseDateInput(dateStr: string): Date {
    const parsed = this.parseFormattedDate(dateStr);
    if (parsed) return parsed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return new Date(`${dateStr}T12:00:00`);
    }
    return new Date(dateStr);
  }

  private getDailyNotePath(date: Date = new Date()): string {
    const dateStr = this.formatDate(date);
    return path.join(this.dailyNoteFolder, `${dateStr}.md`);
  }

  // ─── Notes ───────────────────────────────────────────────────────────────────

  async listNotes(folder?: string): Promise<string[]> {
    const notes = await this.vault.listNotes(folder);
    // Filter .obsidian and .trash like FilesystemBackend
    return notes
      .filter(f => !f.startsWith('.obsidian/') && !f.includes('/.obsidian/') &&
                    !f.startsWith('.trash/') && !f.includes('/.trash/'))
      .sort();
  }

  async readNote(notePath: string): Promise<NoteResult> {
    this.validatePath(notePath);
    const rawContent = await this.vault.readNote(notePath);
    if (rawContent === null) {
      throw new Error(`Note not found: ${notePath}`);
    }
    this.lastSuccessfulRead = Date.now();
    const { data: frontmatter, content } = matter(rawContent);
    return { path: notePath, content, frontmatter, rawContent };
  }

  async writeNote(
    notePath: string,
    content: string,
    frontmatter?: Record<string, unknown>,
    options: { overwrite?: boolean } = {}
  ): Promise<WriteResult> {
    this.validatePath(notePath);

    // Check if note exists
    const existing = await this.vault.readNote(notePath);
    const exists = existing !== null;

    if (exists && !options.overwrite) {
      throw new Error(
        `Note already exists: ${notePath}. Set overwrite: true to replace (a backup will be created).`
      );
    }

    // Create backup before overwriting (write backup as a separate note in CouchDB)
    let backedUp = false;
    let backupPath: string | undefined;
    if (exists && options.overwrite) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${notePath}.${timestamp}.bak`;
      await this.vault.writeNote(backupPath, existing!);
      backedUp = true;
    }

    const output = frontmatter
      ? matter.stringify(content, frontmatter as Record<string, string>)
      : content;
    const success = await this.vault.writeNote(notePath, output);
    if (!success) {
      throw new Error(`Failed to write note: ${notePath}`);
    }
    return { path: notePath, created: !exists, backedUp, backupPath };
  }

  async appendNote(notePath: string, content: string): Promise<void> {
    this.validatePath(notePath);
    const existing = await this.vault.readNote(notePath);
    if (existing === null) {
      throw new Error(`Note not found: ${notePath}`);
    }
    const separator = content.startsWith('\n') ? '' : '\n';
    const success = await this.vault.writeNote(notePath, existing + separator + content);
    if (!success) {
      throw new Error(`Failed to append to note: ${notePath}`);
    }
  }

  async deleteNote(
    notePath: string,
    options: { permanent?: boolean } = {}
  ): Promise<DeleteResult> {
    this.validatePath(notePath);

    const existing = await this.vault.readNote(notePath);
    if (existing === null) {
      throw new Error(`Note not found: ${notePath}`);
    }

    if (!options.permanent) {
      // Soft delete: move content to .trash/ path in CouchDB
      const basename = path.basename(notePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const trashName = `${basename.replace('.md', '')}.${timestamp}.md`;
      const trashPath = `.trash/${trashName}`;
      await this.vault.writeNote(trashPath, existing);
    }

    const success = await this.vault.deleteNote(notePath);
    if (!success) {
      throw new Error(`Failed to delete note: ${notePath}`);
    }

    if (options.permanent) {
      return { path: notePath };
    }

    const basename = path.basename(notePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashName = `${basename.replace('.md', '')}.${timestamp}.md`;
    return { path: notePath, trashPath: `.trash/${trashName}` };
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  async searchVault(
    query: string,
    options: { folder?: string; caseSensitive?: boolean; maxResults?: number } = {}
  ): Promise<SearchResult[]> {
    const { folder, caseSensitive = false, maxResults = 20 } = options;
    const notes = await this.listNotes(folder);
    const results: SearchResult[] = [];
    const queryTest = caseSensitive ? query : query.toLowerCase();

    for (const notePath of notes) {
      if (results.length >= maxResults) break;
      try {
        const rawContent = await this.vault.readNote(notePath);
        if (!rawContent) continue;
        const lines = rawContent.split('\n');
        const matches: Array<{ line: number; text: string }> = [];

        lines.forEach((line, i) => {
          const testLine = caseSensitive ? line : line.toLowerCase();
          if (testLine.includes(queryTest)) {
            matches.push({ line: i + 1, text: line.trim() });
          }
        });

        if (matches.length > 0) {
          results.push({ path: notePath, matches: matches.slice(0, 10) });
        }
      } catch (err) {
        console.warn(`[search] Error reading ${notePath}:`, (err as Error).message);
      }
    }

    return results;
  }

  // ─── Tags ────────────────────────────────────────────────────────────────────

  async listTags(): Promise<Record<string, string[]>> {
    const notes = await this.listNotes();
    const tagMap: Record<string, string[]> = {};

    for (const notePath of notes) {
      try {
        const { frontmatter, content } = await this.readNote(notePath);
        const tags: string[] = [];

        if (frontmatter.tags) {
          const fmTags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags
            : String(frontmatter.tags).split(',').map(t => t.trim());
          tags.push(...fmTags.filter(Boolean));
        }

        const inlineMatches = content.matchAll(/(?<!\n)#([a-zA-Z][a-zA-Z0-9/_-]*)/g);
        for (const match of inlineMatches) {
          tags.push(match[1]);
        }

        for (const tag of tags) {
          if (!tagMap[tag]) tagMap[tag] = [];
          if (!tagMap[tag].includes(notePath)) tagMap[tag].push(notePath);
        }
      } catch (err) {
        console.warn(`[tags] Error reading ${notePath}:`, (err as Error).message);
      }
    }

    return Object.fromEntries(
      Object.entries(tagMap).sort(([a], [b]) => a.localeCompare(b))
    );
  }

  // ─── Daily Notes ─────────────────────────────────────────────────────────────

  async getDailyNote(dateStr?: string): Promise<DailyNoteResult> {
    const date = dateStr ? this.parseDateInput(dateStr) : new Date();
    const notePath = this.getDailyNotePath(date);

    const rawContent = await this.vault.readNote(notePath);
    if (rawContent === null) {
      return { path: notePath, exists: false };
    }

    const { data: frontmatter, content } = matter(rawContent);
    return {
      path: notePath,
      exists: true,
      note: { path: notePath, content, frontmatter, rawContent },
    };
  }

  async createDailyNote(
    options: { dateStr?: string; template?: string; overwrite?: boolean } = {}
  ): Promise<CreateDailyNoteResult> {
    const { dateStr, template, overwrite = false } = options;
    const date = dateStr ? this.parseDateInput(dateStr) : new Date();
    const formattedDate = this.formatDate(date);
    const notePath = this.getDailyNotePath(date);

    const existing = await this.vault.readNote(notePath);
    if (existing !== null && !overwrite) {
      return { path: notePath, created: false };
    }

    const content = template
      ? template
          .replace(/{{date}}/g, formattedDate)
          .replace(/{{title}}/g, formattedDate)
      : '';

    return this.writeNote(notePath, content, undefined, { overwrite: true });
  }

  // ─── Sync Status ─────────────────────────────────────────────────────────────

  async getSyncStatus(): Promise<SyncStatus> {
    const notes = await this.vault.listNotesWithMtime();

    // Recently modified (last 15 minutes)
    const window = Date.now() - 15 * 60 * 1000;
    const recentlyModified = notes
      .filter(n => n.mtime > window)
      .sort((a, b) => b.mtime - a.mtime)
      .map(n => ({
        path: n.path,
        modified: new Date(n.mtime).toISOString(),
      }));

    const mdNotes = notes.filter(n => n.path.endsWith('.md'));

    return {
      conflicts: [], // CouchDB handles conflicts internally via LiveSync
      recentlyModified,
      syncLogSnippet: this.lastSuccessfulRead
        ? `Last successful CouchDB read: ${new Date(this.lastSuccessfulRead).toISOString()}`
        : 'No reads performed yet',
      syncLogPath: `${this.config.url}/${this.config.database}`,
      vaultStats: {
        totalNotes: mdNotes.length,
        totalFiles: notes.length,
      },
    };
  }
}
