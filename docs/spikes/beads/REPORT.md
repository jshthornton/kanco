# Beads Spike Report

`bd` version 1.0.3 (1b2dd2cb). Spike repo: `/tmp/bd-spike`.

## Summary

| Question | Answer |
|---|---|
| JS/TS SDK? | No. CLI only. `--json` everywhere. |
| Daemon mode? | Not exposed in 1.0.3 top-level. Server mode via `bd init --server` exists but adds infra. **Punt.** |
| Per-repo isolation? | Yes. One `.beads/` per repo. Auto-discovery from cwd. Use `cwd` arg in `execFile`. |
| Single-writer? | Embedded Dolt. Concurrent writes contend. **Per-space PQueue concurrency=1 still required.** |
| Greenfield init? | `bd init` is **invasive** (writes AGENTS.md, CLAUDE.md, `.claude/settings.json`, git hooks). Prefer `bd bootstrap` or `bd init --stealth` for kanco-managed repos. |
| Auto-export JSONL | After each write, `bd` auto-exports to `.beads/issues.jsonl` (60s throttle). Useful read path; we can also call `bd export` ad-hoc. |

## Status enum (built-in)

```
open          [active]  default
in_progress   [wip]     populates `started_at`
blocked       [wip]
deferred      [frozen]
closed        [done]    populates `closed_at`
pinned        [frozen]
hooked        [wip]     attached to agent hook
```

Custom statuses possible via `bd config set status.custom`. Kanco assumes built-in only.

## Issue types (built-in)

`task` (default), `bug`, `feature`, `chore`, `epic`, `decision`, `spike`, `story`, `milestone`. Plus internal `gate` (used by `bd gate create`).

## Bead JSON shape (canonical, from `bd show <id> --json`)

```json
[{
  "id": "bd-spike-3de",
  "title": "Spike test bead",
  "description": "...",          // optional
  "status": "in_progress",
  "priority": 2,                  // 0..N, lower is higher
  "issue_type": "task",
  "owner": "joshua.thornton@...",
  "created_at": "2026-05-07T12:03:41Z",
  "created_by": "Joshua Thornton",
  "updated_at": "2026-05-07T12:04:08Z",
  "started_at": "2026-05-07T12:04:08Z",   // present when ever started
  "closed_at":  "...",                     // present when closed
  "dependencies": [ /* downstream Beads (this depends on these) */ ],
  "dependents":   [ /* upstream Beads (these depend on this)   */ ]
}]
```

`bd show` returns an array. `bd list --json` returns an array of summary entries (no deps inline). `bd export` (JSONL) carries `dependencies` inline per line — best graph-view read path.

## Dependencies

CLI: `bd dep add <issue> <depends_on> --type <type>` or `bd link <id1> <id2> --type <type>`.

Types: `blocks` (default), `tracks`, `related`, `parent-child`, `discovered-from`.

In JSON output, edges appear in the `dependencies[]` array with `dependency_type`. Reverse via `dependents[]`.

## Gates

Gates are issues with `issue_type=gate`. They `block` the parent. Closing a gate ≠ closing the parent — parent must be moved separately.

```
bd gate create --type=gh:pr --blocks <bead> --await-id=<pr-number> [--reason "..."]
bd gate resolve <gate-id>
bd gate list [--all] --json
```

Stored fields: `await_type` ∈ `human|timer|gh:run|gh:pr|bead`; `await_id` (string, opaque). For `gh:pr` it's the PR number — **owner/repo not encoded**, so kanco must derive from space config (one space = one repo).

`bd gate check --type=gh:pr` exists — possibly evaluates open gates against external state. Worth investigating in Phase 2 before writing custom poller logic; may already do the work.

## Status updates

```
bd update <id> --status in_progress --json    # populates started_at
bd close <id> --json                           # populates closed_at
bd reopen <id> --json
```

## Sync / Dolt

```
bd dolt remote add origin <url>
bd dolt push    # no-op (with friendly message) when no remote configured
bd dolt pull
```

Push without remote returns 0 with stderr-style note — we should check stdout for "No remote is configured" and treat as success/no-op, not error.

## Init vs bootstrap

`bd init` writes a lot of agent-facing scaffolding to the repo. For kanco-managed repos we want one of:

- `bd init --stealth` — uses `.git/info/exclude` to keep beads files local. Best for kanco-as-frontend.
- `bd bootstrap` — non-destructive setup; clones from remote if `sync.remote` set.

Use `bd bootstrap` when a remote URL is provided to a new space; otherwise `bd init --stealth --non-interactive`.

## Read paths

- **List view:** `bd list --json [--status open|...] [--limit N]`
- **Detail view:** `bd show <id> --json`
- **Graph view:** `bd export` (JSONL, all beads w/ inline deps). Cheap, single subprocess.
- **Ready beads** (no open blockers): `bd ready --json`

## Captured artifacts

- `create-1.json`, `show-1.json`, `show-2.json`, `show-3.json` — bead JSON
- `gate-create.json`, `gate-list.json`, `gate-resolve.txt` — gate JSON
- `list-1.json`, `ready.json` — list outputs
- `dep-add.json`, `update.json` — write outputs
- `export.jsonl` — full JSONL export shape
- `statuses.txt`, `types.txt` — enums
- `help-*.txt` — `--help` outputs for each subcommand

## Decisions captured for Phase 1

1. `BeadsClient.list` → `bd list --json`; `.show` → `bd show <id> --json` (peel array). `.exportAll` → `bd export` (JSONL stream parser) for graph view.
2. Init flow on space create: if `.beads/` absent, run `bd init --stealth --non-interactive` (or `bd bootstrap` when remote provided). Surface stdout/stderr to UI.
3. PR gate worker: list beads with `issue_type=gate`, `status=open`, `await_type=gh:pr`, then for each, fetch PR via existing `gql.ts` using space's repo coords + `await_id` PR number. On merged → `bd gate resolve <gate-id>` then `bd close <blocked-bead>`. **Investigate `bd gate check --type=gh:pr` first** — may obviate custom code.
4. Auto-push: log "No remote configured" responses as info, not error. Real failures (network/auth) → SSE error event.
5. Per-space PQueue concurrency=1 still required despite Dolt server auto-start; embedded mode doesn't tolerate concurrent writers.
6. Daemon mode deferred — not surfaced in 1.0.3 CLI.
