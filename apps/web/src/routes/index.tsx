import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: spaces } = useQuery({ queryKey: ["spaces"], queryFn: api.listSpaces });
  const [name, setName] = useState("");
  const [repoRoot, setRepoRoot] = useState("");
  const [doltRemote, setDoltRemote] = useState("");

  const create = useMutation({
    mutationFn: (input: { name: string; repo_root?: string; dolt_remote_url?: string }) =>
      api.createSpace(input),
    onSuccess: (space) => {
      qc.invalidateQueries({ queryKey: ["spaces"] });
      void navigate({ to: "/spaces/$spaceId", params: { spaceId: space.id } });
    },
  });

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Welcome</h2>
      </div>
      <p className="muted">
        A frontend for <a href="https://github.com/gastownhall/beads">beads</a>. One space = one
        repo with a <code>.beads/</code> directory. Status board + dependency graph + auto-push to
        Dolt.
      </p>
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Your spaces</h3>
        {(spaces ?? []).length === 0 ? (
          <p className="muted">No spaces yet.</p>
        ) : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {(spaces ?? []).map((s) => (
              <li key={s.id}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void navigate({ to: "/spaces/$spaceId", params: { spaceId: s.id } });
                  }}
                >
                  {s.name}
                </a>
                {s.repo_root && (
                  <small className="muted"> · {s.repo_root}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>New space</h3>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate({
              name: name.trim(),
              repo_root: repoRoot.trim() || undefined,
              dolt_remote_url: doltRemote.trim() || undefined,
            });
            setName("");
            setRepoRoot("");
            setDoltRemote("");
          }}
        >
          <input
            placeholder="Name (e.g. kanco)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="repo_root (path to repo with or without .beads/)"
            value={repoRoot}
            onChange={(e) => setRepoRoot(e.target.value)}
          />
          <input
            placeholder="dolt_remote_url (optional, e.g. file:///… or doltremoteapi://…)"
            value={doltRemote}
            onChange={(e) => setDoltRemote(e.target.value)}
          />
          <button className="primary" type="submit" disabled={create.isPending || !name.trim()}>
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
