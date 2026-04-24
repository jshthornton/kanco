<p align="center">
  <img src="apps/web/public/logo-wordmark.png" alt="kanco" width="420" />
</p>

<p align="center">A local-first kanban board for agents.</p>

- Drag-and-drop kanban UI (React + dnd-kit + TanStack Router)
- Hono backend with SQLite (better-sqlite3)
- Built-in **MCP server** over HTTP so Claude Code, Codex, and other MCP clients
  can create tickets, create subtasks, and link PRs
- Spawns agent shells **on your host machine** — no container sandboxing
- GitHub device-flow auth via a shared "kanco" GitHub App — no per-user setup
- PR state drives ticket columns:
  - draft PR → **In Progress**
  - open PR → **In Review**
  - merged → **Done**
  - closed-without-merge → **Todo**
  - manual drag wins for 1 hour

## Requirements

- Node.js **20+**
- A C/C++ toolchain on first run (better-sqlite3 falls back to source build on
  exotic platforms): `python3`, `make`, and a C++ compiler. Most prebuilds
  cover macOS / Linux / Windows on x64 + arm64.

## Quick start (npx)

```sh
# Run it — no install, no clone, no docker.
npx kanco
```

Then open http://localhost:8787.

That's it. SQLite + your encrypted GitHub token live in `./kanco-data/`
(relative to wherever you ran the command), so each project gets its own
board if you want — or run it from `~` for a single global board.

To pin a version:

```sh
npx kanco@0.1.0
```

To install globally:

```sh
npm i -g kanco
kanco
```

## Configuration

All config is via environment variables — no config file:

| Variable               | Default            | Purpose |
| ---------------------- | ------------------ | ------- |
| `KANCO_PORT`           | `8787`             | HTTP port |
| `KANCO_HOST`           | `127.0.0.1`        | Bind address. Set to `0.0.0.0` to expose on LAN. |
| `KANCO_DATA_DIR`       | `./kanco-data`     | Where the SQLite DB and encrypted token live. |
| `KANCO_GH_CLIENT_ID`   | (shared kanco App) | Override only if you fork the GitHub App. |
| `KANCO_SECRET`         | random per install | Passphrase for encrypting the on-disk GitHub token. |

Examples:

```sh
# Pick a different port
KANCO_PORT=9000 npx kanco

# Pin the data dir to your home so every shell sees the same board
KANCO_DATA_DIR=~/.kanco npx kanco
```

## Wiring up an MCP client

After starting kanco, point your MCP client at:

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

## Why no Docker?

kanco spawns agent shells on the host so they can run your real toolchain
(node, pnpm, mise, etc.) and touch your real working trees. Wrapping that in
a container fights the use case more than it helps, so we ship a single npm
package that runs natively on Node.

## Hacking on kanco

```sh
git clone https://github.com/jshthornton/kanco
cd kanco
pnpm install
pnpm --filter @kanco/web dev      # Vite dev server on :5173 (proxies /api)
pnpm --filter kanco dev           # backend on :8787 (tsx watch)
pnpm --filter kanco test          # transitions unit tests
pnpm typecheck
```

To produce a publishable build locally:

```sh
pnpm build           # web → apps/server/public, server → apps/server/dist
pnpm --filter kanco pack
```

## Releasing

Releases are cut by GitHub Actions and pushed to npm.

One-time setup (repo owner only):

```sh
# Create an npm automation token at https://www.npmjs.com/settings/<you>/tokens
gh secret set NPM_TOKEN --body "<npm_xxx token>"
```

Cutting a release — two options:

1. **Tag locally**

   ```sh
   cd apps/server
   npm version patch       # or minor / major
   git push --follow-tags
   ```

   The `Publish to npm` workflow runs on the `v*` tag and publishes.

2. **Workflow dispatch**

   `Actions → Publish to npm → Run workflow`, supply a version like `0.2.0`.
   The workflow bumps `apps/server/package.json`, commits, tags, pushes, and
   publishes.

## Hosting your own GitHub App (optional)

The default kanco install talks to the shared `kanco-board` GitHub App via
device flow — no setup needed. If you want your own:

- **Permissions**: Pull requests: Read, Contents: Read, Metadata: Read
- **Enable Device Flow**: on
- **Request user authorization (OAuth) during installation**: on
- **Expire user authorization tokens**: on (kanco refreshes)
- **Webhook**: none (kanco polls every 60s)

Then set `KANCO_GH_CLIENT_ID=Iv23li...` before launching kanco. The client id
is public — device flow needs no client secret.

## Architecture

```
┌──────────── kanco process ───────────┐
│  Node http.Server                    │
│   ├─ /mcp   MCP Streamable HTTP      │
│   ├─ /api   Hono RPC for the UI      │
│   └─ /*     Static SPA (dnd-kit)     │
│                                      │
│  Workers: PR poller (60s)            │
│  SQLite at $KANCO_DATA_DIR/kanco.db  │
│  Agent shells spawned on host        │
└──────────────────────────────────────┘
```

The MCP server and the HTTP API share the same service layer, so agent-driven
changes and UI changes are identical at the data layer. Every mutation from
MCP is tagged `created_by: mcp:<client>` in the audit log and shown on the card.
