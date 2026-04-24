import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Column, Space, Ticket, TicketPrLink, TicketSessionSummary } from "@kanco/shared";
import { TicketDrawer } from "../components/TicketDrawer";

interface BoardSearch {
  ticket?: string;
}

interface TicketGroup {
  ticket: Ticket;
  parentRef: Ticket | null;
  children: Ticket[];
}

export const Route = createFileRoute("/spaces/$spaceId")({
  component: BoardPage,
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ticket: typeof raw.ticket === "string" ? raw.ticket : undefined,
  }),
});

function BoardPage() {
  const { spaceId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const openTicket = useCallback(
    (id: string) => {
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId },
        search: { ticket: id },
      });
    },
    [navigate, spaceId],
  );
  const closeTicket = useCallback(() => {
    void navigate({ to: "/spaces/$spaceId", params: { spaceId }, search: {} });
  }, [navigate, spaceId]);

  const { data: space } = useQuery({
    queryKey: ["space", spaceId],
    queryFn: () => api.getSpace(spaceId),
  });
  const { data: board } = useQuery({
    queryKey: ["board", spaceId],
    queryFn: () => api.listBoard(spaceId),
    refetchInterval: 60_000,
  });

  const move = useMutation({
    mutationFn: ({ id, column_id, position }: { id: string; column_id: string; position: number }) =>
      api.moveTicket(id, column_id, position, true),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["board", spaceId] });
      const prev = qc.getQueryData<{
        tickets: Ticket[];
        columns: Column[];
        links: TicketPrLink[];
        session_summary: TicketSessionSummary[];
      }>(["board", spaceId]);
      if (prev) {
        qc.setQueryData(["board", spaceId], {
          ...prev,
          tickets: prev.tickets.map((t) =>
            t.id === vars.id ? { ...t, column_id: vars.column_id, position: vars.position } : t,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["board", spaceId], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["board", spaceId] }),
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    columnId: string;
    beforeTicketId: string | null;
  } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const ticketsById = useMemo(() => {
    const map = new Map<string, Ticket>();
    for (const t of board?.tickets ?? []) map.set(t.id, t);
    return map;
  }, [board]);

  const ticketsByColumn = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const c of board?.columns ?? []) map.set(c.id, []);
    for (const t of board?.tickets ?? []) {
      const arr = map.get(t.column_id);
      if (arr) arr.push(t);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [board]);

  const columnGroups = useMemo(() => {
    const map = new Map<string, TicketGroup[]>();
    const childrenByParent = new Map<string, Ticket[]>();
    for (const t of board?.tickets ?? []) {
      if (t.parent_ticket_id) {
        const arr = childrenByParent.get(t.parent_ticket_id) ?? [];
        arr.push(t);
        childrenByParent.set(t.parent_ticket_id, arr);
      }
    }
    for (const arr of childrenByParent.values()) arr.sort((a, b) => a.position - b.position);

    for (const col of board?.columns ?? []) {
      const colTickets = ticketsByColumn.get(col.id) ?? [];
      const used = new Set<string>();
      const groups: TicketGroup[] = [];
      for (const t of colTickets) {
        if (used.has(t.id)) continue;
        const parent = t.parent_ticket_id ? ticketsById.get(t.parent_ticket_id) ?? null : null;
        if (parent && parent.column_id === col.id) continue; // rendered under its parent
        const children = (childrenByParent.get(t.id) ?? []).filter((c) => c.column_id === col.id);
        groups.push({
          ticket: t,
          parentRef: parent && parent.column_id !== col.id ? parent : null,
          children,
        });
        used.add(t.id);
        for (const c of children) used.add(c.id);
      }
      map.set(col.id, groups);
    }
    return map;
  }, [board, ticketsByColumn, ticketsById]);

  const sessionsByTicket = useMemo(() => {
    const map = new Map<string, TicketSessionSummary>();
    for (const s of board?.session_summary ?? []) map.set(s.ticket_id, s);
    return map;
  }, [board]);

  const linksByTicket = useMemo(() => {
    const map = new Map<string, TicketPrLink[]>();
    for (const l of board?.links ?? []) {
      const arr = map.get(l.ticket_id) ?? [];
      arr.push(l);
      map.set(l.ticket_id, arr);
    }
    return map;
  }, [board]);

  const computeDropTarget = useCallback(
    (e: DragOverEvent | DragEndEvent): { columnId: string; beforeTicketId: string | null } | null => {
      if (!e.over) return null;
      const overId = String(e.over.id);
      const activeId = String(e.active.id);
      if (board?.columns.some((c) => c.id === overId)) {
        return { columnId: overId, beforeTicketId: null };
      }
      const overTicket = board?.tickets.find((t) => t.id === overId);
      if (!overTicket) return null;
      const columnId = overTicket.column_id;
      const arr = (ticketsByColumn.get(columnId) ?? []).filter((t) => t.id !== activeId);
      const overIdx = arr.findIndex((t) => t.id === overId);
      const activeRect = e.active.rect.current.translated;
      const overRect = e.over.rect;
      let after = false;
      if (activeRect && overRect) {
        const activeCenter = activeRect.top + activeRect.height / 2;
        const overCenter = overRect.top + overRect.height / 2;
        after = activeCenter > overCenter;
      }
      if (after) {
        const next = arr[overIdx + 1];
        return { columnId, beforeTicketId: next ? next.id : null };
      }
      return { columnId, beforeTicketId: overId };
    },
    [board, ticketsByColumn],
  );

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const handleDragOver = (e: DragOverEvent) => setDropIndicator(computeDropTarget(e));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    setDropIndicator(null);
    const target = computeDropTarget(e);
    if (!target) return;
    const activeTicket = board?.tickets.find((t) => t.id === e.active.id);
    if (!activeTicket) return;

    const destArr = (ticketsByColumn.get(target.columnId) ?? []).filter((t) => t.id !== activeTicket.id);
    const targetIndex = target.beforeTicketId
      ? destArr.findIndex((t) => t.id === target.beforeTicketId)
      : destArr.length;
    const idx = targetIndex < 0 ? destArr.length : targetIndex;
    const before = destArr[idx - 1];
    const after = destArr[idx];
    const newPos =
      before && after
        ? (before.position + after.position) / 2
        : before
          ? before.position + 1
          : after
            ? after.position - 1
            : 1;
    move.mutate({ id: activeTicket.id, column_id: target.columnId, position: newPos });
  };

  const activeTicket = activeId ? board?.tickets.find((t) => t.id === activeId) ?? null : null;

  return (
    <div className="stack">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>{space?.name ?? "…"}</h2>
        {space && <SpaceSettings space={space} />}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setDropIndicator(null);
        }}
      >
        <div className="board">
          {(board?.columns ?? []).map((col) => (
            <BoardColumn
              key={col.id}
              column={col}
              tickets={ticketsByColumn.get(col.id) ?? []}
              groups={columnGroups.get(col.id) ?? []}
              linksByTicket={linksByTicket}
              sessionsByTicket={sessionsByTicket}
              spaceId={spaceId}
              onOpen={openTicket}
              dropIndicator={
                dropIndicator && dropIndicator.columnId === col.id ? dropIndicator : null
              }
            />
          ))}
        </div>
        <DragOverlay>
          {activeTicket ? (
            <TicketCard
              ticket={activeTicket}
              links={linksByTicket.get(activeTicket.id) ?? []}
              sessions={sessionsByTicket.get(activeTicket.id) ?? null}
              dragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <TicketDrawer
        ticketId={search.ticket ?? null}
        onClose={closeTicket}
        onOpenTicket={openTicket}
      />
    </div>
  );
}

function SpaceSettings({ space }: { space: Space }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [repoRoot, setRepoRoot] = useState(space.repo_root ?? "");
  useEffect(() => setRepoRoot(space.repo_root ?? ""), [space.id, space.repo_root]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSpace(space.id, { repo_root: repoRoot.trim() ? repoRoot.trim() : null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["space", space.id] });
      setOpen(false);
    },
  });

  return (
    <div className="row" style={{ gap: 8 }}>
      <button onClick={() => setOpen((v) => !v)}>Settings</button>
      {open && (
        <div className="panel stack" style={{ position: "absolute", right: 24, top: 64, zIndex: 10, minWidth: 360 }}>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Repo root (absolute path)</div>
            <input
              value={repoRoot}
              placeholder="/home/you/code/your-repo"
              onChange={(e) => setRepoRoot(e.target.value)}
            />
          </label>
          <div className="muted" style={{ fontSize: 12 }}>
            Used as the base for `git worktree` when starting agent sessions.
          </div>
          <div className="row">
            <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </button>
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const COLUMN_COLORS: Record<string, string> = {
  todo: "var(--col-todo)",
  planning: "var(--col-planning)",
  "in progress": "var(--col-in-progress)",
  "in review": "var(--col-in-review)",
  done: "var(--col-done)",
};

function BoardColumn(props: {
  column: Column;
  tickets: Ticket[];
  groups: TicketGroup[];
  linksByTicket: Map<string, TicketPrLink[]>;
  sessionsByTicket: Map<string, TicketSessionSummary>;
  spaceId: string;
  onOpen: (id: string) => void;
  dropIndicator: { columnId: string; beforeTicketId: string | null } | null;
}) {
  const qc = useQueryClient();
  const { setNodeRef, isOver } = useDroppable({ id: props.column.id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createTicket({ space_id: props.spaceId, title: title.trim(), column: props.column.name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", props.spaceId] });
      setTitle("");
      setAdding(false);
    },
  });

  const color = COLUMN_COLORS[props.column.name.toLowerCase()] ?? "var(--accent)";

  return (
    <div className="column" style={{ ["--col-color" as string]: color }}>
      <div className="column-header">
        <span className="col-name">
          <span className="col-dot" />
          {props.column.name}
        </span>
        <span className="col-count">{props.tickets.length}</span>
      </div>
      <div ref={setNodeRef} className={`column-body${isOver ? " drop-over" : ""}`}>
        <SortableContext items={props.tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {props.groups.map((g) => (
            <div key={g.ticket.id} className="ticket-group">
              {props.dropIndicator?.beforeTicketId === g.ticket.id && (
                <div className="drop-indicator" aria-hidden />
              )}
              <SortableTicket
                ticket={g.ticket}
                links={props.linksByTicket.get(g.ticket.id) ?? []}
                sessions={props.sessionsByTicket.get(g.ticket.id) ?? null}
                onOpen={props.onOpen}
                parentRef={g.parentRef}
              />
              {g.children.length > 0 && (
                <div className="subtask-list">
                  {g.children.map((c) => (
                    <Fragment key={c.id}>
                      {props.dropIndicator?.beforeTicketId === c.id && (
                        <div className="drop-indicator" aria-hidden />
                      )}
                      <SortableTicket
                        ticket={c}
                        links={props.linksByTicket.get(c.id) ?? []}
                        sessions={props.sessionsByTicket.get(c.id) ?? null}
                        onOpen={props.onOpen}
                        isSubtask
                      />
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          ))}
          {props.dropIndicator && props.dropIndicator.beforeTicketId === null && (
            <div className="drop-indicator" aria-hidden />
          )}
        </SortableContext>
        {adding ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) create.mutate();
            }}
          >
            <input
              autoFocus
              value={title}
              placeholder="Ticket title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (!title.trim()) setAdding(false);
              }}
            />
            <div className="row">
              <button className="primary" type="submit" disabled={create.isPending || !title.trim()}>
                Add
              </button>
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="add-card" onClick={() => setAdding(true)}>
            + Add ticket
          </button>
        )}
      </div>
    </div>
  );
}

function SortableTicket({
  ticket,
  links,
  sessions,
  onOpen,
  parentRef,
  isSubtask,
}: {
  ticket: Ticket;
  links: TicketPrLink[];
  sessions: TicketSessionSummary | null;
  onOpen: (id: string) => void;
  parentRef?: Ticket | null;
  isSubtask?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(ticket.id)}
      className={`card${isDragging ? " dragging" : ""}${isSubtask ? " subtask" : ""}`}
    >
      <TicketCardBody
        ticket={ticket}
        links={links}
        sessions={sessions}
        parentRef={parentRef}
        onOpen={onOpen}
      />
    </div>
  );
}

function TicketCard({
  ticket,
  links,
  sessions,
  dragging,
}: {
  ticket: Ticket;
  links: TicketPrLink[];
  sessions: TicketSessionSummary | null;
  dragging?: boolean;
}) {
  return (
    <div className={`card${dragging ? " dragging" : ""}`}>
      <TicketCardBody ticket={ticket} links={links} sessions={sessions} />
    </div>
  );
}

function SessionPills({ s }: { s: TicketSessionSummary }) {
  if (!s.running && !s.finished && !s.errored) return null;
  return (
    <>
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
    </>
  );
}

function TicketCardBody({
  ticket,
  links,
  sessions,
  parentRef,
  onOpen,
}: {
  ticket: Ticket;
  links: TicketPrLink[];
  sessions: TicketSessionSummary | null;
  parentRef?: Ticket | null;
  onOpen?: (id: string) => void;
}) {
  return (
    <>
      {parentRef && (
        <button
          type="button"
          className="parent-ref"
          title={parentRef.title}
          onClick={(e) => {
            e.stopPropagation();
            onOpen?.(parentRef.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="parent-ref-id">{parentRef.id.slice(0, 6)}</span>
          <span className="parent-ref-title">{parentRef.title}</span>
        </button>
      )}
      <div className="card-title">{ticket.title}</div>
      <div className="card-meta">
        <span className="pill card-id" title={ticket.id}>
          {ticket.id.slice(0, 6)}
        </span>
        {ticket.created_by !== "ui" && <span className="pill">{ticket.created_by}</span>}
        {links.map((l) => (
          <span key={l.id} className={`pill pr-${l.state}`}>
            #{l.number} {l.state}
          </span>
        ))}
        {sessions && <SessionPills s={sessions} />}
      </div>
    </>
  );
}
