import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import type { BeadDepType, BeadStatus, BeadSummary } from "@kanco/shared";
import { BOARD_STATUSES, STATUS_COLOR, STATUS_LABEL } from "../lib/beads-columns";
import { BeadCreateModal, type BeadCreateValues } from "../components/BeadCreateModal";
import { BeadDetail } from "../components/BeadDetail";
import { BeadGraph } from "../components/BeadGraph";
import { BeadId } from "../components/BeadId";

interface Search {
  bead?: string;
  view?: "board" | "graph";
  label?: string[];
  parent?: string;
  closed?: boolean;
  focus?: string;
  q?: string;
}

export const Route = createFileRoute("/spaces/$spaceId")({
  component: BeadsPage,
  validateSearch: (raw: Record<string, unknown>): Search => ({
    bead: typeof raw.bead === "string" ? raw.bead : undefined,
    view: raw.view === "graph" ? "graph" : "board",
    label: Array.isArray(raw.label)
      ? (raw.label as unknown[]).filter((v): v is string => typeof v === "string")
      : typeof raw.label === "string"
        ? [raw.label]
        : undefined,
    parent: typeof raw.parent === "string" ? raw.parent : undefined,
    closed: raw.closed === true || raw.closed === "1",
    focus: typeof raw.focus === "string" ? raw.focus : undefined,
    q: typeof raw.q === "string" && raw.q ? raw.q : undefined,
  }),
});

function BeadsPage() {
  const { spaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const setSearch = useCallback(
    (next: Partial<Search>) =>
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId },
        search: { ...search, ...next },
      }),
    [navigate, search, spaceId],
  );

  const { data: space } = useQuery({
    queryKey: ["space", spaceId],
    queryFn: () => api.getSpace(spaceId),
  });
  const { data: labels } = useQuery({
    queryKey: ["labels", spaceId],
    queryFn: () => api.listLabels(spaceId),
    refetchInterval: 60_000,
  });
  const { data: beads, error } = useQuery({
    queryKey: ["beads", spaceId, search.label, search.parent, search.q],
    queryFn: () =>
      api.listBeads(spaceId, {
        label: search.label,
        parent: search.parent,
        q: search.q,
        includeClosed: true,
      }),
    refetchInterval: 60_000,
  });
  const { data: parentBead } = useQuery({
    queryKey: ["bead", spaceId, search.parent],
    queryFn: () => (search.parent ? api.getBead(spaceId, search.parent) : null),
    enabled: !!search.parent,
  });

  const beadsById = useMemo(() => {
    const m = new Map<string, BeadSummary>();
    for (const b of beads ?? []) m.set(b.id, b);
    return m;
  }, [beads]);

  const grouped = useMemo(() => {
    const out: Record<BeadStatus, BeadSummary[]> = {
      open: [],
      in_progress: [],
      blocked: [],
      deferred: [],
      closed: [],
      pinned: [],
      hooked: [],
    };
    for (const b of beads ?? []) {
      if (b.issue_type === "gate") continue;
      out[b.status].push(b);
    }
    return out;
  }, [beads]);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: BeadStatus }) =>
      api.updateBead(spaceId, id, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
      void qc.invalidateQueries({ queryKey: ["graph", spaceId] });
    },
    onError: (err) => {
      console.error("status update failed", err);
      window.alert(
        `Status update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  const [creating, setCreating] = useState(false);
  const [hiddenEdges, setHiddenEdges] = useState<ReadonlySet<BeadDepType>>(new Set());
  const create = useMutation({
    mutationFn: (v: BeadCreateValues) => api.createBead(spaceId, v),
    onSuccess: () => {
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
      void qc.invalidateQueries({ queryKey: ["graph", spaceId] });
    },
  });

  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const noRepo = /no_repo_root/i.test(msg);
    return (
      <div className="page">
        <Link to="/">← back</Link>
        <h1>{space?.name ?? spaceId}</h1>
        <p className="error">
          {noRepo ? (
            <>
              This space has no <code>repo_root</code> configured. Beads requires a repo path.
              Edit the space to set one.
            </>
          ) : (
            msg
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="page beads-page">
      <header className="beads-header">
        <Link to="/">←</Link>
        <h1 style={{ margin: 0 }}>{space?.name ?? spaceId}</h1>
        <nav className="view-toggle">
          <button
            className={search.view !== "graph" ? "active" : ""}
            onClick={() => setSearch({ view: "board" })}
          >
            Board
          </button>
          <button
            className={search.view === "graph" ? "active" : ""}
            onClick={() => setSearch({ view: "graph" })}
          >
            Graph
          </button>
        </nav>
        <div className="grow" />
        <button onClick={() => setCreating(true)}>+ New bead</button>
      </header>

      <div className="beads-filters">
        <label>
          Search:
          <input
            type="search"
            placeholder="title / description / id"
            value={search.q ?? ""}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            style={{ width: 220 }}
          />
        </label>
        <label>
          Add label:
          <select
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              const cur = search.label ?? [];
              if (cur.includes(v)) return;
              setSearch({ label: [...cur, v] });
            }}
          >
            <option value="">— pick —</option>
            {(labels ?? [])
              .filter((l) => !(search.label ?? []).includes(l))
              .map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
          </select>
        </label>
        <label>
          Parent:
          <input
            placeholder="bead id"
            value={search.parent ?? ""}
            onChange={(e) => setSearch({ parent: e.target.value || undefined })}
            style={{ width: 160 }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={search.closed ?? false}
            onChange={(e) => setSearch({ closed: e.target.checked || undefined })}
          />
          Show closed
        </label>
        {search.parent && parentBead && (
          <span className="chip">
            parent: <BeadId id={parentBead.id} /> {parentBead.title}
            <button onClick={() => setSearch({ parent: undefined })} title="clear">×</button>
          </span>
        )}
        {(search.label ?? []).map((l) => (
          <span key={l} className="chip">
            label: {l}
            <button
              onClick={() => {
                const next = (search.label ?? []).filter((x) => x !== l);
                setSearch({ label: next.length ? next : undefined });
              }}
              title="remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {search.view === "graph" ? (
        <>
          <GraphEdgeToggles
            hidden={hiddenEdges}
            onChange={setHiddenEdges}
          />
          <BeadGraph
            spaceId={spaceId}
            filter={{ label: search.label, parent: search.parent, q: search.q }}
            hiddenEdgeTypes={hiddenEdges}
            focusId={search.focus}
            onSelectBead={(id) => setSearch({ bead: id })}
          />
        </>
      ) : (
        <div className="bead-board">
          {BOARD_STATUSES.map((status) => (
            <section key={status} className="bead-column">
              <h3 style={{ borderTopColor: STATUS_COLOR[status] }}>
                {STATUS_LABEL[status]}{" "}
                <span className="count">{grouped[status].length}</span>
              </h3>
              <ul>
                {grouped[status].map((b) => (
                  <li
                    key={b.id}
                    className="bead-card"
                    onClick={() => setSearch({ bead: b.id })}
                  >
                    {b.parent && (
                      <button
                        className="bead-card-parent"
                        title="Focus subtree"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSearch({ parent: b.parent, bead: undefined });
                        }}
                      >
                        ↑ <BeadId id={b.parent} />
                        {beadsById.get(b.parent)?.title && (
                          <span> {beadsById.get(b.parent)!.title}</span>
                        )}
                      </button>
                    )}
                    <div className="bead-card-title">{b.title}</div>
                    {b.owner && (
                      <div className="bead-card-owner" title="claimed by">
                        @{b.owner}
                      </div>
                    )}
                    {b.labels && b.labels.length > 0 && (
                      <div className="bead-card-labels">
                        {b.labels.map((l) => (
                          <span
                            key={l}
                            className="label"
                            onClick={(e) => {
                              e.stopPropagation();
                              const cur = search.label ?? [];
                              if (!cur.includes(l)) setSearch({ label: [...cur, l] });
                            }}
                          >
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="bead-card-meta">
                      <BeadId id={b.id} />
                      <select
                        value={b.status}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          const next = e.target.value as BeadStatus;
                          console.log("status change", b.id, b.status, "→", next);
                          setStatus.mutate({ id: b.id, status: next });
                        }}
                        disabled={setStatus.isPending}
                      >
                        {BOARD_STATUSES.concat([
                          "deferred",
                          "pinned",
                          "hooked",
                        ] as BeadStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* graph edge toggles rendered above */}

      {creating && (
        <BeadCreateModal
          defaultParent={search.parent}
          submitting={create.isPending}
          error={
            create.error
              ? create.error instanceof Error
                ? create.error.message
                : String(create.error)
              : undefined
          }
          onCancel={() => {
            create.reset();
            setCreating(false);
          }}
          onSubmit={(v) => create.mutate(v)}
        />
      )}

      {search.bead && (
        <BeadDetail
          spaceId={spaceId}
          beadId={search.bead}
          onClose={() => setSearch({ bead: undefined })}
          onSelectBead={(id) => setSearch({ bead: id })}
          onFocusParent={(id) => setSearch({ parent: id, bead: undefined })}
          onShowInGraph={(id) =>
            setSearch({ view: "graph", focus: id, parent: undefined, bead: undefined })
          }
        />
      )}
    </div>
  );
}

const ALL_DEP_TYPES: BeadDepType[] = [
  "blocks",
  "parent-child",
  "related",
  "tracks",
  "discovered-from",
];

function GraphEdgeToggles({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<BeadDepType>;
  onChange: (next: ReadonlySet<BeadDepType>) => void;
}) {
  const toggle = (t: BeadDepType) => {
    const next = new Set(hidden);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange(next);
  };
  return (
    <div className="beads-filters" style={{ marginBottom: "0.5rem" }}>
      <span className="muted" style={{ fontSize: "0.8rem" }}>Edges:</span>
      {ALL_DEP_TYPES.map((t) => (
        <label key={t} style={{ fontSize: "0.8rem" }}>
          <input
            type="checkbox"
            checked={!hidden.has(t)}
            onChange={() => toggle(t)}
          />
          {t}
        </label>
      ))}
    </div>
  );
}
