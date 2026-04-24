import type { DB } from "../db/client.js";
import { nanoid } from "nanoid";
import { seedDefaultColumnsForSpace } from "../db/migrations.js";
import type { Space, Column } from "@kanco/shared";
import { emitChange } from "../events.js";

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

export function createSpace(db: DB, name: string, repo_root?: string | null): Space {
  const id = nanoid(12);
  let slug = slugify(name);
  let n = 1;
  while (getSpaceBySlug(db, slug)) {
    n += 1;
    slug = `${slugify(name)}-${n}`;
  }
  const created_at = Date.now();
  const repo = repo_root ?? null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces (id, name, slug, repo_root, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, slug, repo, created_at);
    seedDefaultColumnsForSpace(db, id);
  })();
  emitChange({ kind: "space.created", space_id: id });
  return { id, name, slug, repo_root: repo, created_at };
}

export function updateSpace(
  db: DB,
  id: string,
  patch: { name?: string; repo_root?: string | null },
): Space {
  const s = getSpace(db, id);
  if (!s) throw new Error(`space ${id} not found`);
  const next: Space = {
    ...s,
    name: patch.name ?? s.name,
    repo_root: patch.repo_root === undefined ? s.repo_root : (patch.repo_root || null),
  };
  db.prepare(`UPDATE spaces SET name = ?, repo_root = ? WHERE id = ?`).run(
    next.name,
    next.repo_root,
    id,
  );
  emitChange({ kind: "space.updated", space_id: id });
  return next;
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
