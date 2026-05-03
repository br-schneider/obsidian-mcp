import * as fs from "fs/promises";
import * as path from "path";
import { existsSync, realpathSync } from "fs";
import matter from "gray-matter";
import { glob } from "glob";
import os from "os";
import {
  VaultSearchIndex,
  type SearchHit,
  type SearchOptions,
  type BacklinkHit,
} from "./search.js";

export interface NoteResult {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  rawContent: string;
}

export type SearchResult = SearchHit;

export interface WriteResult {
  path: string;
  created: boolean;
  backedUp?: boolean;
  backupPath?: string;
}

export interface EditResult {
  path: string;
  backedUp: boolean;
  backupPath?: string;
}

export interface MoveResult {
  fromPath: string;
  toPath: string;
  overwroteDestination: boolean;
  backedUp: boolean;
  backupPath?: string;
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

export class ObsidianVault {
  private vaultPath: string;
  private vaultRealPath: string;
  private searchIndex: VaultSearchIndex;

  constructor(config: { vaultPath: string }) {
    this.vaultPath = path.resolve(config.vaultPath);

    if (!existsSync(this.vaultPath)) {
      throw new Error(`Vault path does not exist: ${this.vaultPath}`);
    }

    this.vaultRealPath = realpathSync(this.vaultPath);
    this.searchIndex = new VaultSearchIndex(this.vaultPath);
  }

  private findNearestExistingPath(candidatePath: string): string | undefined {
    let current = candidatePath;

    while (!existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }

    return current;
  }

  private resolvePath(notePath: string): string {
    const resolved = path.resolve(this.vaultPath, notePath);

    // First check: resolved path must be within vault
    if (
      !resolved.startsWith(this.vaultPath + path.sep) &&
      resolved !== this.vaultPath
    ) {
      throw new Error(`Path traversal attempt blocked: ${notePath}`);
    }

    // Second check: resolve symlinks and verify the real path is still inside the vault.
    // For existing files, check the file itself. For new files, check the parent directory
    // (a symlinked directory could redirect writes outside the vault).
    const targetToCheck = this.findNearestExistingPath(resolved);
    if (targetToCheck) {
      const realPath = realpathSync(targetToCheck);
      if (
        !realPath.startsWith(this.vaultRealPath + path.sep) &&
        realPath !== this.vaultRealPath
      ) {
        throw new Error(
          `Symlink escape blocked: ${notePath} resolves to ${realPath}`,
        );
      }
    }

    return resolved;
  }

  private assertNotProtectedPath(
    resolvedPath: string,
    originalPath: string,
  ): void {
    const canonicalBasePath = this.findNearestExistingPath(resolvedPath);
    const canonicalBase = canonicalBasePath
      ? path.join(
          realpathSync(canonicalBasePath),
          path.relative(canonicalBasePath, resolvedPath),
        )
      : resolvedPath;

    const hasProtectedSegment = (basePath: string, candidatePath: string) =>
      path
        .relative(basePath, candidatePath)
        .split(/[\\/]+/)
        .filter((segment) => segment && segment !== ".")
        .some((segment) => segment === ".obsidian" || segment === ".trash");

    if (
      hasProtectedSegment(this.vaultPath, resolvedPath) ||
      hasProtectedSegment(this.vaultRealPath, canonicalBase)
    ) {
      throw new Error(
        `Access to protected vault path is blocked: ${originalPath}`,
      );
    }
  }

  private resolveNotePath(notePath: string): string {
    const resolved = this.resolvePath(notePath);
    this.assertNotProtectedPath(resolved, notePath);

    if (path.extname(resolved).toLowerCase() !== ".md") {
      throw new Error(`Note paths must end in .md: ${notePath}`);
    }

    return resolved;
  }

  private resolveAttachmentPath(filePath: string): string {
    const resolved = this.resolvePath(filePath);
    this.assertNotProtectedPath(resolved, filePath);

    if (path.extname(resolved).toLowerCase() === ".md") {
      throw new Error(`Attachment paths cannot end in .md: ${filePath}`);
    }

    return resolved;
  }

  async listNotes(folder?: string): Promise<string[]> {
    const base = folder ? this.resolvePath(folder) : this.vaultPath;
    if (folder) {
      this.assertNotProtectedPath(base, folder);
    }
    const files = await glob("**/*.md", {
      cwd: base,
      ignore: ["**/.obsidian/**", "**/.trash/**"],
    });
    return files.sort().map((f) => (folder ? path.join(folder, f) : f));
  }

  async readNote(notePath: string): Promise<NoteResult> {
    const fullPath = this.resolveNotePath(notePath);
    const rawContent = await fs.readFile(fullPath, "utf-8");
    const { data: frontmatter, content } = matter(rawContent);
    return { path: notePath, content, frontmatter, rawContent };
  }

  // #2: Overwrite protection + automatic backup
  async writeNote(
    notePath: string,
    content: string,
    frontmatter?: Record<string, unknown>,
    options: { overwrite?: boolean } = {},
  ): Promise<WriteResult> {
    const fullPath = this.resolveNotePath(notePath);
    const exists = existsSync(fullPath);

    // Block overwriting existing notes without explicit flag
    if (exists && !options.overwrite) {
      throw new Error(
        `Note already exists: ${notePath}. Set overwrite: true to replace (a backup will be created).`,
      );
    }

    // Create backup before overwriting
    let backedUp = false;
    let backupPath: string | undefined;

    if (exists && options.overwrite) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${notePath}.${timestamp}.bak`;
      const fullBackupPath = path.resolve(this.vaultPath, backupPath);
      await fs.copyFile(fullPath, fullBackupPath);
      backedUp = true;
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const output = frontmatter
      ? matter.stringify(content, frontmatter as Record<string, string>)
      : content;
    await fs.writeFile(fullPath, output, "utf-8");
    this.searchIndex.invalidateNote(notePath);
    return { path: notePath, created: !exists, backedUp, backupPath };
  }

  async appendNote(notePath: string, content: string): Promise<void> {
    const fullPath = this.resolveNotePath(notePath);
    if (!existsSync(fullPath)) {
      throw new Error(`Note not found: ${notePath}`);
    }
    const separator = content.startsWith("\n") ? "" : "\n";
    await fs.appendFile(fullPath, separator + content, "utf-8");
    this.searchIndex.invalidateNote(notePath);
  }

  async editNote(
    notePath: string,
    oldText: string,
    newText: string,
  ): Promise<EditResult> {
    const fullPath = this.resolveNotePath(notePath);

    if (!existsSync(fullPath)) {
      throw new Error(`Note not found: ${notePath}`);
    }

    const rawContent = await fs.readFile(fullPath, "utf-8");

    // Count occurrences — old_text must be unique
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = rawContent.indexOf(oldText, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldText.length;
    }

    if (count === 0) {
      throw new Error(
        `edit_note failed: old_text not found in ${notePath}. Make sure the text matches exactly (including whitespace and newlines).`,
      );
    }

    if (count > 1) {
      throw new Error(
        `edit_note failed: old_text appears ${count} times in ${notePath}. Include more surrounding context to make it unique.`,
      );
    }

    // Backup before editing
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${notePath}.${timestamp}.bak`;
    const fullBackupPath = path.resolve(this.vaultPath, backupPath);
    await fs.copyFile(fullPath, fullBackupPath);

    const updatedContent = rawContent.replace(oldText, newText);
    await fs.writeFile(fullPath, updatedContent, "utf-8");
    this.searchIndex.invalidateNote(notePath);

    return { path: notePath, backedUp: true, backupPath };
  }

  async moveNote(
    fromPath: string,
    toPath: string,
    options: { overwrite?: boolean } = {},
  ): Promise<MoveResult> {
    const fromResolved = this.resolveNotePath(fromPath);
    const toResolved = this.resolveNotePath(toPath);

    if (!existsSync(fromResolved)) {
      throw new Error(`Note not found: ${fromPath}`);
    }

    if (fromResolved === toResolved) {
      throw new Error(`Source and destination are the same: ${fromPath}`);
    }

    const destinationExists = existsSync(toResolved);
    if (destinationExists && !options.overwrite) {
      throw new Error(
        `Destination already exists: ${toPath}. Set overwrite: true to replace (a backup of the destination will be created).`,
      );
    }

    let backedUp = false;
    let backupPath: string | undefined;

    if (destinationExists && options.overwrite) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${toPath}.${timestamp}.bak`;
      const fullBackupPath = path.resolve(this.vaultPath, backupPath);
      await fs.copyFile(toResolved, fullBackupPath);
      backedUp = true;
    }

    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.rename(fromResolved, toResolved);

    this.searchIndex.invalidateNote(fromPath);
    this.searchIndex.invalidateNote(toPath);

    return {
      fromPath,
      toPath,
      overwroteDestination: destinationExists,
      backedUp,
      backupPath,
    };
  }

  async setFrontmatter(
    notePath: string,
    updates: Record<string, unknown>,
  ): Promise<EditResult> {
    if (Object.keys(updates).length === 0) {
      throw new Error(
        "setFrontmatter requires at least one key in updates.",
      );
    }
    return this.mutateFrontmatter(notePath, (fm) => {
      for (const [k, v] of Object.entries(updates)) {
        fm[k] = v;
      }
    });
  }

  async deleteFrontmatter(
    notePath: string,
    key: string,
  ): Promise<EditResult> {
    return this.mutateFrontmatter(notePath, (fm) => {
      if (!(key in fm)) {
        throw new Error(
          `Frontmatter key "${key}" not found in ${notePath}.`,
        );
      }
      delete fm[key];
    });
  }

  private async mutateFrontmatter(
    notePath: string,
    mutate: (fm: Record<string, unknown>) => void,
  ): Promise<EditResult> {
    const fullPath = this.resolveNotePath(notePath);

    if (!existsSync(fullPath)) {
      throw new Error(`Note not found: ${notePath}`);
    }

    const rawContent = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(rawContent);
    const fm = { ...(parsed.data as Record<string, unknown>) };

    mutate(fm);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${notePath}.${timestamp}.bak`;
    const fullBackupPath = path.resolve(this.vaultPath, backupPath);
    await fs.copyFile(fullPath, fullBackupPath);

    const output =
      Object.keys(fm).length === 0
        ? parsed.content.replace(/^\n+/, "")
        : matter.stringify(parsed.content, fm as Record<string, string>);
    await fs.writeFile(fullPath, output, "utf-8");
    this.searchIndex.invalidateNote(notePath);

    return { path: notePath, backedUp: true, backupPath };
  }

  // ─── Attachments ─────────────────────────────────────────────────────────────

  async uploadAttachment(
    filePath: string,
    data: Buffer,
    options: { overwrite?: boolean } = {},
  ): Promise<{ path: string; bytes: number }> {
    const resolved = this.resolveAttachmentPath(filePath);

    if (existsSync(resolved) && !options.overwrite) {
      throw new Error(
        `File already exists: ${filePath}. Set overwrite: true to replace.`,
      );
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, data);
    return { path: filePath, bytes: data.length };
  }

  private extractTags(frontmatter: Record<string, unknown>): string[] {
    if (!frontmatter.tags) return [];
    const raw = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : String(frontmatter.tags)
          .split(",")
          .map((t) => t.trim());
    return raw.filter(Boolean).map(String);
  }

  async searchVault(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    return this.searchIndex.search(query, options);
  }

  async findBacklinks(
    notePath: string,
    options: { maxResults?: number } = {},
  ): Promise<BacklinkHit[]> {
    return this.searchIndex.findBacklinks(notePath, options);
  }

  async listTags(): Promise<Record<string, string[]>> {
    const notes = await this.listNotes();
    const tagMap: Record<string, string[]> = {};

    for (const notePath of notes) {
      try {
        const { frontmatter, content } = await this.readNote(notePath);
        const tags: string[] = [];

        // Frontmatter tags (supports both array and string)
        if (frontmatter.tags) {
          const fmTags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags
            : String(frontmatter.tags)
                .split(",")
                .map((t) => t.trim());
          tags.push(...fmTags.filter(Boolean));
        }

        // Inline #tags (excludes #headings by checking they're not at line start)
        const inlineMatches = content.matchAll(
          /(?<!\n)#([a-zA-Z][a-zA-Z0-9/_-]*)/g,
        );
        for (const match of inlineMatches) {
          tags.push(match[1]);
        }

        for (const tag of tags) {
          if (!tagMap[tag]) tagMap[tag] = [];
          if (!tagMap[tag].includes(notePath)) tagMap[tag].push(notePath);
        }
      } catch (err) {
        console.warn(
          `[tags] Error reading ${notePath}:`,
          (err as Error).message,
        );
      }
    }

    return Object.fromEntries(
      Object.entries(tagMap).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  async getSyncStatus(): Promise<SyncStatus> {
    // 1. Find conflict files (Obsidian Sync names them with "(conflict)" suffix)
    const allFiles = await glob("**/*", {
      cwd: this.vaultPath,
      ignore: ["**/.obsidian/**", "**/.trash/**"],
    });

    const conflicts = allFiles.filter((f) => /\(conflict\s*\d*\)/i.test(f));

    // 2. Recently modified (last 15 minutes — useful to see if sync is actively working)
    const window = Date.now() - 15 * 60 * 1000;
    const recentlyModified: Array<{ path: string; modified: string }> = [];

    for (const file of allFiles.filter((f) => f.endsWith(".md"))) {
      try {
        const stat = await fs.stat(path.join(this.vaultPath, file));
        if (stat.mtimeMs > window) {
          recentlyModified.push({
            path: file,
            modified: stat.mtime.toISOString(),
          });
        }
      } catch {
        // skip
      }
    }

    recentlyModified.sort((a, b) => b.modified.localeCompare(a.modified));

    // 3. Try to read a sync log from inside the vault. Reading host-level
    // Obsidian app logs is opt-in because it expands the trust boundary.
    let syncLogSnippet: string | undefined;
    let syncLogPath: string | undefined;

    const candidateLogs = [
      path.join(this.vaultPath, ".obsidian", "sync-log.txt"),
    ];
    if (process.env.ALLOW_HOST_OBSIDIAN_LOG_READS === "true") {
      candidateLogs.push(
        path.join(
          os.homedir(),
          "Library/Application Support/obsidian/obsidian.log",
        ),
        path.join(os.homedir(), "Library/Logs/obsidian/obsidian.log"),
      );
    }

    for (const logPath of candidateLogs) {
      if (existsSync(logPath)) {
        syncLogPath = logPath;
        try {
          const raw = await fs.readFile(logPath, "utf-8");
          const lines = raw.split("\n");
          const syncLines = lines
            .filter((l) => /sync|upload|download|conflict|pull|push/i.test(l))
            .slice(-30);
          if (syncLines.length > 0) {
            syncLogSnippet = syncLines.join("\n");
          }
        } catch {
          // log not readable
        }
        break;
      }
    }

    const mdFiles = allFiles.filter((f) => f.endsWith(".md"));

    return {
      conflicts,
      recentlyModified,
      syncLogSnippet,
      syncLogPath,
      vaultStats: {
        totalNotes: mdFiles.length,
        totalFiles: allFiles.length,
      },
    };
  }
}
