import type { DB } from "../db/client.js";
import { nanoid } from "nanoid";
import { parsePrUrl, type TicketPrLink } from "@kanco/shared";
import { writeAudit } from "./tickets.js";
import { emitChange } from "../events.js";

function spaceIdForTicket(db: DB, ticket_id: string): string | undefined {
  const row = db.prepare(`SELECT space_id FROM tickets WHERE id = ?`).get(ticket_id) as
    | { space_id: string }
    | undefined;
  return row?.space_id;
}

export function linkPr(db: DB, ticket_id: string, pr_url: string): TicketPrLink {
  const parsed = parsePrUrl(pr_url);
  if (!parsed) throw new Error(`invalid PR URL: ${pr_url}`);
  const existing = db
    .prepare(
      `SELECT * FROM ticket_pr_links WHERE ticket_id = ? AND owner = ? AND repo = ? AND number = ?`,
    )
    .get(ticket_id, parsed.owner, parsed.repo, parsed.number) as TicketPrLink | undefined;
  if (existing) return existing;
  const id = nanoid(12);
  const url = `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  db.prepare(
    `INSERT INTO ticket_pr_links (id, ticket_id, owner, repo, number, state, title, url, head_sha, last_synced_at)
     VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL)`,
  ).run(id, ticket_id, parsed.owner, parsed.repo, parsed.number, url);
  // A fresh link is an explicit signal that this ticket follows PR state —
  // clear any prior manual freeze so auto-transitions can act immediately.
  db.prepare(`UPDATE tickets SET manual_override_until = NULL WHERE id = ?`).run(ticket_id);
  writeAudit(db, ticket_id, "pr.linked", { url });
  emitChange({ kind: "pr.linked", space_id: spaceIdForTicket(db, ticket_id), ticket_id });
  return db.prepare(`SELECT * FROM ticket_pr_links WHERE id = ?`).get(id) as TicketPrLink;
}

export function unlinkPr(db: DB, link_id: string): void {
  const row = db.prepare(`SELECT * FROM ticket_pr_links WHERE id = ?`).get(link_id) as
    | TicketPrLink
    | undefined;
  if (!row) return;
  db.prepare(`DELETE FROM ticket_pr_links WHERE id = ?`).run(link_id);
  writeAudit(db, row.ticket_id, "pr.unlinked", { url: row.url });
  emitChange({
    kind: "pr.unlinked",
    space_id: spaceIdForTicket(db, row.ticket_id),
    ticket_id: row.ticket_id,
  });
}

export function updatePrLinkState(
  db: DB,
  link_id: string,
  patch: { state: string; title?: string | null; head_sha?: string | null },
): void {
  const before = db.prepare(`SELECT ticket_id, state FROM ticket_pr_links WHERE id = ?`).get(link_id) as
    | { ticket_id: string; state: string }
    | undefined;
  db.prepare(
    `UPDATE ticket_pr_links SET state = ?, title = COALESCE(?, title), head_sha = COALESCE(?, head_sha), last_synced_at = ? WHERE id = ?`,
  ).run(patch.state, patch.title ?? null, patch.head_sha ?? null, Date.now(), link_id);
  if (before && before.state !== patch.state) {
    emitChange({
      kind: "pr.state_changed",
      space_id: spaceIdForTicket(db, before.ticket_id),
      ticket_id: before.ticket_id,
    });
  }
}

export function listStaleLinks(db: DB, olderThanMs: number): TicketPrLink[] {
  const cutoff = Date.now() - olderThanMs;
  return db
    .prepare(
      `SELECT * FROM ticket_pr_links WHERE last_synced_at IS NULL OR last_synced_at < ? ORDER BY last_synced_at ASC NULLS FIRST LIMIT 50`,
    )
    .all(cutoff) as TicketPrLink[];
}
