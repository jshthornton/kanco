import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import type { AgentKind, Bead, BeadShowEdge, BeadStatus } from "@kanco/shared";
import { BOARD_STATUSES, STATUS_LABEL } from "../lib/beads-columns";
import { BeadId } from "./BeadId";

interface Props {
  spaceId: string;
  beadId: string;
  onClose: () => void;
  onSelectBead?: (id: string) => void;
  onFocusParent?: (id: string) => void;
  onShowInGraph?: (id: string) => void;
}

export function BeadDetail({
  spaceId,
  beadId,
  onClose,
  onSelectBead,
  onFocusParent,
  onShowInGraph,
}: Props) {
  const qc = useQueryClient();
  const { data: bead, isLoading } = useQuery({
    queryKey: ["bead", spaceId, beadId],
    queryFn: () => api.getBead(spaceId, beadId),
  });

  const update = useMutation({
    mutationFn: (patch: { title?: string; description?: string | null; status?: BeadStatus }) =>
      api.updateBead(spaceId, beadId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bead", spaceId, beadId] });
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
      void qc.invalidateQueries({ queryKey: ["graph", spaceId] });
    },
  });

  const close = useMutation({
    mutationFn: () => api.closeBead(spaceId, beadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bead", spaceId, beadId] });
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
    },
  });

  const resolveGate = useMutation({
    mutationFn: (gateId: string) => api.resolveGate(spaceId, gateId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bead", spaceId, beadId] });
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["bead-sessions", spaceId, beadId],
    queryFn: () => api.listBeadSessions(spaceId, beadId),
    refetchInterval: 5_000,
  });
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [useWorktree, setUseWorktree] = useState(true);
  const startSession = useMutation({
    mutationFn: () =>
      api.startBeadSession(spaceId, beadId, { agent, worktree: useWorktree }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bead-sessions", spaceId, beadId] });
    },
  });

  const [addPrOpen, setAddPrOpen] = useState(false);
  const [prNumber, setPrNumber] = useState("");
  const addGate = useMutation({
    mutationFn: () =>
      api.addBeadGate(spaceId, beadId, { type: "gh:pr", await_id: prNumber }),
    onSuccess: () => {
      setPrNumber("");
      setAddPrOpen(false);
      void qc.invalidateQueries({ queryKey: ["bead", spaceId, beadId] });
    },
  });

  if (isLoading || !bead) {
    return (
      <aside className="bead-detail">
        <button className="close-btn" onClick={onClose}>×</button>
        <p>Loading…</p>
      </aside>
    );
  }

  // `bd show` returns deps in "show form" (carries id/title/issue_type/dependency_type).
  // Narrow by checking for the show-form fields.
  const showForm = (bead.dependencies ?? []).filter(
    (d): d is BeadShowEdge => "id" in d && "issue_type" in d,
  );
  const showDependents = (bead.dependents ?? []).filter(
    (d): d is BeadShowEdge => "id" in d && "issue_type" in d,
  );
  const gates = showForm.filter((d) => d.issue_type === "gate");
  const beadDeps = showForm.filter((d) => d.issue_type !== "gate");
  const dependents = showDependents;

  return (
    <aside className="bead-detail">
      <button className="close-btn" onClick={onClose}>×</button>
      {onShowInGraph && (
        <button
          className="graph-btn"
          onClick={() => onShowInGraph(bead.id)}
          title="Show in graph"
          aria-label="Show in graph"
        >
          ⊹
        </button>
      )}
      <h2>{bead.title}</h2>
      <p className="muted">
        <BeadId id={bead.id} /> · {bead.issue_type}
        {bead.owner && <> · claimed by <strong>@{bead.owner}</strong></>}
        {bead.parent && (
          <>
            {" · parent "}
            <BeadId id={bead.parent} />{" "}
            <button
              className="link-btn"
              onClick={() => onSelectBead?.(bead.parent!)}
              title="Open parent"
            >
              open
            </button>
            {onFocusParent && (
              <>
                {" "}
                <button
                  className="link-btn"
                  onClick={() => onFocusParent(bead.parent!)}
                  title="Filter both views to this parent"
                >
                  (focus subtree)
                </button>
              </>
            )}
          </>
        )}
      </p>
      {bead.labels && bead.labels.length > 0 && (
        <div className="bead-card-labels">
          {bead.labels.map((l) => (
            <span key={l} className="label">
              {l}
            </span>
          ))}
        </div>
      )}

      <label>
        Status:
        <select
          value={bead.status}
          onChange={(e) => update.mutate({ status: e.target.value as BeadStatus })}
          disabled={update.isPending}
        >
          {BOARD_STATUSES.concat(["deferred", "pinned", "hooked"] as BeadStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      {bead.description && (
        <section>
          <h3>Description</h3>
          <pre className="bead-desc">{bead.description}</pre>
        </section>
      )}

      <section>
        <h3>Gates</h3>
        {gates.length === 0 && <p className="muted">No gates.</p>}
        <ul>
          {gates.map((g) => (
            <li key={g.id}>
              <strong>{g.await_type}</strong>
              {g.await_id && <> ({g.await_id})</>} —{" "}
              <span className={`gate-status gate-${g.status}`}>{g.status}</span>
              {g.status === "open" && (
                <button
                  onClick={() => resolveGate.mutate(g.id)}
                  disabled={resolveGate.isPending}
                  title="Resolve gate"
                >
                  resolve
                </button>
              )}
            </li>
          ))}
        </ul>
        {addPrOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (prNumber.trim()) addGate.mutate();
            }}
          >
            <input
              type="number"
              placeholder="PR #"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={!prNumber.trim() || addGate.isPending}>
              add
            </button>
            <button type="button" onClick={() => setAddPrOpen(false)}>
              cancel
            </button>
          </form>
        ) : (
          <button onClick={() => setAddPrOpen(true)}>+ Add gh:pr gate</button>
        )}
      </section>

      <section>
        <h3>Dependencies</h3>
        {beadDeps.length === 0 && <p className="muted">None.</p>}
        <ul>
          {beadDeps.map((d) => (
            <li key={d.id}>
              <BeadId id={d.id} />{" "}
              <button
                className="link-btn"
                onClick={() => onSelectBead?.(d.id)}
                title={d.title}
              >
                open
              </button>{" "}
              <small>({d.dependency_type})</small> — {d.title}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Dependents</h3>
        {dependents.length === 0 && <p className="muted">None.</p>}
        <ul>
          {dependents.map((d) => (
            <li key={d.id}>
              <BeadId id={d.id} />{" "}
              <button className="link-btn" onClick={() => onSelectBead?.(d.id)}>
                open
              </button>{" "}
              <small>({d.dependency_type})</small> — {d.title}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Agent sessions</h3>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label>
            agent:
            <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="cursor">cursor</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />
            worktree
          </label>
          <button
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
          >
            Start agent session
          </button>
        </div>
        {startSession.error && (
          <p className="error" style={{ fontSize: "0.8rem" }}>
            {startSession.error instanceof Error
              ? startSession.error.message
              : String(startSession.error)}
          </p>
        )}
        {(sessions ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: "0.8rem" }}>No sessions yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, fontSize: "0.8rem" }}>
            {(sessions ?? []).map((s) => (
              <li key={s.id}>
                <code>{s.id}</code> · {s.agent} · {s.status}
                {s.branch && (
                  <>
                    {" · "}<code>{s.branch}</code>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="actions">
        {bead.status !== "closed" && (
          <button
            onClick={() => close.mutate()}
            disabled={close.isPending}
            className="danger"
          >
            Close bead
          </button>
        )}
      </section>
    </aside>
  );
}
