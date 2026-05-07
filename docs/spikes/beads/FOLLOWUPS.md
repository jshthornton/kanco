# Beads revamp — follow-ups

The Phase 0–4 work landed the beads frontend (data layer, API, board view,
graph view, MCP tools). Phase 5 cleanup was scoped down because parts of the
legacy ticket model are still load-bearing.

## Deferred (Phase 5+)

1. **Agent sessions → bead IDs.** `agent_sessions.ticket_id` has a FK to
   `tickets`. Beads have hash IDs from `bd`, not nanoid. Need a migration
   strategy: either keep a synthetic local "ticket" row per bead just for
   sessions, or alter `agent_sessions` to store `bead_id` (string, no FK)
   and update `services/sessions.ts` accordingly. Touches MCP tools and the
   agent UI.
2. **Drop legacy services.** Once sessions are migrated, delete:
   - `apps/server/src/services/{tickets.ts,pr-links.ts,transitions.ts,transitions.test.ts}`
   - `apps/server/src/workers/pr-poller.ts` (the beads pr-poller subsumes it)
   - `apps/web/src/routes/spaces.$spaceId.tsx` (replace with redirect to `/beads`)
   - `apps/web/src/routes/tickets.$ticketId.tsx`
   - `apps/web/src/components/{TicketDetail,TicketDrawer}.tsx`
   - Legacy MCP tools (`list_tickets`, `create_ticket`, `move_ticket`,
     `link_pr`, etc.).
   - Legacy SQLite tables in a new migration: `tickets`, `columns`,
     `ticket_pr_links`, `space_repos` (replace with a single `gh_owner`
     /`gh_repo` per space).
3. **Drag-and-drop on the beads board.** First cut uses a status `<select>`
   per card. Wire dnd-kit between status columns to issue `PATCH`s on drop.
4. **`bd gate check --type=gh:pr`.** The CLI may already evaluate `gh:pr`
   gates. If so, replace the kanco-side beads-pr-poller with periodic
   `bd gate check` calls + an audit-log writer. Investigate before
   committing.
5. **Daemon mode.** `bd daemon start --local` was not surfaced in 1.0.3 CLI
   help. Re-evaluate when a release exposes it; we'd avoid per-call
   subprocess overhead.
6. **`bd init` is invasive.** Currently kanco runs `bd init --stealth` so
   the repo isn't polluted with `AGENTS.md`/`CLAUDE.md`/`.claude/settings.json`.
   When users want the full agent scaffolding, expose a flag.
7. **Owner/repo per space.** PR gate sync needs `owner/repo` to call the
   GitHub API. Today we read it from the `space_repos` whitelist (first row).
   When the legacy table is dropped, store these directly on the space row.
8. **Graph view persistence.** Layout is recomputed via dagre on every load.
   No manual node positions. Add later if requested.
