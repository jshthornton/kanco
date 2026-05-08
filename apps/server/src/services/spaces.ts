import type { DB } from "../db/client.js";
import { nanoid } from "nanoid";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { seedDefaultColumnsForSpace } from "../db/migrations.js";

const execFileP = promisify(execFile);
import type { Space, Column } from "@kanco/shared";
import { emitChange } from "../events.js";
import { getBeadsClient } from "./beads/client.js";
import { schedulePush } from "./beads/auto-push.js";

function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  // git@github.com:owner/repo(.git)?  OR  https://github.com/owner/repo(.git)?
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1]!, repo: https[2]! };
  return null;
}

async function gitRemoteRepo(
  repoRoot: string,
): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoRoot, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 5000 },
    );
    return parseGithubRemote(stdout.trim());
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "space";
}

export function listSpaces(db: DB): Space[] {
  return db.prepare(`SELECT * FROM spaces ORDER BY created_at ASC`).all() as Space[];
}

export function getSpace(db: DB, id: string): Space | null {
  return (db.prepare(`SELECT * FROM spaces WHERE id = ?`).get(id) as Space) ?? null;
}

export function getSpaceBySlug(db: DB, slug: string): Space | null {
  return (db.prepare(`SELECT * FROM spaces WHERE slug = ?`).get(slug) as Space) ?? null;
}

export function createSpace(
  db: DB,
  name: string,
  repo_root?: string | null,
  dolt_remote_url?: string | null,
): Space {
  const id = nanoid(12);
  let slug = slugify(name);
  let n = 1;
  while (getSpaceBySlug(db, slug)) {
    n += 1;
    slug = `${slugify(name)}-${n}`;
  }
  const created_at = Date.now();
  const repo = repo_root ?? null;
  const remote = dolt_remote_url ?? null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces (id, name, slug, repo_root, dolt_remote_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, slug, repo, remote, created_at);
    seedDefaultColumnsForSpace(db, id);
  })();
  emitChange({ kind: "space.created", space_id: id });
  // Best-effort beads init when a repo path is provided.
  if (repo) {
    void (async () => {
      try {
        const client = getBeadsClient({ spaceId: id, repoPath: repo });
        await client.ensureInitialized();
        if (remote) {
          try {
            await client.doltAddRemote("origin", remote);
          } catch (err) {
            // remote may already be configured — log and continue
            console.warn(`[spaces] add remote for ${id}:`, err);
          }
          schedulePush(client);
        }
      } catch (err) {
        console.error(`[spaces] beads init failed for ${id}:`, err);
      }
    })();
  }
  return { id, name, slug, repo_root: repo, dolt_remote_url: remote, created_at };
}

export function updateSpace(
  db: DB,
  id: string,
  patch: { name?: string; repo_root?: string | null; dolt_remote_url?: string | null },
): Space {
  const s = getSpace(db, id);
  if (!s) throw new Error(`space ${id} not found`);
  const next: Space = {
    ...s,
    name: patch.name ?? s.name,
    repo_root: patch.repo_root === undefined ? s.repo_root : (patch.repo_root || null),
    dolt_remote_url:
      patch.dolt_remote_url === undefined
        ? s.dolt_remote_url ?? null
        : (patch.dolt_remote_url || null),
  };
  db.prepare(
    `UPDATE spaces SET name = ?, repo_root = ?, dolt_remote_url = ? WHERE id = ?`,
  ).run(next.name, next.repo_root, next.dolt_remote_url ?? null, id);
  emitChange({ kind: "space.updated", space_id: id });
  return next;
}

export interface SpaceRepo {
  owner: string;
  repo: string;
}

export async function listSpaceRepos(db: DB, space_id: string): Promise<SpaceRepo[]> {
  const rows = db
    .prepare(`SELECT owner, repo FROM space_repos WHERE space_id = ? ORDER BY owner, repo`)
    .all(space_id) as SpaceRepo[];
  if (rows.length > 0) return rows;
  // Fallback: derive from the repo's git origin so the UI can build PR URLs
  // even if the user never whitelisted a repo for the PR poller.
  const space = getSpace(db, space_id);
  if (!space?.repo_root) return [];
  const derived = await gitRemoteRepo(space.repo_root);
  return derived ? [derived] : [];
}

export function listColumns(db: DB, space_id: string): Column[] {
  return db
    .prepare(`SELECT * FROM columns WHERE space_id = ? ORDER BY position ASC`)
    .all(space_id) as Column[];
}

/** Columns shown on the board — excludes "Closed" (terminal hidden state). */
export function listBoardColumns(db: DB, space_id: string): Column[] {
  return listColumns(db, space_id).filter((c) => c.name !== "Closed");
}

/**
 * Get a beads client bound to a space. Throws if the space has no `repo_root`
 * configured (beads requires a per-repo `.beads/` directory).
 */
export function beadsForSpace(db: DB, space_id: string) {
  const space = getSpace(db, space_id);
  if (!space) throw new Error(`space ${space_id} not found`);
  if (!space.repo_root) {
    const err = new Error(`space ${space_id} has no repo_root configured`);
    (err as Error & { code?: string }).code = "no_repo_root";
    throw err;
  }
  return getBeadsClient({ spaceId: space_id, repoPath: space.repo_root });
}
