import type { Column, PrState, Ticket, TicketPrLink } from "@kanco/shared";
import { WELL_KNOWN } from "@kanco/shared";

export interface TransitionContext {
  ticket: Ticket;
  links: TicketPrLink[];
  columns: Column[];
  now: number;
}

/**
 * Given a ticket and its PR links, return the column name it should be in.
 * Returns null when there is no opinion (no links, or manual override active).
 *
 * Policy:
 *  - no links → no opinion
 *  - any link merged → Done
 *  - any link open (not draft, not merged, not closed) → In Review
 *  - all links draft → In Progress
 *  - all links closed (none merged) → Todo
 */
export function desiredColumnName(ctx: TransitionContext): string | null {
  if (ctx.ticket.manual_override_until && ctx.ticket.manual_override_until > ctx.now) {
    return null;
  }
  if (ctx.links.length === 0) return null;

  const states = ctx.links.map((l) => l.state);
  if (states.includes("merged")) return WELL_KNOWN.DONE;
  if (states.some((s) => s === "open")) return WELL_KNOWN.IN_REVIEW;
  if (states.every((s) => s === "draft")) return WELL_KNOWN.IN_PROGRESS;
  if (states.every((s) => s === "closed")) return WELL_KNOWN.CLOSED;
  // mixed draft + closed → treat as in progress
  if (states.some((s) => s === "draft")) return WELL_KNOWN.IN_PROGRESS;
  return null;
}

export function resolveColumn(columns: Column[], name: string): Column | null {
  return columns.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export interface TransitionPlan {
  ticket_id: string;
  from_column_id: string;
  to_column_id: string;
  reason: string;
}

export function planTransition(ctx: TransitionContext): TransitionPlan | null {
  const wanted = desiredColumnName(ctx);
  if (!wanted) return null;
  const col = resolveColumn(ctx.columns, wanted);
  if (!col) return null;
  if (col.id === ctx.ticket.column_id) return null;
  return {
    ticket_id: ctx.ticket.id,
    from_column_id: ctx.ticket.column_id,
    to_column_id: col.id,
    reason: `PR states → ${wanted}`,
  };
}

// exposed for testing
export const __test = { desiredColumnName };
export type { PrState };
