import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentSession } from "@kanco/shared";

interface Props {
  ticketId: string;
  onClose?: () => void;
  onOpenTicket?: (id: string) => void;
}

export function TicketDetail({ ticketId, onClose, onOpenTicket }: Props) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.getTicket(ticketId),
  });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [subTitle, setSubTitle] = useState("");

  useEffect(() => {
    if (data?.ticket) {
      setTitle(data.ticket.title);
      setBody(data.ticket.body ?? "");
    }
  }, [data?.ticket?.id]);

  const update = useMutation({
    mutationFn: () => api.updateTicket(ticketId, { title, body: body || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      if (data?.ticket) qc.invalidateQueries({ queryKey: ["board", data.ticket.space_id] });
    },
  });

  const link = useMutation({
    mutationFn: () => api.linkPr(ticketId, prUrl),
    onSuccess: () => {
      setPrUrl("");
      qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      if (data?.ticket) qc.invalidateQueries({ queryKey: ["board", data.ticket.space_id] });
    },
  });

  const unlink = useMutation({
    mutationFn: (linkId: string) => api.unlinkPr(linkId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ticket", ticketId] }),
  });

  const subtask = useMutation({
    mutationFn: () =>
      api.createTicket({
        space_id: data!.ticket.space_id,
        title: subTitle.trim(),
        parent_ticket_id: ticketId,
      }),
    onSuccess: () => {
      setSubTitle("");
      qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteTicket(ticketId),
    onSuccess: () => {
      if (data?.ticket) qc.invalidateQueries({ queryKey: ["board", data.ticket.space_id] });
      onClose?.();
    },
  });

  if (!data) return <div className="muted">Loading…</div>;
  const { ticket, links, subtasks } = data;

  return (
    <div className="stack">
      <div className="page-header">
        <div className="row" style={{ gap: 8 }}>
          <span className="muted" style={{ fontFamily: "monospace", fontSize: 12 }}>
            {ticket.id}
          </span>
        </div>
        <div className="row">
          <button className="danger" onClick={() => del.mutate()}>
            Delete
          </button>
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      </div>
      <div className="panel stack">
        <label>
          <div className="muted" style={{ marginBottom: 4 }}>Title</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => update.mutate()}
          />
        </label>
        <label>
          <div className="muted" style={{ marginBottom: 4 }}>Body</div>
          <textarea
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => update.mutate()}
          />
        </label>
        <div className="muted">
          Created by {ticket.created_by} · Updated {new Date(ticket.updated_at).toLocaleString()}
        </div>
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Linked PRs</h3>
        {links.length === 0 ? (
          <div className="muted">No PRs linked.</div>
        ) : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {links.map((l) => (
              <li key={l.id} className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <a href={l.url} target="_blank" rel="noreferrer">
                    {l.owner}/{l.repo}#{l.number}
                  </a>{" "}
                  <span className={`pill pr-${l.state}`}>{l.state}</span>{" "}
                  {l.title && <span className="muted">{l.title}</span>}
                </div>
                <button onClick={() => unlink.mutate(l.id)}>Unlink</button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (prUrl.trim()) link.mutate();
          }}
        >
          <input
            placeholder="https://github.com/owner/repo/pull/123"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
          />
          <button className="primary" type="submit" disabled={link.isPending || !prUrl.trim()}>
            Link PR
          </button>
        </form>
      </div>

      <SessionPanel
        ticketId={ticketId}
        spaceId={ticket.space_id}
        isSubtask={!!ticket.parent_ticket_id}
      />

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Subtasks</h3>
        {subtasks.length === 0 ? (
          <div className="muted">No subtasks.</div>
        ) : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {subtasks.map((s) => (
              <li key={s.id}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenTicket?.(s.id);
                  }}
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (subTitle.trim()) subtask.mutate();
          }}
        >
          <input
            placeholder="Subtask title"
            value={subTitle}
            onChange={(e) => setSubTitle(e.target.value)}
          />
          <button className="primary" type="submit" disabled={subtask.isPending || !subTitle.trim()}>
            Add subtask
          </button>
        </form>
      </div>
    </div>
  );
}

function SessionPanel({
  ticketId,
  spaceId,
  isSubtask,
}: {
  ticketId: string;
  spaceId: string;
  isSubtask: boolean;
}) {
  const qc = useQueryClient();
  const [worktree, setWorktree] = useState(true);
  const [includeParent, setIncludeParent] = useState(true);

  const { data: space } = useQuery({
    queryKey: ["space", spaceId],
    queryFn: () => api.getSpace(spaceId),
  });
  const { data: sessions } = useQuery({
    queryKey: ["ticket-sessions", ticketId],
    queryFn: () => api.listTicketSessions(ticketId),
    refetchInterval: 5_000,
  });

  const start = useMutation({
    mutationFn: () =>
      api.startSession(ticketId, {
        worktree,
        include_parent: isSubtask ? includeParent : false,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ticket-sessions", ticketId] }),
  });

  const repoRootSet = !!space?.repo_root;

  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Sessions</h3>
      {!repoRootSet ? (
        <div
          className="stack"
          style={{
            padding: 10,
            border: "1px solid var(--border, #444)",
            borderRadius: 6,
            background: "var(--bg-mute, #1a1a1a)",
          }}
        >
          <strong>Repo root not set</strong>
          <div className="muted">
            Sessions need a `repo_root` on the space so we know where to create the worktree
            and run the agent. Open <strong>Settings</strong> at the top of this space and set
            an absolute path to your local checkout.
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="primary"
              onClick={() => start.mutate()}
              disabled={start.isPending}
            >
              {start.isPending ? "Starting…" : "Start Session"}
            </button>
            <label className="row" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              Run in worktree
            </label>
            {isSubtask && (
              <label className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={includeParent}
                  onChange={(e) => setIncludeParent(e.target.checked)}
                />
                Include parent task's context
              </label>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, fontFamily: "monospace" }}>
            repo_root: {space?.repo_root}
          </div>
        </>
      )}
      {start.error && (
        <div style={{ color: "var(--danger, #c33)" }}>
          {start.error instanceof Error ? start.error.message : "Failed to start"}
        </div>
      )}
      {(sessions ?? []).length === 0 ? (
        <div className="muted">No sessions yet.</div>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {(sessions ?? []).map((s) => (
            <SessionRow key={s.id} session={s} repoRoot={space?.repo_root ?? null} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({
  session,
  repoRoot,
}: {
  session: AgentSession;
  repoRoot: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pathStyle, setPathStyle] = useState<"relative" | "absolute">("relative");
  const { data } = useQuery({
    queryKey: ["session", session.id],
    queryFn: () => api.getSession(session.id),
    enabled: open,
    refetchInterval: open && session.status === "running" ? 2_000 : false,
  });

  const relCwd = relativePath(repoRoot, session.cwd);
  const canRelative = relCwd !== null;
  const useRelative = pathStyle === "relative" && canRelative;
  const cwdForCmd = useRelative ? relCwd! : session.cwd;
  const tailCmd = `tail -f ${shellQuote(session.log_path)}`;
  const resumeFlag = session.agent_session_id
    ? `--resume ${session.agent_session_id}`
    : `--resume`;
  const attachCmd =
    cwdForCmd === "."
      ? `${session.agent} ${resumeFlag}`
      : `( cd ${shellQuote(cwdForCmd)} && ${session.agent} ${resumeFlag} )`;

  return (
    <li className="stack" style={{ padding: "6px 0", borderTop: "1px solid var(--border, #2a2a2a)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="pill">{session.agent}</span>
          <span className={`pill status-${session.status}`}>{session.status}</span>
          {session.used_worktree && session.branch && (
            <span className="muted" style={{ fontFamily: "monospace", fontSize: 12 }}>
              {session.branch}
            </span>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            {new Date(session.started_at).toLocaleString()}
          </span>
        </div>
        <button onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Open"}</button>
      </div>
      {open && (
        <div className="stack" style={{ gap: 6 }}>
          <CmdBlock label="Tail the live log" cmd={tailCmd} />
          <div className="stack" style={{ gap: 2 }}>
            <div
              className="row"
              style={{ justifyContent: "space-between", alignItems: "center" }}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                Attach in your terminal{useRelative ? " (run from repo root)" : ""}
              </div>
              {canRelative && (
                <div className="row" style={{ gap: 4, fontSize: 12 }}>
                  <label className="row" style={{ gap: 2 }}>
                    <input
                      type="radio"
                      checked={pathStyle === "relative"}
                      onChange={() => setPathStyle("relative")}
                    />
                    Relative
                  </label>
                  <label className="row" style={{ gap: 2 }}>
                    <input
                      type="radio"
                      checked={pathStyle === "absolute"}
                      onChange={() => setPathStyle("absolute")}
                    />
                    Absolute
                  </label>
                </div>
              )}
            </div>
            <CmdBlock label="" cmd={attachCmd} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Recent log output:</div>
          <pre
            style={{
              background: "var(--bg-mute, #111)",
              padding: 8,
              fontSize: 12,
              maxHeight: 240,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {data?.log_tail ?? "(loading…)"}
          </pre>
        </div>
      )}
    </li>
  );
}

function CmdBlock({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="stack" style={{ gap: 2 }}>
      {label && <div className="muted" style={{ fontSize: 12 }}>{label}</div>}
      <div className="row" style={{ gap: 6, alignItems: "stretch" }}>
        <pre
          style={{
            flex: 1,
            background: "var(--bg-mute, #111)",
            padding: "6px 8px",
            margin: 0,
            fontSize: 12,
            overflow: "auto",
            whiteSpace: "pre",
          }}
        >
          {cmd}
        </pre>
        <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Returns cwd relative to repoRoot, or null if cwd is outside it. */
function relativePath(repoRoot: string | null, cwd: string): string | null {
  if (!repoRoot) return null;
  const root = repoRoot.replace(/\/+$/, "");
  if (cwd === root) return ".";
  const prefix = root + "/";
  if (cwd.startsWith(prefix)) return cwd.slice(prefix.length);
  return null;
}
