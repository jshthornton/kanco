---
name: kanco
description: Use the kanco MCP to track work on a kanban board. Create a Todo ticket as soon as you accept a task, move it to Planning while you scope, In Progress when you start coding, link the PR when you open one, and let kanco auto-move it to In Review and Done based on GitHub PR state. Split parallel streams of work into subtasks.
---

# kanco — agent workflow

kanco is a local-first kanban board that exposes an MCP server. As an agent, you
drive your own card across the board so the human can see what you are doing.
Column transitions after the PR is linked are **automatic** — do not move the
ticket yourself once a PR exists.

## The columns

| Column        | Who moves it                                          |
| ------------- | ----------------------------------------------------- |
| Todo          | You, when the task is accepted                        |
| Planning      | You, while scoping / designing                        |
| In Progress   | You, when you start writing code                      |
| In Review     | **kanco**, when the linked PR is open (non-draft)     |
| Done          | **kanco**, when the linked PR is merged               |

A manual move suppresses PR-driven auto-transitions for 1 hour, so only move
manually when you genuinely need to override.

## Tools

All tools are exposed by the `kanco` MCP server (default
`http://localhost:8787/mcp`).

| Tool             | Use it for                                                                   |
| ---------------- | ---------------------------------------------------------------------------- |
| `list_spaces`    | Find the space (board) to work in                                            |
| `create_space`   | Create a new board if none fits                                              |
| `list_tickets`   | Find an existing ticket; optionally filter by `column`                       |
| `get_ticket`     | Read a ticket with its PR links and subtasks                                 |
| `create_ticket`  | Create a Todo ticket (or pass `column` / `parent_ticket_id`)                 |
| `create_subtask` | Split a separate stream of work off the parent ticket                        |
| `update_ticket`  | Refine the title or body as you learn more                                   |
| `move_ticket`    | Move by column **name** — counts as a manual override                        |
| `link_pr`        | Attach a GitHub PR; kanco then drives the column from PR state               |
| `unlink_pr`      | Detach a PR link                                                             |

## Workflow — follow this every task

### 1. Accept the task → create a Todo ticket immediately

The moment you understand what is being asked, call `create_ticket` with a
clear title and a body that captures the ask. Do this **before** you start
exploring or designing. The default column is Todo, which is what you want.

If you cannot find a fitting space, call `list_spaces`; create one with
`create_space` only if there is genuinely no home for the work.

### 2. Move to Planning while you scope

When you start exploring the codebase, drafting a plan, or asking
clarifying questions, call `move_ticket` with `column: "Planning"`. Update
the ticket body via `update_ticket` as your understanding firms up — the
human will read this to follow along.

### 3. Move to In Progress when you start coding

The first time you edit code (not just read it), call `move_ticket` with
`column: "In Progress"`.

### 4. Use subtasks for parallel streams of work

If the work naturally splits into independent pieces (e.g. backend +
frontend, or three unrelated refactors), call `create_subtask` for each
piece. Subtasks live under the parent on the board and have their own
columns and PR links. Use them when:

- The pieces ship as separate PRs
- The pieces could be picked up by different agents in parallel
- The parent is too coarse to track state meaningfully

Do **not** create subtasks for trivially small steps — keep them at the
"separate stream" granularity.

### 5. Link the PR as soon as you open one

Right after `gh pr create` (or equivalent), call `link_pr` with the ticket
id and the PR URL. From this point on, **kanco owns the column**:

- Draft PR → ticket stays in **In Progress**
- Open PR (ready for review) → ticket auto-moves to **In Review**
- PR merged → ticket auto-moves to **Done**
- PR closed without merge → ticket auto-moves back to **Todo**

Do not call `move_ticket` after linking unless you explicitly need to
override — manual moves suppress automatic transitions for 1 hour.

If a task spawned subtasks, link each subtask's PR to that subtask, not to
the parent.

## Quick reference

```text
accept task        → create_ticket (Todo)
start scoping      → move_ticket   (Planning)
start coding       → move_ticket   (In Progress)
parallel work      → create_subtask
opened a PR        → link_pr       (kanco drives the rest)
PR ready for review→ (auto: In Review)
PR merged          → (auto: Done)
PR closed unmerged → (auto: Todo)
```

## Notes

- Every MCP mutation is tagged `mcp:<client>` in the audit log and shown on
  the card, so the human sees exactly what you did.
- `move_ticket` and `create_ticket` accept the column **name**
  (case-insensitive), not an id.
- If `link_pr` fails with "invalid PR URL", pass the full
  `https://github.com/owner/repo/pull/N` URL.
