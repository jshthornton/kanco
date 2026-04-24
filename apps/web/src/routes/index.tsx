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

  const create = useMutation({
    mutationFn: api.createSpace,
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
        A local-first kanban for agents. Create a space, make tickets, link PRs, and let Claude Code or Codex
        drive the board via MCP.
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
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>New space</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate(name.trim());
            setName("");
          }}
        >
          <input
            placeholder="e.g. kanco, my-repo, personal"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" type="submit" disabled={create.isPending}>
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
