import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import type {
  BeadDepType,
  BeadSessionSummary,
  BeadStatus,
  BeadSummary,
} from "@kanco/shared";
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
  isolate?: boolean;
  order?: "default" | "hierarchy" | "blockers" | "hybrid";
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
    isolate: raw.isolate === true || raw.isolate === "1",
    order:
      raw.order === "hierarchy" ||
      raw.order === "blockers" ||
      raw.order === "hybrid" ||
      raw.order === "default"
        ? raw.order
        : undefined,
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
  const { data: sessionSummary } = useQuery({
    queryKey: ["bead-session-summary", spaceId],
    queryFn: () => api.listBeadSessionSummary(spaceId),
    refetchInterval: 5_000,
  });
  const sessionsByBead = useMemo(() => {
    const m = new Map<string, BeadSessionSummary>();
    for (const s of sessionSummary ?? []) m.set(s.bead_id, s);
    return m;
  }, [sessionSummary]);

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
    onMutate: async ({ id, status }) => {
      const beadsKey = ["beads", spaceId, search.label, search.parent, search.q];
      await qc.cancelQueries({ queryKey: ["beads", spaceId] });
      const prev = qc.getQueriesData<BeadSummary[]>({ queryKey: ["beads", spaceId] });
      for (const [key, data] of prev) {
        if (!data) continue;
        qc.setQueryData<BeadSummary[]>(
          key,
          data.map((b) => (b.id === id ? { ...b, status } : b)),
        );
      }
      const toastId = toast.loading(`Moving to ${STATUS_LABEL[status]}…`);
      return { prev, toastId, beadsKey };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) qc.setQueryData(key, data);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Status update failed: ${msg}`, { id: ctx?.toastId });
    },
    onSuccess: (_data, vars, ctx) => {
      toast.success(`Moved to ${STATUS_LABEL[vars.status]}`, { id: ctx?.toastId });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["beads", spaceId] });
      void qc.invalidateQueries({ queryKey: ["graph", spaceId] });
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
            isolate={search.isolate ?? false}
            onIsolateChange={(v) => setSearch({ isolate: v || undefined })}
            hasSelection={!!(search.bead ?? search.focus)}
            order={search.order ?? "default"}
            onOrderChange={(v) => setSearch({ order: v === "default" ? undefined : v })}
          />
          <BeadGraph
            spaceId={spaceId}
            filter={{ label: search.label, parent: search.parent, q: search.q }}
            hiddenEdgeTypes={hiddenEdges}
            focusId={search.focus}
            selectedId={search.bead ?? search.focus}
            isolateSelection={search.isolate ?? false}
            orderMode={search.order ?? "default"}
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
                    {sessionsByBead.get(b.id) && (
                      <SessionPills s={sessionsByBead.get(b.id)!} />
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

function SessionPills({ s }: { s: BeadSessionSummary }) {
  if (!s.running && !s.finished && !s.errored) return null;
  return (
    <div className="bead-card-sessions">
      {s.running > 0 && (
        <span
          className="pill session-pill session-running"
          title={`${s.running} running session${s.running === 1 ? "" : "s"}`}
        >
          <span className="session-dot" /> {s.running}
        </span>
      )}
      {s.finished > 0 && (
        <span
          className="pill session-pill session-finished"
          title={`${s.finished} finished session${s.finished === 1 ? "" : "s"}`}
        >
          ✓ {s.finished}
        </span>
      )}
      {s.errored > 0 && (
        <span
          className="pill session-pill session-errored"
          title={`${s.errored} errored session${s.errored === 1 ? "" : "s"}`}
        >
          ! {s.errored}
        </span>
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
  isolate,
  onIsolateChange,
  hasSelection,
  order,
  onOrderChange,
}: {
  hidden: ReadonlySet<BeadDepType>;
  onChange: (next: ReadonlySet<BeadDepType>) => void;
  isolate: boolean;
  onIsolateChange: (v: boolean) => void;
  hasSelection: boolean;
  order: "default" | "hierarchy" | "blockers" | "hybrid";
  onOrderChange: (v: "default" | "hierarchy" | "blockers" | "hybrid") => void;
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
      <label
        style={{ fontSize: "0.8rem", opacity: hasSelection ? 1 : 0.5 }}
        title={hasSelection ? "Dim everything not connected to selected bead" : "Select a bead first"}
      >
        <input
          type="checkbox"
          checked={isolate}
          disabled={!hasSelection}
          onChange={(e) => onIsolateChange(e.target.checked)}
        />
        isolate selection
      </label>
      <label style={{ fontSize: "0.8rem" }}>
        order by:
        <select
          value={order}
          onChange={(e) =>
            onOrderChange(e.target.value as "default" | "hierarchy" | "blockers" | "hybrid")
          }
          title="Choose how to lay out the graph"
        >
          <option value="default">default (all edges)</option>
          <option value="hierarchy">hierarchy (parent → child)</option>
          <option value="blockers">blockers (LR, ready first)</option>
          <option value="hybrid">hybrid (parent + blockers)</option>
        </select>
      </label>
    </div>
  );
}
