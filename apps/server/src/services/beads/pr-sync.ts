import type { DB } from "../../db/client.js";
import type { GqlClient } from "../../github/gql.js";
import type { Bead, Space } from "@kanco/shared";
import { getBeadsClient } from "./client.js";
import { schedulePush } from "./auto-push.js";
import { emitChange } from "../../events.js";

interface RepoCoords {
  owner: string;
  repo: string;
}

/** Resolve owner/repo for a space. Uses first whitelisted repo. */
function repoForSpace(db: DB, space_id: string): RepoCoords | null {
  const row = db
    .prepare(`SELECT owner, repo FROM space_repos WHERE space_id = ? LIMIT 1`)
    .get(space_id) as RepoCoords | undefined;
  return row ?? null;
}

interface PendingGate {
  blockedBead: Bead;
  gateId: string;
  prNumber: number;
}

/**
 * Find every open gh:pr gate that blocks a non-gate bead. Works against
 * `bd export` output where gates are top-level records and deps are in
 * export form (`depends_on_id`).
 */
function listPendingGates(beads: Bead[]): PendingGate[] {
  const gates = beads.filter(
    (b) => b.issue_type === "gate" && b.status === "open" && b.await_type === "gh:pr",
  );
  const out: PendingGate[] = [];
  for (const gate of gates) {
    if (!gate.await_id) continue;
    const num = Number(gate.await_id);
    if (!Number.isFinite(num)) continue;
    // Find blocked bead — the one whose dependencies include this gate id.
    const blocked = beads.find((b) => {
      if (b.issue_type === "gate") return false;
      return (b.dependencies ?? []).some((d) => {
        if ("depends_on_id" in d) return d.depends_on_id === gate.id;
        if ("id" in d) return d.id === gate.id;
        return false;
      });
    });
    if (!blocked) continue;
    out.push({ blockedBead: blocked, gateId: gate.id, prNumber: num });
  }
  return out;
}

export interface PrSyncResult {
  space_id: string;
  checked: number;
  resolved: number;
  errors: number;
}

export async function syncSpacePrGates(
  db: DB,
  gql: GqlClient,
  space: Space,
): Promise<PrSyncResult> {
  if (!space.repo_root) return { space_id: space.id, checked: 0, resolved: 0, errors: 0 };
  const coords = repoForSpace(db, space.id);
  const result: PrSyncResult = { space_id: space.id, checked: 0, resolved: 0, errors: 0 };
  if (!coords) return result;

  const client = getBeadsClient({ spaceId: space.id, repoPath: space.repo_root });
  if (!client.isInitialized()) return result;

  let beads: Bead[];
  try {
    beads = await client.exportAll();
  } catch (err) {
    console.error(`[beads.pr-sync] export failed for ${space.id}`, err);
    result.errors += 1;
    return result;
  }
  const pending = listPendingGates(beads);
  let mutated = false;
  for (const { blockedBead, gateId, prNumber } of pending) {
    result.checked += 1;
    try {
      const info = await gql.fetchPullRequest(coords.owner, coords.repo, prNumber);
      if (!info) continue;
      if (info.state === "merged") {
        await client.resolveGate(gateId);
        await client.close(blockedBead.id);
        result.resolved += 1;
        mutated = true;
        emitChange({
          kind: "bead.changed",
          space_id: space.id,
          bead_id: blockedBead.id,
          payload: { reason: "pr_merged", pr: { ...coords, number: prNumber } },
        });
      } else if (info.state === "closed") {
        // PR closed without merge — resolve gate but leave bead status as-is.
        await client.resolveGate(gateId);
        result.resolved += 1;
        mutated = true;
        emitChange({
          kind: "bead.changed",
          space_id: space.id,
          bead_id: blockedBead.id,
          payload: { reason: "pr_closed", pr: { ...coords, number: prNumber } },
        });
      }
    } catch (err) {
      result.errors += 1;
      console.error(
        `[beads.pr-sync] ${coords.owner}/${coords.repo}#${prNumber} (gate ${gateId}) failed`,
        err,
      );
    }
  }
  if (mutated) schedulePush(client);
  return result;
}

export async function syncAllSpaces(db: DB, gql: GqlClient): Promise<PrSyncResult[]> {
  if (!gql.isConfigured()) return [];
  const spaces = db.prepare(`SELECT * FROM spaces`).all() as Space[];
  const out: PrSyncResult[] = [];
  for (const s of spaces) {
    if (!s.repo_root) continue;
    out.push(await syncSpacePrGates(db, gql, s));
  }
  return out;
}
