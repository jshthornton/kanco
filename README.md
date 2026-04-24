<p align="center">
  <img src="apps/web/public/logo-wordmark.png" alt="kanco" width="420" />
</p>

<p align="center">A local-first kanban board for agents.</p>

- Drag-and-drop kanban UI (React + dnd-kit + TanStack Router)
- Hono backend with SQLite (better-sqlite3)
- Built-in **MCP server** over HTTP so Claude Code, Codex, and other MCP clients
  can create tickets, create subtasks, and link PRs
- GitHub device-flow auth via a shared "kanco" GitHub App — no per-user App setup
- PR state drives ticket columns:
  - draft PR → **In Progress**
  - open PR → **In Review**
  - merged → **Done**
  - closed-without-merge → **Todo**
  - manual drag wins for 1 hour

## Quick start

```sh
# 1. Point at the kanco GitHub App
export KANCO_GH_CLIENT_ID=Iv23li...

# 2. Run it
docker compose up --build

# 3. Open the board
open http://localhost:8787
```

Data (SQLite + encrypted token) lives in `./kanco-data`.

## Wiring up an MCP client

After starting the container, add this HTTP MCP endpoint to your client:

```
http://localhost:8787/mcp
```

For Claude Code:

```sh
claude mcp add kanco http://localhost:8787/mcp --transport http
```

Tools exposed:

| Tool             | Purpose |
| ---------------- | ------- |
| `list_spaces`    | List boards |
| `create_space`   | Create a new board |
| `list_tickets`   | List tickets (optionally by column name) |
| `get_ticket`     | Fetch one ticket with links and subtasks |
| `create_ticket`  | Create a ticket (defaults to **Todo**) |
| `create_subtask` | Create a subtask under a ticket |
| `update_ticket`  | Update title/body |
| `move_ticket`    | Move by column **name** — counts as a manual move |
| `link_pr`        | Link a PR URL; state drives column |
| `unlink_pr`      | Remove a PR link |

## Development

```sh
pnpm install
pnpm --filter @kanco/server dev   # backend on :8787
pnpm --filter @kanco/web dev      # Vite dev server on :5173 with /api proxy
pnpm --filter @kanco/server test  # transitions unit tests
```

## Hosting the shared GitHub App

If you publish your own `kanco` GitHub App, configure it with:

- **Permissions**: Pull requests: Read, Contents: Read, Metadata: Read
- **Enable Device Flow**: on
- **Request user authorization (OAuth) during installation**: on
- **Expire user authorization tokens**: on (kanco refreshes)
- **Webhook**: none (kanco polls every 60s)

Ship the App's public `client_id` via `KANCO_GH_CLIENT_ID`. No secret needed —
device flow only uses the public client id.

## Architecture

```
┌────────── Docker image ──────────┐
│  Node http.Server                │
│   ├─ /mcp   MCP Streamable HTTP  │
│   ├─ /api   Hono RPC for the UI  │
│   └─ /*     Vite SPA (dnd-kit)   │
│                                  │
│  Workers: PR poller (60s)        │
│  SQLite at /data/kanco.db        │
└──────────────────────────────────┘
```

The MCP server and the HTTP API share the same service layer, so agent-driven
changes and UI changes are identical at the data layer. Every mutation from
MCP is tagged `created_by: mcp:<client>` in the audit log and shown on the card.
