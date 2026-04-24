import type { DB } from "../db/client.js";
import { saveToken, type StoredToken } from "./tokens.js";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export class GitHubAuthError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg);
  }
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.error === "string") {
    throw new GitHubAuthError(
      String(body.error),
      typeof body.error_description === "string"
        ? String(body.error_description)
        : String(body.error),
    );
  }
  if (!res.ok) {
    throw new GitHubAuthError("device_code_failed", `device code request failed: ${res.status}`);
  }
  return body as unknown as DeviceCodeResponse;
}

export interface PollResult {
  status: "pending" | "slow_down" | "authorized" | "expired" | "denied" | "error";
  token?: StoredToken;
  error?: string;
}

export async function pollOnce(clientId: string, device_code: string): Promise<PollResult> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: "error", error: `non_json_response (${res.status})` };
  }
  if (typeof body.error === "string") {
    switch (body.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down" };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        return { status: "error", error: String(body.error) };
    }
  }
  const access_token = String(body.access_token ?? "");
  if (!access_token) return { status: "error", error: "no access_token returned" };
  const now = Date.now();
  const token: StoredToken = {
    access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expires_at: typeof body.expires_in === "number" ? now + body.expires_in * 1000 : null,
    refresh_expires_at:
      typeof body.refresh_token_expires_in === "number"
        ? now + body.refresh_token_expires_in * 1000
        : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    login: null,
  };
  return { status: "authorized", token };
}

export async function fetchLogin(access_token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { login?: string };
  return body.login ?? null;
}

export async function refreshToken(
  clientId: string,
  refresh_token: string,
): Promise<StoredToken | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.error === "string") return null;
  const access_token = String(body.access_token ?? "");
  if (!access_token) return null;
  const now = Date.now();
  return {
    access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expires_at: typeof body.expires_in === "number" ? now + body.expires_in * 1000 : null,
    refresh_expires_at:
      typeof body.refresh_token_expires_in === "number"
        ? now + body.refresh_token_expires_in * 1000
        : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    login: null,
  };
}

interface PendingRow {
  session_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval_s: number;
  expires_at: number;
  status: PollResult["status"];
  error: string | null;
}

export function recordPending(db: DB, session_id: string, code: DeviceCodeResponse) {
  db.prepare(
    `INSERT OR REPLACE INTO device_sessions
     (session_id, device_code, user_code, verification_uri, interval_s, expires_at, status, error)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
  ).run(
    session_id,
    code.device_code,
    code.user_code,
    code.verification_uri,
    code.interval,
    Date.now() + code.expires_in * 1000,
  );
}

export function getPending(db: DB, session_id: string): PendingRow | null {
  return (
    (db.prepare(`SELECT * FROM device_sessions WHERE session_id = ?`).get(session_id) as
      | PendingRow
      | undefined) ?? null
  );
}

export async function advancePending(
  clientId: string,
  session_id: string,
  db: DB,
  key: Buffer,
): Promise<PollResult> {
  const p = getPending(db, session_id);
  if (!p) return { status: "error", error: "unknown session" };
  if (p.status === "authorized") return { status: "authorized" };
  if (Date.now() > p.expires_at) {
    db.prepare(`UPDATE device_sessions SET status = 'expired' WHERE session_id = ?`).run(
      session_id,
    );
    return { status: "expired" };
  }
  const result = await pollOnce(clientId, p.device_code);
  db.prepare(`UPDATE device_sessions SET status = ?, error = ? WHERE session_id = ?`).run(
    result.status,
    result.error ?? null,
    session_id,
  );
  if (result.status === "authorized" && result.token) {
    const login = await fetchLogin(result.token.access_token);
    result.token.login = login;
    saveToken(db, key, result.token);
    // don't keep the device_code around after success
    db.prepare(`DELETE FROM device_sessions WHERE session_id = ?`).run(session_id);
  }
  return result;
}

/** Opportunistic cleanup for stale sessions. */
export function pruneExpiredSessions(db: DB): void {
  db.prepare(`DELETE FROM device_sessions WHERE expires_at < ?`).run(Date.now());
}
