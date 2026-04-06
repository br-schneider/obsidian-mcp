import 'dotenv/config';
import express from 'express';

// ─── Crash Protection ────────────────────────────────────────────────────────
// Prevent the process from dying on unhandled errors

process.on('uncaughtException', (err) => {
  console.error(`[crash-guard] Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[crash-guard] Unhandled rejection:`, reason);
});
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { VaultBackend } from './backends/index.js';
import { FilesystemBackend, CouchDBBackend } from './backends/index.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const VAULT_SOURCE = process.env.VAULT_SOURCE ?? 'filesystem';
const VAULT_PATH = process.env.VAULT_PATH;
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const BIND_ADDRESS = process.env.BIND_ADDRESS ?? '127.0.0.1'; // #7: default to loopback
const DAILY_NOTE_FOLDER = process.env.DAILY_NOTE_FOLDER ?? 'Journal';
const DAILY_NOTE_FORMAT = process.env.DAILY_NOTE_FORMAT ?? 'YYYY-MM-DD'; // e.g. 'MM-DD-YYYY DayOfWeek'
const AUTH_TOKEN = process.env.AUTH_TOKEN; // optional bearer token
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE ?? '1mb'; // #6: request size limit

// CouchDB config (only used when VAULT_SOURCE=couchdb)
const COUCHDB_URL = process.env.COUCHDB_URL ?? 'http://localhost:5984';
const COUCHDB_DB = process.env.COUCHDB_DB ?? 'obsidian-livesync';
const COUCHDB_USER = process.env.COUCHDB_USER ?? 'admin';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD ?? '';
const COUCHDB_ENCRYPTION_PASSPHRASE = process.env.COUCHDB_ENCRYPTION_PASSPHRASE;
const VAULT_NAME = process.env.VAULT_NAME; // optional, for obsidian:// deep links

let vault: VaultBackend;

async function initVault(): Promise<VaultBackend> {
  if (VAULT_SOURCE === 'couchdb') {
    if (!COUCHDB_PASSWORD) {
      console.error('❌  COUCHDB_PASSWORD env var is required when VAULT_SOURCE=couchdb');
      process.exit(1);
    }
    const backend = new CouchDBBackend({
      url: COUCHDB_URL,
      database: COUCHDB_DB,
      username: COUCHDB_USER,
      password: COUCHDB_PASSWORD,
      encryptionPassphrase: COUCHDB_ENCRYPTION_PASSPHRASE,
      dailyNoteFolder: DAILY_NOTE_FOLDER,
      dailyNoteDateFormat: DAILY_NOTE_FORMAT,
    });
    await backend.init();
    return backend;
  }

  // Default: filesystem
  if (!VAULT_PATH) {
    console.error('❌  VAULT_PATH env var is required when VAULT_SOURCE=filesystem');
    process.exit(1);
  }
  const backend = new FilesystemBackend({
    vaultPath: VAULT_PATH,
    dailyNoteFolder: DAILY_NOTE_FOLDER,
    dailyNoteDateFormat: DAILY_NOTE_FORMAT,
  });
  console.log(`✅  Vault loaded: ${VAULT_PATH}`);
  return backend;
}

try {
  vault = await initVault();
} catch (err) {
  console.error('❌  Failed to initialize vault:', err);
  process.exit(1);
}

// ─── Deep Links ──────────────────────────────────────────────────────────────

const startTime = Date.now();

function makeDeepLink(notePath: string): string {
  if (!VAULT_NAME) return '';
  const file = notePath.replace(/\.md$/, '');
  return `\nobsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(file)}`;
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!AUTH_TOKEN) return next(); // no auth configured → open (rely on network-level security)
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Audit Logger ─────────────────────────────────────────────────────────────
// #8: Log all write/delete operations

function auditLog(action: string, path: string, ip?: string) {
  const ts = new Date().toISOString();
  const src = ip ? ` from ${ip}` : '';
  console.log(`[audit] ${ts} ${action}: ${path}${src}`);
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
// #3: Simple per-IP rate limiting

const rateLimitWindow = 60_000; // 1 minute
const rateLimitMax = 100; // max requests per window
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimitMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + rateLimitWindow };
    requestCounts.set(ip, entry);
  }

  entry.count++;
  if (entry.count > rateLimitMax) {
    res.status(429).json({ error: 'Too many requests. Try again later.' });
    return;
  }

  next();
}

// Clean up stale rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}, 60_000);

// ─── MCP Server Factory ──────────────────────────────────────────────────────
// Each SSE connection gets its own McpServer instance (SDK requirement).

function createServer(): McpServer {
const server = new McpServer({
  name: 'obsidian-mcp',
  version: '1.0.0',
});

// ── list_notes ────────────────────────────────────────────────────────────────
server.tool(
  'list_notes',
  'List all markdown notes in the vault, optionally filtered to a folder',
  { folder: z.string().optional().describe('Subfolder path relative to vault root') },
  async ({ folder }) => {
    const notes = await vault.listNotes(folder);
    return {
      content: [{ type: 'text', text: notes.join('\n') || '(no notes found)' }],
    };
  }
);

// ── read_note ─────────────────────────────────────────────────────────────────
server.tool(
  'read_note',
  'Read the full content and frontmatter of a note',
  { path: z.string().describe('Path to note relative to vault root, e.g. "Journal/2025-01-01.md"') },
  async ({ path }) => {
    const note = await vault.readNote(path);
    const fmStr =
      Object.keys(note.frontmatter).length > 0
        ? `---\n${JSON.stringify(note.frontmatter, null, 2)}\n---\n\n`
        : '';
    return {
      content: [{ type: 'text', text: fmStr + note.content + makeDeepLink(path) }],
    };
  }
);

// ── write_note ────────────────────────────────────────────────────────────────
// #2: Requires overwrite flag for existing notes
server.tool(
  'write_note',
  'Create or update a note. Set overwrite: true to replace an existing note (a backup is created automatically).',
  {
    path: z.string().describe('Path relative to vault root'),
    content: z.string().describe('Markdown content (excluding frontmatter)'),
    frontmatter: z
      .record(z.unknown())
      .optional()
      .describe('Optional YAML frontmatter as a JSON object'),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe('Must be true to overwrite an existing note. A .bak backup is created automatically.'),
  },
  async ({ path, content, frontmatter, overwrite }, extra) => {
    const result = await vault.writeNote(
      path,
      content,
      frontmatter as Record<string, unknown> | undefined,
      { overwrite }
    );
    auditLog(result.created ? 'CREATE' : 'UPDATE', path, extra.sessionId);
    const msg = result.created
      ? `✅ Created: ${result.path}`
      : `✅ Updated: ${result.path}` + (result.backedUp ? ` (backup: ${result.backupPath})` : '');
    return {
      content: [{ type: 'text', text: msg + makeDeepLink(result.path) }],
    };
  }
);

// ── append_note ───────────────────────────────────────────────────────────────
server.tool(
  'append_note',
  'Append content to the end of an existing note',
  {
    path: z.string().describe('Path relative to vault root'),
    content: z.string().describe('Text to append'),
  },
  async ({ path, content }, extra) => {
    await vault.appendNote(path, content);
    auditLog('APPEND', path, extra.sessionId);
    return {
      content: [{ type: 'text', text: `✅ Appended to ${path}` + makeDeepLink(path) }],
    };
  }
);

// ── delete_note ───────────────────────────────────────────────────────────────
// #1: Soft-delete to .trash/ instead of hard unlink
server.tool(
  'delete_note',
  'Move a note to .trash/ (soft delete, recoverable). Use permanent: true to hard-delete.',
  {
    path: z.string().describe('Path relative to vault root'),
    permanent: z.boolean().optional().default(false).describe('If true, permanently deletes instead of moving to .trash/'),
  },
  async ({ path, permanent }, extra) => {
    const result = await vault.deleteNote(path, { permanent });
    auditLog(permanent ? 'DELETE-PERMANENT' : 'DELETE-SOFT', path, extra.sessionId);
    return {
      content: [{
        type: 'text',
        text: permanent
          ? `🗑️ Permanently deleted: ${path}`
          : `🗑️ Moved to trash: ${result.trashPath}`,
      }],
    };
  }
);

// ── search_vault ──────────────────────────────────────────────────────────────
server.tool(
  'search_vault',
  'Full-text search across all notes in the vault',
  {
    query: z.string().describe('Search string'),
    folder: z.string().optional().describe('Limit search to this folder'),
    caseSensitive: z.boolean().optional().default(false),
    maxResults: z.number().optional().default(20),
  },
  async ({ query, folder, caseSensitive, maxResults }) => {
    const results = await vault.searchVault(query, { folder, caseSensitive, maxResults });
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results for "${query}"` }] };
    }
    const formatted = results
      .map(
        r =>
          `**${r.path}**\n` +
          r.matches.map(m => `  L${m.line}: ${m.text}`).join('\n')
      )
      .join('\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  }
);

// ── list_tags ─────────────────────────────────────────────────────────────────
server.tool(
  'list_tags',
  'List all tags used in the vault and which notes use each tag',
  {},
  async () => {
    const tags = await vault.listTags();
    const entries = Object.entries(tags);
    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No tags found.' }] };
    }
    const formatted = entries
      .map(([tag, paths]) => `#${tag} (${paths.length})\n${paths.map(p => `  - ${p}`).join('\n')}`)
      .join('\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  }
);

// ── get_daily_note ────────────────────────────────────────────────────────────
server.tool(
  'get_daily_note',
  'Get today\'s daily note (or a specific date\'s note)',
  {
    date: z
      .string()
      .optional()
      .describe('ISO date string, e.g. "2025-06-15". Defaults to today.'),
  },
  async ({ date }) => {
    const result = await vault.getDailyNote(date);
    if (!result.exists) {
      return {
        content: [
          {
            type: 'text',
            text: `Daily note not found at ${result.path}. Use create_daily_note to create it.`,
          },
        ],
      };
    }
    const note = result.note!;
    const fmStr =
      Object.keys(note.frontmatter).length > 0
        ? `---\n${JSON.stringify(note.frontmatter, null, 2)}\n---\n\n`
        : '';
    return {
      content: [{ type: 'text', text: fmStr + note.content }],
    };
  }
);

// ── create_daily_note ─────────────────────────────────────────────────────────
server.tool(
  'create_daily_note',
  'Create today\'s daily note (or a specific date\'s note) from a template',
  {
    date: z.string().optional().describe('ISO date string. Defaults to today.'),
    template: z
      .string()
      .optional()
      .describe(
        'Note template. Use {{date}} as a placeholder. Defaults to a standard template.'
      ),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe('Overwrite if note already exists'),
  },
  async ({ date, template, overwrite }) => {
    const result = await vault.createDailyNote({ dateStr: date, template, overwrite });
    return {
      content: [
        {
          type: 'text',
          text: result.created
            ? `✅ Created daily note: ${result.path}`
            : `ℹ️ Daily note already exists: ${result.path} (use overwrite: true to replace)`,
        },
      ],
    };
  }
);

// ── get_sync_status ───────────────────────────────────────────────────────────
server.tool(
  'get_sync_status',
  'Check Obsidian Sync status — conflicts, recently modified files, and sync log',
  {},
  async () => {
    const status = await vault.getSyncStatus();

    const lines: string[] = [];

    lines.push(`## Vault Stats`);
    lines.push(`- Notes: ${status.vaultStats.totalNotes}`);
    lines.push(`- Total files: ${status.vaultStats.totalFiles}`);
    lines.push('');

    if (status.conflicts.length > 0) {
      lines.push(`## ⚠️ Conflict Files (${status.conflicts.length})`);
      status.conflicts.forEach(c => lines.push(`  - ${c}`));
    } else {
      lines.push('## ✅ No Conflict Files');
    }
    lines.push('');

    if (status.recentlyModified.length > 0) {
      lines.push(`## Recently Modified (last 15 min)`);
      status.recentlyModified.forEach(f =>
        lines.push(`  - ${f.path} — ${new Date(f.modified).toLocaleTimeString()}`)
      );
    } else {
      lines.push('## Recently Modified (last 15 min)\n  (none)');
    }
    lines.push('');

    if (status.syncLogSnippet) {
      lines.push(`## Sync Log (${status.syncLogPath})`);
      lines.push('```');
      lines.push(status.syncLogSnippet);
      lines.push('```');
    } else {
      lines.push('## Sync Log\n  Not found. Obsidian may not be running or log path differs.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

return server;
}

// ─── HTTP / SSE Express Server ─────────────────────────────────────────────────

const app = express();

// #6: Body size limit for non-SSE routes
app.use('/health', express.json({ limit: MAX_BODY_SIZE }));

// #3: Rate limiting on all authenticated routes
app.use(rateLimitMiddleware);

// Health check (unauthenticated — useful for uptime monitoring)
app.get('/health', async (_req, res) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeMin = Math.floor(uptimeMs / 60_000);
  const health: Record<string, unknown> = {
    status: 'ok',
    server: 'obsidian-mcp',
    backend: VAULT_SOURCE,
    uptime: `${uptimeMin}m`,
  };

  try {
    const notes = await vault.listNotes();
    health.noteCount = notes.length;
  } catch {
    health.noteCount = 'unavailable';
  }

  if (VAULT_SOURCE === 'couchdb') {
    health.couchdbUrl = COUCHDB_URL;
    health.couchdbDatabase = COUCHDB_DB;
  } else {
    health.vault = VAULT_PATH;
  }

  res.json(health);
});

// ─── Streamable HTTP transport (preferred for cloud) ─────────────────────────
// Each session gets its own transport + server pair, keyed by session ID.
const streamableTransports = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.all('/mcp', authMiddleware, async (req, res) => {
  // Check for existing session
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && streamableTransports.has(sessionId)) {
    const { transport } = streamableTransports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session — only POST (initialization) can create one
  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const sessionServer = createServer();
    await sessionServer.connect(transport);

    // Store after connect so sessionId is set
    if (transport.sessionId) {
      streamableTransports.set(transport.sessionId, { transport, server: sessionServer });
    }

    transport.onclose = () => {
      if (transport.sessionId) {
        streamableTransports.delete(transport.sessionId);
        console.log(`← Streamable HTTP session closed: ${transport.sessionId}`);
      }
      sessionServer.close().catch(() => {});
    };

    await transport.handleRequest(req, res);
    return;
  }

  // GET/DELETE without valid session
  res.status(400).json({ error: 'No valid session. Send a POST to initialize.' });
});

// ─── SSE transport (fallback for older clients) ──────────────────────────────
const sseTransports: Record<string, SSEServerTransport> = {};

app.get('/sse', authMiddleware, async (req, res) => {
  console.log(`→ SSE connection from ${req.ip}`);
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;

  const sessionServer = createServer();

  res.on('close', () => {
    console.log(`← SSE disconnected: ${transport.sessionId}`);
    delete sseTransports[transport.sessionId];
    sessionServer.close().catch(() => {});
  });

  await sessionServer.connect(transport);
});

app.post('/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports[sessionId];
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error(`[messages] Error handling message for session ${sessionId}:`, (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// #7: Bind to loopback by default. Set BIND_ADDRESS=0.0.0.0 to expose externally.
app.listen(PORT, BIND_ADDRESS, () => {
  console.log(`\n🟢  obsidian-mcp running`);
  console.log(`   Backend  : ${VAULT_SOURCE}`);
  console.log(`   Bind     : ${BIND_ADDRESS}`);
  console.log(`   Port     : ${PORT}`);
  console.log(`   Vault    : ${VAULT_SOURCE === 'couchdb' ? `${COUCHDB_URL}/${COUCHDB_DB}` : VAULT_PATH}`);
  console.log(`   Daily    : ${DAILY_NOTE_FOLDER}/`);
  console.log(`   Auth     : ${AUTH_TOKEN ? 'Bearer token enabled' : 'None (network-level security only)'}`);
  console.log(`   Max body : ${MAX_BODY_SIZE}`);
  console.log(`   MCP URL  : http://${BIND_ADDRESS}:${PORT}/mcp (Streamable HTTP)`);
  console.log(`   SSE URL  : http://${BIND_ADDRESS}:${PORT}/sse (legacy fallback)`);
  if (!AUTH_TOKEN && BIND_ADDRESS !== '127.0.0.1') {
    console.log(`\n⚠️  WARNING: No AUTH_TOKEN set and binding to ${BIND_ADDRESS}.`);
    console.log(`   Anyone on your network can read/write your vault!`);
    console.log(`   Set AUTH_TOKEN in .env for security.\n`);
  }
  console.log('');
});
