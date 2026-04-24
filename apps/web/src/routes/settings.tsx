import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["gh-status"],
    queryFn: api.githubStatus,
  });

  const [session, setSession] = useState<{
    session_id: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  } | null>(null);
  const [pollStatus, setPollStatus] = useState<string>("");

  const [startError, setStartError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: api.githubStart,
    onMutate: () => setStartError(null),
    onSuccess: (data) => {
      setSession(data);
      setPollStatus("pending");
    },
    onError: (e: Error) => {
      let msg = e.message;
      if (msg.includes("no_client_id")) {
        msg = "The server has no GitHub App configured. Set KANCO_GH_CLIENT_ID (your kanco App's client id) in the environment and restart.";
      } else if (msg.includes("device_flow_disabled")) {
        msg = "The GitHub App has Device Flow disabled. Open your App's settings → 'Enable Device Flow' → Save.";
      }
      setStartError(msg);
    },
  });
  const disconnect = useMutation({
    mutationFn: api.githubDisconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gh-status"] }),
  });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let timer: number | null = null;
    let delayS = Math.max(2, session.interval);
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = window.setTimeout(() => resolve(), ms);
      });
    (async () => {
      while (!cancelled) {
        await sleep(delayS * 1000);
        if (cancelled) return;
        try {
          const res = await api.githubPoll(session.session_id);
          if (cancelled) return;
          setPollStatus(res.status);
          if (res.status === "authorized") {
            qc.invalidateQueries({ queryKey: ["gh-status"] });
            return;
          }
          if (res.status === "slow_down") {
            delayS += 2;
            continue;
          }
          if (res.status !== "pending") return;
        } catch (e) {
          if (cancelled) return;
          setPollStatus(`error: ${(e as Error).message}`);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [session?.session_id, qc]);

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "http://localhost:8787/mcp";

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Settings</h2>
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>GitHub</h3>
        {status?.connected ? (
          <>
            <p>Connected as {status.login ?? "(unknown login)"}.</p>
            <div>
              <button className="danger" onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </div>
          </>
        ) : session && pollStatus !== "authorized" ? (
          <>
            <p>
              Visit{" "}
              <a href={session.verification_uri} target="_blank" rel="noreferrer">
                {session.verification_uri}
              </a>{" "}
              and enter this code:
            </p>
            <div style={{ fontSize: 28, letterSpacing: 6, fontFamily: "monospace" }}>
              {session.user_code}
            </div>
            <div className="muted">Status: {pollStatus}</div>
          </>
        ) : pollStatus === "authorized" ? (
          <p>Authorized — updating status…</p>
        ) : (
          <>
            <p className="muted">
              Kanco uses a shared GitHub App via device flow. No secrets are sent; your token is stored
              encrypted on disk.
            </p>
            <div>
              <button className="primary" onClick={() => start.mutate()} disabled={start.isPending}>
                {start.isPending ? "Connecting…" : "Connect GitHub"}
              </button>
            </div>
            {startError && <div className="error-banner">{startError}</div>}
          </>
        )}
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>MCP</h3>
        <p className="muted">
          Add this server to your MCP-compatible client using the streamable HTTP transport.
        </p>
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>Endpoint</span>
          <pre className="panel" style={{ margin: 0 }}>{mcpUrl}</pre>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>Claude Code</span>
          <pre className="panel" style={{ margin: 0 }}>
            {`claude mcp add kanco ${mcpUrl} --transport http`}
          </pre>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>Codex</span>
          <pre className="panel" style={{ margin: 0 }}>
            {`codex mcp add kanco --url ${mcpUrl}`}
          </pre>
        </div>
      </div>
    </div>
  );
}
