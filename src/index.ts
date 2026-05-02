import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { existsSync } from "fs";
import { glob } from "glob";
import { ObsidianVault } from "./vault.js";

process.on("uncaughtException", (err) => {
  console.error(`[crash-guard] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[crash-guard] Unhandled rejection:`, reason);
  process.exit(1);
});

const VAULT_PATH = process.env.VAULT_PATH;
const PORT = parseInt(process.env.PORT ?? "3456", 10);
const BIND_ADDRESS = process.env.BIND_ADDRESS ?? "127.0.0.1";
const AUTH_TOKEN = process.env.AUTH_TOKEN?.trim();
const ALLOW_UNAUTHENTICATED_NON_LOOPBACK =
  process.env.ALLOW_UNAUTHENTICATED_NON_LOOPBACK === "true";
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE ?? "1mb";
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const SYNC_WAIT_TIMEOUT = parseInt(process.env.SYNC_WAIT_TIMEOUT ?? "300", 10);

if (!VAULT_PATH) {
  console.error("❌  VAULT_PATH env var is required");
  process.exit(1);
}

function isLoopbackBindAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

if (
  !AUTH_TOKEN &&
  !isLoopbackBindAddress(BIND_ADDRESS) &&
  !ALLOW_UNAUTHENTICATED_NON_LOOPBACK
) {
  console.error(
    "❌  AUTH_TOKEN is required when binding to a non-loopback address. Set ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true only if you intentionally rely on network-level access controls.",
  );
  process.exit(1);
}

const startTime = Date.now();
let vaultReady = false;
let vault: ObsidianVault;

async function waitForVault(): Promise<void> {
  // If vault path already exists, init immediately
  if (existsSync(VAULT_PATH!)) {
    vault = new ObsidianVault({ vaultPath: VAULT_PATH! });
    vaultReady = true;
    console.log(`✅  Vault loaded: ${VAULT_PATH}`);
    return;
  }

  // Wait for vault path to appear (sync container may still be downloading)
  console.log(
    `⏳  Waiting for vault at ${VAULT_PATH} (sync may still be in progress)...`,
  );
  const deadline = Date.now() + SYNC_WAIT_TIMEOUT * 1000;
  let waitLoops = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    waitLoops++;

    if (existsSync(VAULT_PATH!)) {
      // Check if there's at least one .md file (initial sync might still be creating the dir)
      const mdFiles = await glob("**/*.md", {
        cwd: VAULT_PATH!,
        ignore: ["**/.obsidian/**", "**/.trash/**"],
      }).catch(() => []);

      if (mdFiles.length > 0) {
        vault = new ObsidianVault({ vaultPath: VAULT_PATH! });
        vaultReady = true;
        console.log(
          `✅  Vault synced and loaded: ${VAULT_PATH} (${mdFiles.length} notes)`,
        );
        return;
      }
      // Log every 5th iteration (~15s) to avoid spam
      if (waitLoops % 5 === 0) {
        console.log(
          `⏳  Vault directory exists but no .md files yet, waiting...`,
        );
      }
    }
  }

  // Timeout — start anyway if directory exists (might be an empty vault)
  if (existsSync(VAULT_PATH!)) {
    vault = new ObsidianVault({ vaultPath: VAULT_PATH! });
    vaultReady = true;
    console.log(
      `⚠️  Vault loaded after timeout (may still be syncing): ${VAULT_PATH}`,
    );
    return;
  }

  console.error(
    `❌  Vault path ${VAULT_PATH} did not appear within ${SYNC_WAIT_TIMEOUT}s`,
  );
  process.exit(1);
}

function isAuthorizedRequest(req: express.Request): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;

  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);

  if (
    headerBuf.length === expectedBuf.length &&
    timingSafeEqual(headerBuf, expectedBuf)
  ) {
    return true;
  }

  return false;
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (isAuthorizedRequest(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function auditLog(action: string, path: string, ip?: string) {
  const ts = new Date().toISOString();
  const src = ip ? ` from ${ip}` : "";
  console.log(`[audit] ${ts} ${action}: ${path}${src}`);
}

const rateLimitWindow = 60_000; // 1 minute
const rateLimitMax = 100; // max requests per window
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimitMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + rateLimitWindow };
    requestCounts.set(ip, entry);
  }

  entry.count++;
  if (entry.count > rateLimitMax) {
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}, 60_000);

function requireVault(): ObsidianVault {
  if (!vaultReady) {
    throw new Error(
      "Vault not yet synced — waiting for Obsidian Sync to complete initial download.",
    );
  }
  return vault;
}

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "obsidian-mcp",
      version: "1.0.0",
    },
    {
      instructions:
        "When modifying existing notes, ALWAYS use edit_note for targeted changes (adding a section, updating a paragraph, fixing a detail). " +
        "Only use write_note when creating brand-new notes or when the user explicitly asks you to rewrite an entire file from scratch. " +
        "Using write_note to overwrite an existing note risks losing content, formatting, and specific examples that the user carefully curated. " +
        "When the user says 'take notes on this' or 'update my style guide,' that means append or edit, not rewrite.",
    },
  );

  server.tool(
    "list_notes",
    "List all markdown notes in the vault, optionally filtered to a folder",
    {
      folder: z
        .string()
        .optional()
        .describe("Subfolder path relative to vault root"),
    },
    async ({ folder }) => {
      const v = requireVault();
      const notes = await v.listNotes(folder);
      return {
        content: [
          { type: "text", text: notes.join("\n") || "(no notes found)" },
        ],
      };
    },
  );

  server.tool(
    "read_note",
    "Read the full content and frontmatter of a note",
    {
      path: z
        .string()
        .describe(
          'Path to note relative to vault root, e.g. "Journal/2025-01-01.md"',
        ),
    },
    async ({ path }) => {
      const note = await requireVault().readNote(path);
      const fmStr =
        Object.keys(note.frontmatter).length > 0
          ? `---\n${JSON.stringify(note.frontmatter, null, 2)}\n---\n\n`
          : "";
      return {
        content: [{ type: "text", text: fmStr + note.content }],
      };
    },
  );

  server.tool(
    "write_note",
    "Create a new note or fully replace an existing one. For modifying parts of an existing note, prefer edit_note (search-and-replace) or append_note instead — they are safer because they only touch the targeted text. Set overwrite: true to replace an existing note (a backup is created automatically).",
    {
      path: z.string().describe("Path relative to vault root"),
      content: z.string().describe("Markdown content (excluding frontmatter)"),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe("Optional YAML frontmatter as a JSON object"),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Must be true to overwrite an existing note. A .bak backup is created automatically.",
        ),
    },
    async ({ path, content, frontmatter, overwrite }, extra) => {
      const result = await requireVault().writeNote(
        path,
        content,
        frontmatter as Record<string, unknown> | undefined,
        { overwrite },
      );
      auditLog(result.created ? "CREATE" : "UPDATE", path, extra.sessionId);
      return {
        content: [
          {
            type: "text",
            text: result.created
              ? `✅ Created: ${result.path}`
              : `✅ Updated: ${result.path}` +
                (result.backedUp ? ` (backup: ${result.backupPath})` : ""),
          },
        ],
      };
    },
  );

  server.tool(
    "upload_attachment",
    "Upload a binary file (image, PDF, etc.) to the vault from base64-encoded data.",
    {
      path: z
        .string()
        .describe('Path relative to vault root (e.g. "attachments/photo.png")'),
      data: z.string().describe("Base64-encoded file content"),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe("Must be true to overwrite an existing file"),
    },
    async ({ path: filePath, data, overwrite }, extra) => {
      const v = requireVault();
      const buffer = Buffer.from(data, "base64");
      const result = await v.uploadAttachment(filePath, buffer, { overwrite });

      auditLog("UPLOAD", filePath, extra.sessionId);
      return {
        content: [
          {
            type: "text",
            text: `✅ Uploaded: ${result.path} (${result.bytes} bytes)`,
          },
        ],
      };
    },
  );

  server.tool(
    "append_note",
    "Append content to the end of an existing note",
    {
      path: z.string().describe("Path relative to vault root"),
      content: z.string().describe("Text to append"),
    },
    async ({ path, content }, extra) => {
      await requireVault().appendNote(path, content);
      auditLog("APPEND", path, extra.sessionId);
      return {
        content: [{ type: "text", text: `✅ Appended to ${path}` }],
      };
    },
  );

  server.tool(
    "edit_note",
    "Search and replace text within a note. To insert new content, include surrounding text in old_text and add the new content in new_text. The old_text must appear exactly once. Backup created automatically.",
    {
      path: z
        .string()
        .describe(
          'Path to note relative to vault root, e.g. "Projects/todo.md"',
        ),
      old_text: z
        .string()
        .describe(
          "Exact text to find (must appear exactly once). Include surrounding context to make it unique. For insertions, include the text before and after where you want to insert.",
        ),
      new_text: z
        .string()
        .describe(
          "Replacement text. For insertions, include the original surrounding text with the new content added. Use empty string to delete.",
        ),
    },
    async ({ path, old_text, new_text }, extra) => {
      const result = await requireVault().editNote(path, old_text, new_text);
      auditLog("EDIT", path, extra.sessionId);
      return {
        content: [
          {
            type: "text",
            text:
              `✅ Edited: ${result.path}` +
              (result.backedUp ? ` (backup: ${result.backupPath})` : ""),
          },
        ],
      };
    },
  );

  server.tool(
    "search_vault",
    "Full-text search ranked by BM25 with fuzzy matching, prefix matching, and field boosting (title > tags > headings > path > body). Supports Obsidian-style operators inside `query`: `tag:foo` (filter to notes tagged foo, frontmatter or inline #foo), `path:bar` (path contains bar), `file:baz` (filename contains baz), `\"exact phrase\"` (must contain phrase verbatim), `-term` (exclude notes containing term). Operators combine with the structured `tags`/`frontmatter`/`folder` args (all applied additively). Pass an empty `query` with filters set to browse by metadata.",
    {
      query: z
        .string()
        .describe(
          'Search string. Plain words use fuzzy + prefix BM25 ranking. Operators: tag:foo, path:bar, file:baz, "exact phrase", -exclude. Empty string returns all notes matching the structured filters.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'Filter to notes with ALL these tags (e.g. ["finance", "budget"]). Applied alongside any tag: operators in the query.',
        ),
      frontmatter: z
        .record(z.string())
        .optional()
        .describe('Filter by frontmatter fields (e.g. {"status": "draft"})'),
      folder: z.string().optional().describe("Limit search to this folder"),
      caseSensitive: z.boolean().optional().default(false),
      fuzzy: z
        .boolean()
        .optional()
        .default(true)
        .describe("Allow fuzzy matches on free-text terms (typo tolerance)."),
      maxResults: z.number().optional().default(20),
    },
    async ({
      query,
      tags,
      frontmatter,
      folder,
      caseSensitive,
      fuzzy,
      maxResults,
    }) => {
      const results = await requireVault().searchVault(query, {
        folder,
        tags,
        frontmatter,
        caseSensitive,
        fuzzy,
        maxResults,
      });
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results for "${query}"${tags ? ` tags:[${tags.join(",")}]` : ""}`,
            },
          ],
        };
      }
      const formatted = results
        .map((r) => {
          const header = `**${r.path}** (score: ${r.score})`;
          if (r.matches.length === 0) return header;
          const matchLines = r.matches
            .map((m) => {
              const sectionLine = m.heading ? `  § ${m.heading}` : null;
              const body =
                m.context && m.context.length > 0
                  ? m.context
                      .map((c) => {
                        const prefix = c === m.text ? `> L${m.line}:` : `  ...`;
                        return `  ${prefix} ${c}`;
                      })
                      .join("\n")
                  : `  L${m.line}: ${m.text}`;
              return sectionLine ? `${sectionLine}\n${body}` : body;
            })
            .join("\n");
          return `${header}\n${matchLines}`;
        })
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    },
  );

  server.tool(
    "find_backlinks",
    "Find notes that link to a given note via Obsidian wikilinks ([[Note]], [[Note|alias]], [[Note#heading]], [[Note#^block]]). Resolves by basename — `Projects/Foo.md` and a bare `[[Foo]]` from anywhere in the vault both match.",
    {
      path: z
        .string()
        .describe(
          'Target note path (e.g. "Projects/Foo.md"). Matched by basename, so the path does not need to exist.',
        ),
      maxResults: z.number().optional().default(50),
    },
    async ({ path, maxResults }) => {
      const hits = await requireVault().findBacklinks(path, { maxResults });
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `No backlinks to "${path}".` }],
        };
      }
      const formatted = hits
        .map((h) => {
          const lines = h.occurrences
            .map((o) => `  L${o.line}: ${o.text}`)
            .join("\n");
          return `**${h.path}** (${h.occurrences.length})\n${lines}`;
        })
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    },
  );

  server.tool(
    "list_tags",
    "List all tags used in the vault and which notes use each tag. Useful for discovering what topics exist before searching.",
    {},
    async () => {
      const tags = await requireVault().listTags();
      const entries = Object.entries(tags);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No tags found." }] };
      }
      const formatted = entries
        .map(
          ([tag, paths]) =>
            `#${tag} (${paths.length})\n${paths.map((p) => `  - ${p}`).join("\n")}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text: formatted }] };
    },
  );

  server.tool(
    "get_sync_status",
    "Check Obsidian Sync status — conflicts, recently modified files, and sync log",
    {},
    async () => {
      const status = await requireVault().getSyncStatus();

      const lines: string[] = [];

      lines.push(`## Vault Stats`);
      lines.push(`- Notes: ${status.vaultStats.totalNotes}`);
      lines.push(`- Total files: ${status.vaultStats.totalFiles}`);
      lines.push("");

      if (status.conflicts.length > 0) {
        lines.push(`## ⚠️ Conflict Files (${status.conflicts.length})`);
        status.conflicts.forEach((c) => lines.push(`  - ${c}`));
      } else {
        lines.push("## ✅ No Conflict Files");
      }
      lines.push("");

      if (status.recentlyModified.length > 0) {
        lines.push(`## Recently Modified (last 15 min)`);
        status.recentlyModified.forEach((f) =>
          lines.push(
            `  - ${f.path} — ${new Date(f.modified).toLocaleTimeString()}`,
          ),
        );
      } else {
        lines.push("## Recently Modified (last 15 min)\n  (none)");
      }
      lines.push("");

      if (status.syncLogSnippet) {
        lines.push(`## Sync Log (${status.syncLogPath})`);
        lines.push("```");
        lines.push(status.syncLogSnippet);
        lines.push("```");
      } else {
        lines.push(
          "## Sync Log\n  Not found. Obsidian may not be running or log path differs.",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

const app = express();

// ─── Origin Validation ────────────────────────────────────────────────────────
// The MCP spec (2025-03-26, §Streamable HTTP) requires servers to validate the
// Origin header to prevent DNS rebinding attacks. Registered first so invalid
// origins are rejected before auth or rate-limit processing.

const allowedOriginHostnames = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  ...ALLOWED_ORIGINS,
]);

function originCheckMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const origin = req.headers.origin;
  // No Origin header → non-browser client (CLI, MCP SDK, etc.) — allow.
  if (!origin) return next();

  try {
    const { hostname } = new URL(origin);
    if (allowedOriginHostnames.has(hostname) || hostname.endsWith(".ts.net")) {
      return next();
    }
  } catch {
    // Malformed Origin — fall through to reject
  }

  res.status(403).json({ error: "Forbidden: origin not allowed" });
}

app.use(originCheckMiddleware);

// #6: Body size limit for non-SSE routes
app.use("/health", express.json({ limit: MAX_BODY_SIZE }));

// #3: Rate limiting on all authenticated routes
app.use(rateLimitMiddleware);

// Health check stays unauthenticated for platform probes, but detailed vault
// metadata is only returned to authorized callers.
app.get("/health", async (req, res) => {
  const includeDetails = isAuthorizedRequest(req);
  const health: Record<string, unknown> = {
    status: vaultReady ? "ok" : "waiting_for_sync",
    server: "obsidian-mcp",
  };

  if (!includeDetails) {
    res.json(health);
    return;
  }

  const uptimeMs = Date.now() - startTime;
  const uptimeMin = Math.floor(uptimeMs / 60_000);
  health.vaultExists = existsSync(VAULT_PATH!);
  health.uptime = `${uptimeMin}m`;

  if (vaultReady) {
    try {
      const mdFiles = await glob("**/*.md", {
        cwd: VAULT_PATH!,
        ignore: ["**/.obsidian/**", "**/.trash/**"],
        stat: true,
        withFileTypes: true,
      });
      health.noteCount = mdFiles.length;

      // Find most recently modified file for sync freshness
      // glob with stat:true already has stat info, no extra syscalls needed
      let latestMtime = 0;
      for (const f of mdFiles) {
        const mtime = f.mtimeMs ?? 0;
        if (mtime > latestMtime) latestMtime = mtime;
      }
      if (latestMtime > 0) {
        health.lastModified = new Date(latestMtime).toISOString();
      }
    } catch {
      health.noteCount = "unavailable";
    }
  }

  res.json(health);
});

// SSE transport — one connection per client, each with its own McpServer
const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", authMiddleware, async (req, res) => {
  console.log(`→ SSE connection from ${req.ip}`);
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  const sessionServer = createServer();

  res.on("close", () => {
    console.log(`← SSE disconnected: ${transport.sessionId}`);
    delete transports[transport.sessionId];
    sessionServer.close().catch(() => {});
  });

  await sessionServer.connect(transport);
});

// NOTE: do NOT use express.json() here — SSEServerTransport.handlePostMessage
// reads the raw request body stream directly.
app.post("/messages", authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error(
      `[messages] Error handling message for session ${sessionId}:`,
      (err as Error).message,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// #7: Bind to loopback by default. Set BIND_ADDRESS=0.0.0.0 to expose externally.
app.listen(PORT, BIND_ADDRESS, () => {
  const authStatus = AUTH_TOKEN
    ? "Bearer token enabled"
    : ALLOW_UNAUTHENTICATED_NON_LOOPBACK
      ? "None (explicitly allowed on non-loopback)"
      : "None (loopback-only mode)";

  console.log(`\n🟢  obsidian-mcp running`);
  console.log(`   Bind     : ${BIND_ADDRESS}`);
  console.log(`   Port     : ${PORT}`);
  console.log(`   Vault    : ${VAULT_PATH}`);
  console.log(`   Auth     : ${authStatus}`);
  console.log(`   Max body : ${MAX_BODY_SIZE}`);
  console.log(`   SSE URL  : http://${BIND_ADDRESS}:${PORT}/sse`);
  console.log("");

  // Initialize vault after the HTTP server is listening.
  // This ensures /health responds during the sync wait period (important for Fly.io health checks).
  waitForVault().catch((err) => {
    console.error("❌  Failed to initialize vault:", err);
    process.exit(1);
  });
});
