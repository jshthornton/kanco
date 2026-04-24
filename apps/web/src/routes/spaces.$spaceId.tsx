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
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Column, Space, Ticket, TicketPrLink } from "@kanco/shared";
import { TicketDrawer } from "../components/TicketDrawer";

interface BoardSearch {
  ticket?: string;
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
      const prev = qc.getQueryData<{ tickets: Ticket[]; columns: Column[]; links: TicketPrLink[] }>([
        "board",
        spaceId,
      ]);
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

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

  const linksByTicket = useMemo(() => {
    const map = new Map<string, TicketPrLink[]>();
    for (const l of board?.links ?? []) {
      const arr = map.get(l.ticket_id) ?? [];
      arr.push(l);
      map.set(l.ticket_id, arr);
    }
    return map;
  }, [board]);

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over) return;
    const activeTicket = board?.tickets.find((t) => t.id === e.active.id);
    if (!activeTicket) return;

    const overId = String(e.over.id);
    let targetColumnId: string | undefined;
    let targetIndex: number;

    if (board?.columns.some((c) => c.id === overId)) {
      targetColumnId = overId;
      targetIndex = (ticketsByColumn.get(overId) ?? []).length;
    } else {
      const overTicket = board?.tickets.find((t) => t.id === overId);
      if (!overTicket) return;
      targetColumnId = overTicket.column_id;
      const arr = ticketsByColumn.get(targetColumnId) ?? [];
      targetIndex = arr.findIndex((t) => t.id === overId);
      if (targetIndex < 0) targetIndex = arr.length;
    }
    if (!targetColumnId) return;

    const destArr = (ticketsByColumn.get(targetColumnId) ?? []).filter((t) => t.id !== activeTicket.id);
    const before = destArr[targetIndex - 1];
    const after = destArr[targetIndex];
    const newPos =
      before && after
        ? (before.position + after.position) / 2
        : before
          ? before.position + 1
          : after
            ? after.position - 1
            : 1;
    move.mutate({ id: activeTicket.id, column_id: targetColumnId, position: newPos });
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
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="board">
          {(board?.columns ?? []).map((col) => (
            <BoardColumn
              key={col.id}
              column={col}
              tickets={ticketsByColumn.get(col.id) ?? []}
              linksByTicket={linksByTicket}
              spaceId={spaceId}
              onOpen={openTicket}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTicket ? <TicketCard ticket={activeTicket} links={linksByTicket.get(activeTicket.id) ?? []} dragging /> : null}
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
  linksByTicket: Map<string, TicketPrLink[]>;
  spaceId: string;
  onOpen: (id: string) => void;
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
          {props.tickets.map((t) => (
            <SortableTicket
              key={t.id}
              ticket={t}
              links={props.linksByTicket.get(t.id) ?? []}
              onOpen={props.onOpen}
            />
          ))}
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
  onOpen,
}: {
  ticket: Ticket;
  links: TicketPrLink[];
  onOpen: (id: string) => void;
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
      className={`card${isDragging ? " dragging" : ""}`}
    >
      <TicketCardBody ticket={ticket} links={links} />
    </div>
  );
}

function TicketCard({
  ticket,
  links,
  dragging,
}: {
  ticket: Ticket;
  links: TicketPrLink[];
  dragging?: boolean;
}) {
  return (
    <div className={`card${dragging ? " dragging" : ""}`}>
      <TicketCardBody ticket={ticket} links={links} />
    </div>
  );
}

function TicketCardBody({ ticket, links }: { ticket: Ticket; links: TicketPrLink[] }) {
  return (
    <>
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
      </div>
    </>
  );
}
