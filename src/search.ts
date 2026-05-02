import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import matter from "gray-matter";
import MiniSearch, { type SearchResult as MSResult } from "minisearch";

export interface SearchMatch {
  line: number;
  text: string;
  context?: string[];
  heading?: string;
}

export interface SearchHit {
  path: string;
  score: number;
  matches: SearchMatch[];
}

export interface SearchOptions {
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, string>;
  caseSensitive?: boolean;
  maxResults?: number;
  fuzzy?: boolean;
}

export interface BacklinkHit {
  path: string;
  occurrences: Array<{ line: number; text: string; raw: string }>;
}

interface DocMeta {
  path: string;
  title: string;
  basename: string;
  tags: string[];
  wikilinks: Array<{ target: string; raw: string; line: number; text: string }>;
  bodyLines: string[];
  headings: Array<{ line: number; text: string; level: number }>;
  frontmatter: Record<string, unknown>;
  mtime: number;
}

interface ParsedQuery {
  freeText: string;
  exactPhrases: string[];
  excludes: string[];
  tagFilters: string[];
  pathFilters: string[];
  fileFilters: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const INLINE_TAG_RE = /(?:^|[\s(>])#([a-zA-Z][a-zA-Z0-9/_-]*)/g;
const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#[^\]\n|]+)?(?:\|[^\]\n]+)?\]\]/g;

const FIELDS = ["title", "path", "body", "headings", "tags", "wikilinks"];

export class VaultSearchIndex {
  private vaultPath: string;
  private mini: MiniSearch | null = null;
  private docs: Map<string, DocMeta> = new Map();
  private dirty = true;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  invalidate(): void {
    this.dirty = true;
  }

  invalidateNote(notePath: string): void {
    this.docs.delete(notePath);
    if (this.mini && this.mini.has(notePath)) {
      this.mini.discard(notePath);
    }
    this.dirty = true;
  }

  private async listMarkdownFiles(): Promise<
    Array<{ path: string; mtime: number }>
  > {
    const files = await glob("**/*.md", {
      cwd: this.vaultPath,
      ignore: ["**/.obsidian/**", "**/.trash/**"],
      stat: true,
      withFileTypes: true,
    });
    return files
      .filter((f) => f.isFile())
      .map((f) => ({
        path: f.relative(),
        mtime: f.mtimeMs ?? 0,
      }));
  }

  private buildDoc(
    notePath: string,
    rawContent: string,
    mtime: number,
  ): DocMeta {
    const parsed = matter(rawContent);
    const body = parsed.content;
    const fm = parsed.data as Record<string, unknown>;
    const bodyLines = body.split("\n");

    const headings: DocMeta["headings"] = [];
    bodyLines.forEach((line, i) => {
      const m = line.match(HEADING_RE);
      if (m) {
        headings.push({ line: i + 1, text: m[2], level: m[1].length });
      }
    });

    const tags = new Set<string>();
    if (fm.tags) {
      const fmTags = Array.isArray(fm.tags)
        ? fm.tags
        : String(fm.tags)
            .split(",")
            .map((t) => t.trim());
      for (const t of fmTags) {
        if (t) tags.add(String(t).replace(/^#/, "").toLowerCase());
      }
    }
    for (const m of body.matchAll(INLINE_TAG_RE)) {
      tags.add(m[1].toLowerCase());
    }

    const wikilinks: DocMeta["wikilinks"] = [];
    bodyLines.forEach((line, i) => {
      for (const m of line.matchAll(WIKILINK_RE)) {
        const target = m[1].trim();
        wikilinks.push({
          target,
          raw: m[0],
          line: i + 1,
          text: line.trim(),
        });
      }
    });

    const basename = path.basename(notePath, ".md");
    const title = typeof fm.title === "string" ? fm.title : basename;

    return {
      path: notePath,
      title,
      basename,
      tags: Array.from(tags),
      wikilinks,
      bodyLines,
      headings,
      frontmatter: fm,
      mtime,
    };
  }

  private async refresh(): Promise<void> {
    const current = await this.listMarkdownFiles();
    const currentPaths = new Set(current.map((f) => f.path));

    if (!this.mini) {
      this.mini = new MiniSearch({
        fields: FIELDS,
        storeFields: ["path"],
        idField: "id",
        searchOptions: {
          boost: { title: 4, headings: 2, tags: 3, path: 2, body: 1 },
          fuzzy: 0.2,
          prefix: true,
        },
      });
    }

    for (const existing of Array.from(this.docs.keys())) {
      if (!currentPaths.has(existing)) {
        this.invalidateNote(existing);
      }
    }

    for (const file of current) {
      const cached = this.docs.get(file.path);
      if (cached && cached.mtime >= file.mtime) continue;

      try {
        const raw = await fs.readFile(
          path.join(this.vaultPath, file.path),
          "utf-8",
        );
        const doc = this.buildDoc(file.path, raw, file.mtime);
        this.docs.set(file.path, doc);
        if (this.mini.has(file.path)) {
          this.mini.discard(file.path);
        }
        this.mini.add({
          id: file.path,
          title: doc.title,
          path: doc.path,
          body: doc.bodyLines.join("\n"),
          headings: doc.headings.map((h) => h.text).join(" "),
          tags: doc.tags.join(" "),
          wikilinks: doc.wikilinks.map((w) => w.target).join(" "),
        });
      } catch (err) {
        console.warn(
          `[search] Failed to index ${file.path}:`,
          (err as Error).message,
        );
      }
    }

    this.dirty = false;
  }

  private async ensureFresh(): Promise<void> {
    if (this.dirty || !this.mini) {
      await this.refresh();
    }
  }

  private parseQuery(query: string): ParsedQuery {
    const out: ParsedQuery = {
      freeText: "",
      exactPhrases: [],
      excludes: [],
      tagFilters: [],
      pathFilters: [],
      fileFilters: [],
    };

    let remaining = query;

    for (const m of query.matchAll(/"([^"]+)"/g)) {
      out.exactPhrases.push(m[1]);
      remaining = remaining.replace(m[0], " ");
    }

    const opRe = /(^|\s)(tag|path|file):("([^"]+)"|(\S+))/gi;
    for (const m of Array.from(remaining.matchAll(opRe))) {
      const op = m[2].toLowerCase();
      const val = (m[4] ?? m[5] ?? "").replace(/^#/, "");
      if (!val) continue;
      if (op === "tag") out.tagFilters.push(val.toLowerCase());
      else if (op === "path") out.pathFilters.push(val.toLowerCase());
      else if (op === "file") out.fileFilters.push(val.toLowerCase());
      remaining = remaining.replace(m[0], " ");
    }

    for (const m of remaining.matchAll(/(^|\s)-(\S+)/g)) {
      out.excludes.push(m[2].toLowerCase());
      remaining = remaining.replace(m[0], " ");
    }

    out.freeText = remaining.trim().replace(/\s+/g, " ");
    return out;
  }

  private docPasses(
    doc: DocMeta,
    parsed: ParsedQuery,
    options: SearchOptions,
  ): boolean {
    if (options.folder) {
      const folder = options.folder.replace(/\\/g, "/").replace(/\/$/, "");
      if (!doc.path.startsWith(`${folder}/`)) return false;
    }

    if (options.tags && options.tags.length > 0) {
      const want = options.tags.map((t) => t.replace(/^#/, "").toLowerCase());
      if (!want.every((t) => doc.tags.includes(t))) return false;
    }

    if (parsed.tagFilters.length > 0) {
      if (!parsed.tagFilters.every((t) => doc.tags.includes(t))) return false;
    }

    if (options.frontmatter) {
      const cs = options.caseSensitive ?? false;
      for (const [k, v] of Object.entries(options.frontmatter)) {
        const fmVal = doc.frontmatter[k];
        if (fmVal == null) return false;
        const a = String(fmVal);
        const b = v;
        if (cs ? a !== b : a.toLowerCase() !== b.toLowerCase()) return false;
      }
    }

    if (parsed.pathFilters.length > 0) {
      const lower = doc.path.toLowerCase();
      if (!parsed.pathFilters.every((p) => lower.includes(p))) return false;
    }

    if (parsed.fileFilters.length > 0) {
      const lower = doc.basename.toLowerCase();
      if (!parsed.fileFilters.every((f) => lower.includes(f))) return false;
    }

    if (parsed.exactPhrases.length > 0 || parsed.excludes.length > 0) {
      const haystack = (
        doc.title +
        " " +
        doc.path +
        " " +
        doc.bodyLines.join("\n")
      ).toLowerCase();
      for (const phrase of parsed.exactPhrases) {
        if (!haystack.includes(phrase.toLowerCase())) return false;
      }
      for (const ex of parsed.excludes) {
        if (haystack.includes(ex)) return false;
      }
    }

    return true;
  }

  private buildMatches(
    doc: DocMeta,
    parsed: ParsedQuery,
    caseSensitive: boolean,
  ): SearchMatch[] {
    const needles = [
      ...(parsed.freeText ? parsed.freeText.split(/\s+/).filter(Boolean) : []),
      ...parsed.exactPhrases,
    ];
    if (needles.length === 0) return [];

    const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
    const matches: SearchMatch[] = [];

    for (let i = 0; i < doc.bodyLines.length; i++) {
      const line = doc.bodyLines[i];
      const normLine = norm(line);
      const hit = needles.some((n) => normLine.includes(norm(n)));
      if (!hit) continue;

      const ctx: string[] = [];
      if (i > 0) ctx.push(doc.bodyLines[i - 1].trim());
      ctx.push(line.trim());
      if (i < doc.bodyLines.length - 1) ctx.push(doc.bodyLines[i + 1].trim());

      let heading: string | undefined;
      for (let h = doc.headings.length - 1; h >= 0; h--) {
        if (doc.headings[h].line <= i + 1) {
          heading = doc.headings[h].text;
          break;
        }
      }

      matches.push({
        line: i + 1,
        text: line.trim(),
        context: ctx,
        heading,
      });

      if (matches.length >= 8) break;
    }

    return matches;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    await this.ensureFresh();
    if (!this.mini) return [];

    const parsed = this.parseQuery(query);
    const maxResults = options.maxResults ?? 20;
    const fuzzy = options.fuzzy ?? true;

    let candidates: Array<{ doc: DocMeta; score: number }>;

    if (parsed.freeText.length === 0 && parsed.exactPhrases.length === 0) {
      candidates = Array.from(this.docs.values()).map((doc) => ({
        doc,
        score: 1,
      }));
    } else {
      const queryParts: string[] = [];
      if (parsed.freeText) queryParts.push(parsed.freeText);
      queryParts.push(...parsed.exactPhrases);
      const msQuery = queryParts.join(" ");

      const msResults: MSResult[] = this.mini.search(msQuery, {
        fuzzy: fuzzy ? 0.3 : false,
        prefix: true,
        combineWith: "AND",
      });

      candidates = msResults
        .map((r) => {
          const doc = this.docs.get(r.id as string);
          return doc ? { doc, score: r.score } : null;
        })
        .filter((x): x is { doc: DocMeta; score: number } => x !== null);
    }

    const filtered = candidates.filter((c) =>
      this.docPasses(c.doc, parsed, options),
    );

    const caseSensitive = options.caseSensitive ?? false;
    const hits: SearchHit[] = filtered.map(({ doc, score }) => ({
      path: doc.path,
      score: Math.round(score * 100) / 100,
      matches: this.buildMatches(doc, parsed, caseSensitive),
    }));

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, maxResults);
  }

  async findBacklinks(
    notePath: string,
    options: { maxResults?: number } = {},
  ): Promise<BacklinkHit[]> {
    await this.ensureFresh();
    const target = path.basename(notePath, ".md").toLowerCase();
    const maxResults = options.maxResults ?? 50;
    const hits: BacklinkHit[] = [];

    for (const doc of this.docs.values()) {
      if (doc.path === notePath) continue;
      const occurrences = doc.wikilinks
        .filter((w) => {
          const linkTarget = w.target.toLowerCase();
          return (
            linkTarget === target ||
            linkTarget.endsWith(`/${target}`) ||
            path.basename(linkTarget) === target
          );
        })
        .map((w) => ({ line: w.line, text: w.text, raw: w.raw }));

      if (occurrences.length > 0) {
        hits.push({ path: doc.path, occurrences });
        if (hits.length >= maxResults) break;
      }
    }

    hits.sort((a, b) => a.path.localeCompare(b.path));
    return hits;
  }
}
