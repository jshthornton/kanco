import type Database from "better-sqlite3";
import { DEFAULT_COLUMNS } from "@kanco/shared";
import { nanoid } from "nanoid";

const MIGRATIONS: { id: string; up: (db: Database.Database) => void }[] = [
  {
    id: "0001_init",
    up(db) {
      db.exec(`
        CREATE TABLE spaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE columns (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position REAL NOT NULL
        );
        CREATE INDEX idx_columns_space ON columns(space_id, position);

        CREATE TABLE tickets (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT,
          parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
          position REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          external_ref TEXT,
          manual_override_until INTEGER
        );
        CREATE INDEX idx_tickets_space ON tickets(space_id);
        CREATE INDEX idx_tickets_column ON tickets(column_id, position);
        CREATE INDEX idx_tickets_parent ON tickets(parent_ticket_id);

        CREATE TABLE ticket_pr_links (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          state TEXT NOT NULL,
          title TEXT,
          url TEXT NOT NULL,
          head_sha TEXT,
          last_synced_at INTEGER,
          UNIQUE(ticket_id, owner, repo, number)
        );
        CREATE INDEX idx_pr_links_ticket ON ticket_pr_links(ticket_id);
        CREATE INDEX idx_pr_links_sync ON ticket_pr_links(last_synced_at);

        CREATE TABLE space_repos (
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          PRIMARY KEY (space_id, owner, repo)
        );

        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY,
          ticket_id TEXT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX idx_audit_ticket ON audit_log(ticket_id, at);

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE gh_tokens (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token_enc TEXT NOT NULL,
          refresh_token_enc TEXT,
          expires_at INTEGER,
          refresh_expires_at INTEGER,
          scope TEXT,
          login TEXT
        );
      `);
    },
  },
  {
    id: "0002_device_sessions",
    up(db) {
      db.exec(`
        CREATE TABLE device_sessions (
          session_id TEXT PRIMARY KEY,
          device_code TEXT NOT NULL,
          user_code TEXT NOT NULL,
          verification_uri TEXT NOT NULL,
          interval_s INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT
        );
      `);
    },
  },
  {
    id: "0003_tickets_done_at",
    up(db) {
      db.exec(`ALTER TABLE tickets ADD COLUMN done_at INTEGER`);
      // Best-effort backfill: for any ticket currently in a "Done" column,
      // seed done_at from updated_at so the 2-week filter has something to
      // work with on existing data.
      db.exec(`
        UPDATE tickets
           SET done_at = updated_at
         WHERE column_id IN (SELECT id FROM columns WHERE name = 'Done')
           AND done_at IS NULL
      `);
    },
  },
  {
    id: "0004_closed_column",
    up(db) {
      // Add a "Closed" column to every existing space that doesn't have one.
      // Hidden from the board; used as the terminal state for abandoned PRs.
      const spaces = db.prepare(`SELECT id FROM spaces`).all() as { id: string }[];
      const has = db.prepare(
        `SELECT 1 FROM columns WHERE space_id = ? AND name = 'Closed' LIMIT 1`,
      );
      const insert = db.prepare(
        `INSERT INTO columns (id, space_id, name, position) VALUES (?, ?, 'Closed', 6)`,
      );
      for (const s of spaces) {
        if (has.get(s.id)) continue;
        insert.run(nanoid(12), s.id);
      }
    },
  },
  {
    id: "0005_spaces_repo_root",
    up(db) {
      db.exec(`ALTER TABLE spaces ADD COLUMN repo_root TEXT`);
    },
  },
  {
    id: "0006_agent_sessions",
    up(db) {
      db.exec(`
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          worktree_path TEXT,
          branch TEXT,
          cwd TEXT NOT NULL,
          pid INTEGER,
          status TEXT NOT NULL,
          exit_code INTEGER,
          log_path TEXT NOT NULL,
          prompt TEXT NOT NULL,
          include_parent INTEGER NOT NULL DEFAULT 0,
          used_worktree INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE INDEX idx_agent_sessions_ticket ON agent_sessions(ticket_id);
        CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
      `);
    },
  },
  {
    id: "0007_agent_sessions_session_id",
    up(db) {
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN agent_session_id TEXT`);
    },
  },
  {
    id: "0008_spaces_dolt_remote",
    up(db) {
      db.exec(`ALTER TABLE spaces ADD COLUMN dolt_remote_url TEXT`);
    },
  },
  {
    id: "0009_agent_sessions_bead_id",
    up(db) {
      // Rebuild agent_sessions to:
      //  - allow ticket_id to be NULL (FK to tickets stays — references-only)
      //  - add bead_id (no FK; beads live in external Dolt store)
      //  - require at least one of ticket_id / bead_id via CHECK
      db.exec(`
        CREATE TABLE agent_sessions_new (
          id TEXT PRIMARY KEY,
          ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
          bead_id TEXT,
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          agent_session_id TEXT,
          worktree_path TEXT,
          branch TEXT,
          cwd TEXT NOT NULL,
          pid INTEGER,
          status TEXT NOT NULL,
          exit_code INTEGER,
          log_path TEXT NOT NULL,
          prompt TEXT NOT NULL,
          include_parent INTEGER NOT NULL DEFAULT 0,
          used_worktree INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          CHECK (ticket_id IS NOT NULL OR bead_id IS NOT NULL)
        );
        INSERT INTO agent_sessions_new
          (id, ticket_id, bead_id, space_id, agent, agent_session_id, worktree_path, branch,
           cwd, pid, status, exit_code, log_path, prompt, include_parent, used_worktree,
           started_at, ended_at)
        SELECT
          id, ticket_id, NULL, space_id, agent, agent_session_id, worktree_path, branch,
          cwd, pid, status, exit_code, log_path, prompt, include_parent, used_worktree,
          started_at, ended_at
        FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
        CREATE INDEX idx_agent_sessions_ticket ON agent_sessions(ticket_id);
        CREATE INDEX idx_agent_sessions_bead ON agent_sessions(bead_id);
        CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
      `);
    },
  },
];

export function runMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
  const applied = new Set(
    db.prepare(`SELECT id FROM _migrations`).all().map((r) => (r as { id: string }).id),
  );
  const insert = db.prepare(`INSERT INTO _migrations (id, at) VALUES (?, ?)`);
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(m.id, Date.now());
    })();
  }
}

export function seedDefaultColumnsForSpace(db: Database.Database, spaceId: string) {
  const stmt = db.prepare(
    `INSERT INTO columns (id, space_id, name, position) VALUES (?, ?, ?, ?)`,
  );
  for (const c of DEFAULT_COLUMNS) {
    stmt.run(nanoid(12), spaceId, c.name, c.position);
  }
}
