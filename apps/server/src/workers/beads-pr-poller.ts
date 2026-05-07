import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";
import { syncAllSpaces } from "../services/beads/pr-sync.js";

const POLL_INTERVAL_MS = 60_000;

export function startBeadsPrPoller(db: DB, gql: GqlClient): () => void {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await syncAllSpaces(db, gql);
    } catch (err) {
      console.error("[beads.pr-poller] tick failed", err);
    }
  }

  const handle = setInterval(tick, POLL_INTERVAL_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
