import type { DB } from "../db/client.js";
import { nanoid } from "nanoid";
import { DONE_VISIBILITY_MS, WELL_KNOWN, type Ticket, type TicketPrLink } from "@kanco/shared";
import { listColumns } from "./spaces.js";
import { emitChange } from "../events.js";

export function getTicket(db: DB, id: string): Ticket | null {
  return (db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as Ticket) ?? null;
}

export function listTickets(db: DB, space_id: string): Ticket[] {
  // Hide tickets in the Closed column entirely, and tickets that have been in
  // Done for more than DONE_VISIBILITY_MS.
  const cutoff = Date.now() - DONE_VISIBILITY_MS;
  return db
    .prepare(
      `SELECT t.* FROM tickets t
         JOIN columns c ON c.id = t.column_id
        WHERE t.space_id = ?
          AND c.name <> 'Closed'
          AND (t.done_at IS NULL OR t.done_at >= ?)
        ORDER BY t.column_id, t.position ASC, t.created_at ASC`,
    )
    .all(space_id, cutoff) as Ticket[];
}

function isDoneColumn(db: DB, column_id: string): boolean {
  const row = db.prepare(`SELECT name FROM columns WHERE id = ?`).get(column_id) as
    | { name: string }
    | undefined;
  return row?.name === WELL_KNOWN.DONE;
}

export function listTicketPrLinks(db: DB, ticket_id: string): TicketPrLink[] {
  return db
    .prepare(`SELECT * FROM ticket_pr_links WHERE ticket_id = ?`)
    .all(ticket_id) as TicketPrLink[];
}

export function listSpacePrLinks(db: DB, space_id: string): TicketPrLink[] {
  return db
    .prepare(
      `SELECT l.* FROM ticket_pr_links l JOIN tickets t ON t.id = l.ticket_id WHERE t.space_id = ?`,
    )
    .all(space_id) as TicketPrLink[];
}

export function listSubtasks(db: DB, parent_ticket_id: string): Ticket[] {
  return db
    .prepare(
      `SELECT * FROM tickets WHERE parent_ticket_id = ? ORDER BY created_at ASC`,
    )
    .all(parent_ticket_id) as Ticket[];
}

export interface CreateTicketOpts {
  space_id: string;
  title: string;
  body?: string | null;
  column_name?: string;
  column_id?: string;
  parent_ticket_id?: string | null;
  created_by?: string;
}

export function createTicket(db: DB, opts: CreateTicketOpts): Ticket {
  const id = nanoid(12);
  const now = Date.now();
  const cols = listColumns(db, opts.space_id);
  if (cols.length === 0) {
    throw new Error(`space ${opts.space_id} has no columns`);
  }
  let column_id = opts.column_id;
  if (!column_id) {
    const wanted = opts.column_name ?? "Todo";
    const match = cols.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) ?? cols[0]!;
    column_id = match.id;
  }
  // position: append at end of column
  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM tickets WHERE column_id = ?`)
    .get(column_id) as { m: number };
  const position = maxPos.m + 1;
  const done_at = isDoneColumn(db, column_id) ? now : null;
  db.prepare(
    `INSERT INTO tickets (id, space_id, column_id, title, body, parent_ticket_id, position, created_at, updated_at, created_by, external_ref, manual_override_until, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id,
    opts.space_id,
    column_id,
    opts.title,
    opts.body ?? null,
    opts.parent_ticket_id ?? null,
    position,
    now,
    now,
    opts.created_by ?? "ui",
    done_at,
  );
  writeAudit(db, id, "ticket.created", { column_id, created_by: opts.created_by ?? "ui" });
  emitChange({ kind: "ticket.created", space_id: opts.space_id, ticket_id: id });
  return getTicket(db, id)!;
}

export function updateTicket(
  db: DB,
  id: string,
  patch: { title?: string; body?: string | null },
): Ticket {
  const t = getTicket(db, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const now = Date.now();
  db.prepare(
    `UPDATE tickets SET title = COALESCE(?, title), body = CASE WHEN ? = 1 THEN ? ELSE body END, updated_at = ? WHERE id = ?`,
  ).run(
    patch.title ?? null,
    patch.body !== undefined ? 1 : 0,
    patch.body ?? null,
    now,
    id,
  );
  emitChange({ kind: "ticket.updated", space_id: t.space_id, ticket_id: id });
  return getTicket(db, id)!;
}

export interface MoveTicketOpts {
  id: string;
  column_id: string;
  position: number;
  manual?: boolean;
  /** ms to suppress auto-transitions after a manual move */
  override_ms?: number;
}

const DEFAULT_MANUAL_OVERRIDE_MS = 60 * 60 * 1000;

export function moveTicket(db: DB, opts: MoveTicketOpts): Ticket {
  const t = getTicket(db, opts.id);
  if (!t) throw new Error(`ticket ${opts.id} not found`);
  const now = Date.now();
  const override_until =
    opts.manual === false
      ? t.manual_override_until
      : now + (opts.override_ms ?? DEFAULT_MANUAL_OVERRIDE_MS);
  const movingToDone = isDoneColumn(db, opts.column_id);
  const wasInDone = t.column_id !== opts.column_id && isDoneColumn(db, t.column_id);
  // Stamp done_at when entering Done; clear it when leaving Done. Re-entering
  // Done refreshes the timestamp so the 2-week clock restarts.
  const done_at_sql = movingToDone
    ? "?"
    : wasInDone
      ? "NULL"
      : "done_at";
  const params: (string | number | null)[] = [opts.column_id, opts.position, now, override_until];
  if (movingToDone) params.push(now);
  params.push(opts.id);
  db.prepare(
    `UPDATE tickets SET column_id = ?, position = ?, updated_at = ?, manual_override_until = ?, done_at = ${done_at_sql} WHERE id = ?`,
  ).run(...params);
  if (t.column_id !== opts.column_id) {
    writeAudit(db, opts.id, "ticket.moved", {
      from: t.column_id,
      to: opts.column_id,
      manual: opts.manual !== false,
    });
  }
  emitChange({ kind: "ticket.moved", space_id: t.space_id, ticket_id: opts.id });
  return getTicket(db, opts.id)!;
}



export function deleteTicket(db: DB, id: string): void {
  const t = getTicket(db, id);
  db.prepare(`DELETE FROM tickets WHERE id = ?`).run(id);
  if (t) emitChange({ kind: "ticket.deleted", space_id: t.space_id, ticket_id: id });
}

export function writeAudit(
  db: DB,
  ticket_id: string | null,
  kind: string,
  payload: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_log (id, ticket_id, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(nanoid(12), ticket_id, kind, JSON.stringify(payload), Date.now());
}
