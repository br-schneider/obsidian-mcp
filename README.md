# obsidian-mcp

MCP server that gives AI agents full access to your Obsidian vault. Runs as a standalone Node.js process on the same machine as your vault — no Obsidian plugins required, no Obsidian needing to be open.

## How it works

obsidian-mcp reads and writes your vault's markdown files directly on disk. It exposes them over HTTP/SSE using the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-compatible client (Claude, OpenClaw, Cursor, etc.) can search, read, write, and manage your notes.

**This must run on the machine where your vault lives.** For remote access, use Tailscale or another VPN — see [SETUP.md](./SETUP.md).

```
AI Agent → (network) → obsidian-mcp:3456 → ~/YourVault/
```

## Quick Start

```bash
git clone https://github.com/meimakes/obsidian-mcp.git
cd obsidian-mcp
npm install
npm run build
```

Configure:

```bash
cp .env.example .env
```

Edit `.env` with your vault path:

```env
VAULT_PATH=/Users/yourname/Documents/MyVault
PORT=3456
DAILY_NOTE_FOLDER=Journal    # where your daily notes live
AUTH_TOKEN=                  # optional bearer token
```

Run:

```bash
npm start
```

Verify:

```bash
curl http://localhost:3456/health
# → {"status":"ok","vault":"/Users/yourname/Documents/MyVault","server":"obsidian-mcp"}
```

## Connect to your AI

Point your MCP client to:

```
http://localhost:3456/sse
```

For remote access (e.g. from a VPS or phone), set up Tailscale and use your machine's Tailscale hostname instead of localhost. See [SETUP.md](./SETUP.md) for details.

## Tools (10)

| Tool | What it does |
|------|-------------|
| `list_notes` | List all markdown files, optionally filtered by folder |
| `read_note` | Read a note's content and frontmatter |
| `write_note` | Create or overwrite a note (creates folders as needed) |
| `append_note` | Append text to an existing note |
| `delete_note` | Permanently delete a note |
| `search_vault` | Full-text search across all notes |
| `list_tags` | List all tags and which notes use them |
| `get_daily_note` | Get today's or a specific date's daily note |
| `create_daily_note` | Create a daily note from a template |
| `get_sync_status` | Check for sync conflicts, recently modified files |

## Requirements

- Node.js 20+
- An Obsidian vault (just a folder of markdown files)
- Obsidian does NOT need to be running

## Running persistently

See [SETUP.md](./SETUP.md) for:

- pm2 process management (survives reboots)
- macOS LaunchAgent setup
- Tailscale remote access
- Auth token configuration

## Security

- **Path traversal protection** — all file operations are sandboxed to your vault directory
- **Optional bearer token auth** — set `AUTH_TOKEN` in `.env`
- **No data leaves your machine** — everything runs locally

## License

MIT
