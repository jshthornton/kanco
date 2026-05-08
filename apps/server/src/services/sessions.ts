import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync, readSync, closeSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { AgentKind, AgentSession, Ticket } from "@kanco/shared";
import type { DB } from "../db/client.js";
import { getTicket } from "./tickets.js";
import { getSpace } from "./spaces.js";
import { getAgent } from "./agents/index.js";
import { writeAudit } from "./tickets.js";
import { emitChange } from "../events.js";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  colors,
} from "unique-names-generator";

function randomBranchSlug(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: "-",
    length: 3,
    style: "lowerCase",
  });
}

interface SessionRow {
  id: string;
  ticket_id: string | null;
  bead_id: string | null;
  space_id: string;
  agent: AgentKind;
  agent_session_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  cwd: string;
  pid: number | null;
  status: AgentSession["status"];
  exit_code: number | null;
  log_path: string;
  prompt: string;
  include_parent: number;
  used_worktree: number;
  started_at: number;
  ended_at: number | null;
}

function rowToSession(r: SessionRow): AgentSession {
  return {
    ...r,
    include_parent: !!r.include_parent,
    used_worktree: !!r.used_worktree,
  };
}

export function buildPrompt(ticket: Ticket, parent: Ticket | null): string {
  const parts: string[] = [
    "You are working on the ticket below in this repository. Implement it end-to-end:",
    "explore the codebase as needed, make the necessary code changes, run the project's",
    "type-checks and tests, and iterate until the work is complete. Commit your changes",
    "on the current branch when you are done. Do not stop after only gathering context —",
    "carry the task through to completion.",
    "",
    `# Ticket: ${ticket.title}`,
  ];
  if (ticket.body) parts.push(ticket.body);
  if (parent) {
    parts.push("");
    parts.push(`## Parent ticket: ${parent.title}`);
    if (parent.body) parts.push(parent.body);
  }
  return parts.join("\n");
}

function dataDir(): string {
  return process.env.KANCO_DATA_DIR ?? "./kanco-data";
}

export interface StartSessionOpts {
  ticket_id: string;
  agent: AgentKind;
  worktree: boolean;
  include_parent: boolean;
}

export function startSession(db: DB, opts: StartSessionOpts): AgentSession {
  const ticket = getTicket(db, opts.ticket_id);
  if (!ticket) {
    const e = new Error(`ticket ${opts.ticket_id} not found`) as Error & { code: string };
    e.code = "ticket_not_found";
    throw e;
  }
  const space = getSpace(db, ticket.space_id);
  if (!space) throw new Error(`space ${ticket.space_id} not found`);
  if (!space.repo_root) {
    const e = new Error("space has no repo_root configured") as Error & { code: string };
    e.code = "repo_root_not_configured";
    throw e;
  }
  const repoRoot = resolve(space.repo_root);
  if (!existsSync(repoRoot)) {
    const e = new Error(`repo_root ${repoRoot} does not exist`) as Error & { code: string };
    e.code = "repo_root_missing";
    throw e;
  }

  const parent =
    opts.include_parent && ticket.parent_ticket_id
      ? getTicket(db, ticket.parent_ticket_id)
      : null;
  const prompt = buildPrompt(ticket, parent);
  const adapter = getAgent(opts.agent);

  const id = nanoid(12);
  const agentSessionId = randomUUID();
  const baseDir = dataDir();
  const sessionsDir = join(baseDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const log_path = join(sessionsDir, `${id}.log`);

  let cwd = repoRoot;
  let worktree_path: string | null = null;
  let branch: string | null = null;
  if (opts.worktree) {
    // Keep worktrees local to the repo so they're easy to find from the
    // terminal and can be ignored via the repo's .gitignore (.kanco/).
    const worktreesRoot = join(repoRoot, ".kanco", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    worktree_path = join(worktreesRoot, id);
    // Unique slug per session so we never collide with a leftover branch
    // (and never have to prune potentially-in-use worktrees).
    // Flat namespace under `kanco/` — nesting with `/` would collide with any
    // pre-existing leaf branch like `kanco/<ticket-id>` from a prior run.
    branch = `kanco/${ticket.id}-${randomBranchSlug()}`;
    try {
      execFileSync(
        "git",
        ["-C", repoRoot, "worktree", "add", "-b", branch, worktree_path, "HEAD"],
        { stdio: "pipe" },
      );
    } catch (err) {
      const stderr =
        err instanceof Error ? (err as Error & { stderr?: Buffer }).stderr?.toString() : "";
      const detail = stderr || (err instanceof Error ? err.message : String(err));
      const e = new Error(`git worktree add failed: ${detail}`) as Error & { code: string };
      e.code = "worktree_failed";
      throw e;
    }
    cwd = worktree_path;
  }

  if (opts.agent === "claude") preseedClaudeSettings(cwd);

  const logFd = openSync(log_path, "a");
  const { command, args } = adapter.buildSpawn(prompt, agentSessionId);
  const now = Date.now();

  let pid: number | null = null;
  let initialStatus: AgentSession["status"] = "running";
  let exitCode: number | null = null;
  let endedAt: number | null = null;

  try {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", logFd, logFd],
      detached: false,
    });
    pid = child.pid ?? null;

    child.on("exit", (code, signal) => {
      const status: AgentSession["status"] = signal && code === null ? "error" : "exited";
      const ec = code ?? null;
      db.prepare(
        `UPDATE agent_sessions SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`,
      ).run(status, ec, Date.now(), id);
      try {
        closeSync(logFd);
      } catch {
        /* already closed */
      }
      emitChange({ kind: "session.ended", space_id: ticket.space_id, ticket_id: ticket.id });
    });
    child.on("error", (err) => {
      db.prepare(
        `UPDATE agent_sessions SET status = 'error', ended_at = ? WHERE id = ?`,
      ).run(Date.now(), id);
      console.error(`[sessions] spawn error for ${id}:`, err);
      emitChange({ kind: "session.ended", space_id: ticket.space_id, ticket_id: ticket.id });
    });
  } catch (err) {
    initialStatus = "error";
    endedAt = now;
    exitCode = null;
    console.error(`[sessions] failed to spawn ${command}:`, err);
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
  }

  db.prepare(
    `INSERT INTO agent_sessions
       (id, ticket_id, bead_id, space_id, agent, agent_session_id, worktree_path, branch, cwd, pid, status,
        exit_code, log_path, prompt, include_parent, used_worktree, started_at, ended_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ticket.id,
    ticket.space_id,
    opts.agent,
    agentSessionId,
    worktree_path,
    branch,
    cwd,
    pid,
    initialStatus,
    exitCode,
    log_path,
    prompt,
    opts.include_parent ? 1 : 0,
    opts.worktree ? 1 : 0,
    now,
    endedAt,
  );

  writeAudit(db, ticket.id, "session.started", {
    session_id: id,
    agent: opts.agent,
    worktree: opts.worktree,
    include_parent: opts.include_parent,
  });
  emitChange({ kind: "session.started", space_id: ticket.space_id, ticket_id: ticket.id });

  return rowToSession(getSessionRow(db, id)!);
}

function getSessionRow(db: DB, id: string): SessionRow | null {
  return (
    (db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) as SessionRow | undefined) ??
    null
  );
}

export function getSession(db: DB, id: string): AgentSession | null {
  const r = getSessionRow(db, id);
  return r ? rowToSession(r) : null;
}

export interface TicketSessionSummaryRow {
  ticket_id: string;
  running: number;
  finished: number;
  errored: number;
}

export function listSpaceSessionSummary(db: DB, space_id: string): TicketSessionSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT
         ticket_id,
         SUM(CASE WHEN status IN ('running', 'starting') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'exited' THEN 1 ELSE 0 END) AS finished,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored
       FROM agent_sessions
       WHERE space_id = ?
       GROUP BY ticket_id`,
    )
    .all(space_id) as Array<{
    ticket_id: string;
    running: number | null;
    finished: number | null;
    errored: number | null;
  }>;
  return rows.map((r) => ({
    ticket_id: r.ticket_id,
    running: r.running ?? 0,
    finished: r.finished ?? 0,
    errored: r.errored ?? 0,
  }));
}

export interface BeadSessionSummaryRow {
  bead_id: string;
  running: number;
  finished: number;
  errored: number;
}

export function listSpaceBeadSessionSummary(db: DB, space_id: string): BeadSessionSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT
         bead_id,
         SUM(CASE WHEN status IN ('running', 'starting') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'exited' THEN 1 ELSE 0 END) AS finished,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored
       FROM agent_sessions
       WHERE space_id = ? AND bead_id IS NOT NULL
       GROUP BY bead_id`,
    )
    .all(space_id) as Array<{
    bead_id: string;
    running: number | null;
    finished: number | null;
    errored: number | null;
  }>;
  return rows.map((r) => ({
    bead_id: r.bead_id,
    running: r.running ?? 0,
    finished: r.finished ?? 0,
    errored: r.errored ?? 0,
  }));
}

export function listTicketSessions(db: DB, ticket_id: string): AgentSession[] {
  const rows = db
    .prepare(`SELECT * FROM agent_sessions WHERE ticket_id = ? ORDER BY started_at DESC`)
    .all(ticket_id) as SessionRow[];
  return rows.map(rowToSession);
}

export function tailSessionLog(log_path: string, bytes = 16384): string {
  try {
    const st = statSync(log_path);
    const size = st.size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len === 0) return "";
    const fd = openSync(log_path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark any "running"/"starting" session whose pid is gone as exited. Runs at
 * boot to catch sessions whose parent server died mid-run, and on a timer to
 * catch the same case during a hot-reload of `tsx watch` (the new server has
 * no handle to the prior child, so its on-exit listener never fires).
 */
export function recoverOrphanSessions(db: DB): void {
  const rows = db
    .prepare(
      `SELECT id, pid, space_id, ticket_id, bead_id FROM agent_sessions
       WHERE status IN ('running', 'starting')`,
    )
    .all() as {
    id: string;
    pid: number | null;
    space_id: string;
    ticket_id: string | null;
    bead_id: string | null;
  }[];
  const now = Date.now();
  for (const r of rows) {
    if (r.pid != null && pidAlive(r.pid)) continue;
    db.prepare(
      `UPDATE agent_sessions SET status = 'exited', ended_at = ? WHERE id = ?`,
    ).run(now, r.id);
    emitChange({
      kind: "session.ended",
      space_id: r.space_id,
      ticket_id: r.ticket_id ?? undefined,
      bead_id: r.bead_id ?? undefined,
    });
  }
}

// ---- bead-keyed sessions ----

export interface StartBeadSessionOpts {
  space_id: string;
  bead_id: string;
  agent: AgentKind;
  worktree: boolean;
}

/**
 * Auto-enable any .mcp.json servers in the worktree so headless `claude -p`
 * doesn't hang on the "N new MCP servers found" interactive picker. Without
 * this, every fresh worktree triggers the prompt and stalls on stdin.
 */
function preseedClaudeSettings(cwd: string): void {
  try {
    const dir = join(cwd, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.local.json");
    if (existsSync(file)) return;
    writeFileSync(
      file,
      JSON.stringify({ enableAllProjectMcpServers: true }, null, 2),
    );
  } catch (err) {
    console.error("[sessions] failed to preseed claude settings:", err);
  }
}

function buildBeadPrompt(beadId: string): string {
  return [
    `You are working on bead **${beadId}** in this repository.`,
    "",
    "Use the `bd` CLI (or the kanco MCP tools `get_bead`, `list_beads`,",
    "`get_bead_graph`) to read this bead. Walk the parent chain — for any",
    "bead with a `parent` field, fetch that parent and recurse — to gather",
    "context. Treat blocking and parent-child dependencies as required",
    "context, related/tracks as background.",
    "",
    "Implement the bead end-to-end: explore the codebase, make the changes,",
    "run type-checks and tests, iterate until done. Commit on the current",
    "branch when complete. Update the bead status (`bd update <id>",
    "--status in_progress` / `--status closed`) as you progress.",
    "Do not stop after only gathering context — carry the work to completion.",
  ].join("\n");
}

export function startBeadSession(db: DB, opts: StartBeadSessionOpts): AgentSession {
  const space = getSpace(db, opts.space_id);
  if (!space) throw new Error(`space ${opts.space_id} not found`);
  if (!space.repo_root) {
    const e = new Error("space has no repo_root configured") as Error & { code: string };
    e.code = "repo_root_not_configured";
    throw e;
  }
  const repoRoot = resolve(space.repo_root);
  if (!existsSync(repoRoot)) {
    const e = new Error(`repo_root ${repoRoot} does not exist`) as Error & { code: string };
    e.code = "repo_root_missing";
    throw e;
  }

  const prompt = buildBeadPrompt(opts.bead_id);
  const adapter = getAgent(opts.agent);

  const id = nanoid(12);
  const agentSessionId = randomUUID();
  const baseDir = dataDir();
  const sessionsDir = join(baseDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const log_path = join(sessionsDir, `${id}.log`);

  let cwd = repoRoot;
  let worktree_path: string | null = null;
  let branch: string | null = null;
  if (opts.worktree) {
    const worktreesRoot = join(repoRoot, ".kanco", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    worktree_path = join(worktreesRoot, id);
    branch = `kanco/${opts.bead_id}-${randomBranchSlug()}`;
    try {
      execFileSync(
        "git",
        ["-C", repoRoot, "worktree", "add", "-b", branch, worktree_path, "HEAD"],
        { stdio: "pipe" },
      );
    } catch (err) {
      const stderr =
        err instanceof Error ? (err as Error & { stderr?: Buffer }).stderr?.toString() : "";
      const detail = stderr || (err instanceof Error ? err.message : String(err));
      const e = new Error(`git worktree add failed: ${detail}`) as Error & { code: string };
      e.code = "worktree_failed";
      throw e;
    }
    cwd = worktree_path;
  }

  if (opts.agent === "claude") preseedClaudeSettings(cwd);

  const logFd = openSync(log_path, "a");
  const { command, args } = adapter.buildSpawn(prompt, agentSessionId);
  const now = Date.now();

  let pid: number | null = null;
  let initialStatus: AgentSession["status"] = "running";
  let exitCode: number | null = null;
  let endedAt: number | null = null;

  try {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", logFd, logFd],
      detached: false,
    });
    pid = child.pid ?? null;

    child.on("exit", (code, signal) => {
      const status: AgentSession["status"] = signal && code === null ? "error" : "exited";
      const ec = code ?? null;
      db.prepare(
        `UPDATE agent_sessions SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`,
      ).run(status, ec, Date.now(), id);
      try {
        closeSync(logFd);
      } catch {
        /* already closed */
      }
      emitChange({ kind: "session.ended", space_id: opts.space_id, bead_id: opts.bead_id });
    });
    child.on("error", (err) => {
      db.prepare(
        `UPDATE agent_sessions SET status = 'error', ended_at = ? WHERE id = ?`,
      ).run(Date.now(), id);
      console.error(`[sessions] spawn error for ${id}:`, err);
      emitChange({ kind: "session.ended", space_id: opts.space_id, bead_id: opts.bead_id });
    });
  } catch (err) {
    initialStatus = "error";
    endedAt = now;
    exitCode = null;
    console.error(`[sessions] failed to spawn ${command}:`, err);
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
  }

  db.prepare(
    `INSERT INTO agent_sessions
       (id, ticket_id, bead_id, space_id, agent, agent_session_id, worktree_path, branch, cwd, pid, status,
        exit_code, log_path, prompt, include_parent, used_worktree, started_at, ended_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.bead_id,
    opts.space_id,
    opts.agent,
    agentSessionId,
    worktree_path,
    branch,
    cwd,
    pid,
    initialStatus,
    exitCode,
    log_path,
    prompt,
    0,
    opts.worktree ? 1 : 0,
    now,
    endedAt,
  );

  emitChange({ kind: "session.started", space_id: opts.space_id, bead_id: opts.bead_id });

  return rowToSession(getSessionRow(db, id)!);
}

export function listBeadSessions(db: DB, space_id: string, bead_id: string): AgentSession[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_sessions WHERE space_id = ? AND bead_id = ? ORDER BY started_at DESC`,
    )
    .all(space_id, bead_id) as SessionRow[];
  return rows.map(rowToSession);
}

/** Start a background interval that sweeps orphans every `intervalMs`. */
export function startOrphanReaper(db: DB, intervalMs = 5_000): () => void {
  const handle = setInterval(() => {
    try {
      recoverOrphanSessions(db);
    } catch (err) {
      console.error("[sessions] orphan reaper error:", err);
    }
  }, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
