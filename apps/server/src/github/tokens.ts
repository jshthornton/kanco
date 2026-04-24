import type { DB } from "../db/client.js";
import { decrypt, encrypt } from "./crypto.js";

export interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  scope: string | null;
  login: string | null;
}

export function saveToken(db: DB, key: Buffer, t: StoredToken): void {
  const access_enc = encrypt(key, t.access_token);
  const refresh_enc = t.refresh_token ? encrypt(key, t.refresh_token) : null;
  db.prepare(
    `INSERT INTO gh_tokens (id, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, scope, login)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       scope = excluded.scope,
       login = excluded.login`,
  ).run(access_enc, refresh_enc, t.expires_at, t.refresh_expires_at, t.scope, t.login);
}

export function loadToken(db: DB, key: Buffer): StoredToken | null {
  const row = db.prepare(`SELECT * FROM gh_tokens WHERE id = 1`).get() as
    | {
        access_token_enc: string;
        refresh_token_enc: string | null;
        expires_at: number | null;
        refresh_expires_at: number | null;
        scope: string | null;
        login: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    access_token: decrypt(key, row.access_token_enc),
    refresh_token: row.refresh_token_enc ? decrypt(key, row.refresh_token_enc) : null,
    expires_at: row.expires_at,
    refresh_expires_at: row.refresh_expires_at,
    scope: row.scope,
    login: row.login,
  };
}

export function clearToken(db: DB): void {
  db.prepare(`DELETE FROM gh_tokens WHERE id = 1`).run();
}

export function getConnectionStatus(db: DB): { connected: boolean; login: string | null } {
  const row = db.prepare(`SELECT login FROM gh_tokens WHERE id = 1`).get() as
    | { login: string | null }
    | undefined;
  return { connected: !!row, login: row?.login ?? null };
}
