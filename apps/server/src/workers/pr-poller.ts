import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";
import { listStaleLinks, updatePrLinkState } from "../services/pr-links.js";
import { getTicket, moveTicket, writeAudit } from "../services/tickets.js";
import { listColumns } from "../services/spaces.js";
import { listTicketPrLinks } from "../services/tickets.js";
import { planTransition } from "../services/transitions.js";

const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 60_000;

export function startPoller(db: DB, gql: GqlClient): () => void {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await runOnce(db, gql);
    } catch (err) {
      console.error("[pr-poller] tick failed", err);
    }
  }

  const handle = setInterval(tick, POLL_INTERVAL_MS);
  // kick off one immediately so first boot isn't empty for 60s
  void tick();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export async function runOnce(db: DB, gql: GqlClient): Promise<void> {
  if (!gql.isConfigured()) return;
  const links = listStaleLinks(db, STALE_AFTER_MS);
  for (const link of links) {
    try {
      const info = await gql.fetchPullRequest(link.owner, link.repo, link.number);
      if (!info) {
        // Couldn't read the PR (private repo / missing scope / network) — bump
        // last_synced_at so we don't hot-loop, but still attempt a transition
        // based on whatever state we have on the link.
        updatePrLinkState(db, link.id, { state: link.state });
        maybeTransition(db, link.ticket_id);
        continue;
      }
      const changed = info.state !== link.state;
      updatePrLinkState(db, link.id, {
        state: info.state,
        title: info.title,
        head_sha: info.headRefOid,
      });
      if (changed) {
        writeAudit(db, link.ticket_id, "pr.state_changed", {
          url: link.url,
          from: link.state,
          to: info.state,
        });
      }
      maybeTransition(db, link.ticket_id);
    } catch (err) {
      console.error(`[pr-poller] ${link.owner}/${link.repo}#${link.number} failed`, err);
    }
  }
}

export function maybeTransition(db: DB, ticket_id: string): void {
  const ticket = getTicket(db, ticket_id);
  if (!ticket) return;
  const links = listTicketPrLinks(db, ticket_id);
  const columns = listColumns(db, ticket.space_id);
  const plan = planTransition({ ticket, links, columns, now: Date.now() });
  if (!plan) return;
  // Place at end of destination column
  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM tickets WHERE column_id = ?`)
    .get(plan.to_column_id) as { m: number };
  moveTicket(db, {
    id: ticket_id,
    column_id: plan.to_column_id,
    position: maxPos.m + 1,
    manual: false,
  });
  writeAudit(db, ticket_id, "ticket.auto_moved", {
    from: plan.from_column_id,
    to: plan.to_column_id,
    reason: plan.reason,
  });
}
