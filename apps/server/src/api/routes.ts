import { Hono, type Context } from "hono";
import { z } from "zod";
import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";
import {
  AddDepInput,
  CreateBeadInput,
  CreateGateInput,
  CreateSpaceInput,
  CreateTicketInput,
  LinkPrInput,
  MoveTicketInput,
  StartBeadSessionInput,
  StartSessionInput,
  UpdateBeadInput,
  UpdateSpaceInput,
  UpdateTicketInput,
  parsePrUrl,
  type Bead,
  type BeadGraph,
  type BeadGraphEdge,
} from "@kanco/shared";
import {
  beadsForSpace,
  createSpace,
  getSpace,
  listBoardColumns,
  listSpaceRepos,
  listSpaces,
  updateSpace,
} from "../services/spaces.js";
import { schedulePush } from "../services/beads/auto-push.js";
import {
  getSession,
  listBeadSessions,
  listSpaceBeadSessionSummary,
  listSpaceSessionSummary,
  listTicketSessions,
  startBeadSession,
  startSession,
  tailSessionLog,
} from "../services/sessions.js";
import {
  createTicket,
  deleteTicket,
  getTicket,
  listSubtasks,
  listTicketPrLinks,
  listTickets,
  listSpacePrLinks,
  moveTicket,
  updateTicket,
} from "../services/tickets.js";
import { linkPr, unlinkPr } from "../services/pr-links.js";
import { maybeTransition } from "../workers/pr-poller.js";
import {
  advancePending,
  pruneExpiredSessions,
  recordPending,
  startDeviceFlow,
  getPending,
} from "../github/device-flow.js";
import { clearToken, getConnectionStatus } from "../github/tokens.js";
import { nanoid } from "nanoid";
import { onChange } from "../events.js";
import { streamSSE } from "hono/streaming";

export interface ApiDeps {
  db: DB;
  gql: GqlClient;
  secretKey: Buffer;
  ghClientId: string;
}

export function buildApi(deps: ApiDeps): Hono {
  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true }));

  // Server-Sent Events stream. Any mutation emits a change event; connected
  // clients invalidate their queries.
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsub = onChange((e) => {
        void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, 25_000);
      await stream.writeSSE({ event: "ready", data: "" });
      // Block here until the client disconnects. Hono fires onAbort on close.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      unsub();
    }),
  );

  // ---- spaces ----

  api.get("/spaces", (c) => c.json(listSpaces(deps.db)));

  api.post("/spaces", async (c) => {
    const body = CreateSpaceInput.parse(await c.req.json());
    const space = createSpace(
      deps.db,
      body.name,
      body.repo_root ?? null,
      body.dolt_remote_url ?? null,
    );
    return c.json(space, 201);
  });

  api.patch("/spaces/:id", async (c) => {
    const body = UpdateSpaceInput.parse({ ...(await c.req.json()), id: c.req.param("id") });
    const space = updateSpace(deps.db, body.id, {
      name: body.name,
      repo_root: body.repo_root,
      dolt_remote_url: body.dolt_remote_url,
    });
    return c.json(space);
  });

  api.get("/spaces/:id", (c) => {
    const space = getSpace(deps.db, c.req.param("id"));
    if (!space) return c.json({ error: "not_found" }, 404);
    return c.json(space);
  });

  api.get("/spaces/:id/columns", (c) => c.json(listBoardColumns(deps.db, c.req.param("id"))));

  api.get("/spaces/:id/repos", async (c) =>
    c.json(await listSpaceRepos(deps.db, c.req.param("id"))),
  );

  api.get("/spaces/:id/tickets", (c) => {
    const space_id = c.req.param("id");
    return c.json({
      tickets: listTickets(deps.db, space_id),
      links: listSpacePrLinks(deps.db, space_id),
      columns: listBoardColumns(deps.db, space_id),
      session_summary: listSpaceSessionSummary(deps.db, space_id),
    });
  });

  // ---- tickets ----

  api.post("/tickets", async (c) => {
    const body = CreateTicketInput.parse(await c.req.json());
    const ticket = createTicket(deps.db, {
      space_id: body.space_id,
      title: body.title,
      body: body.body ?? null,
      column_name: body.column,
      parent_ticket_id: body.parent_ticket_id ?? null,
      created_by: body.created_by,
    });
    return c.json(ticket, 201);
  });

  api.get("/tickets/:id", (c) => {
    const t = getTicket(deps.db, c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    return c.json({
      ticket: t,
      links: listTicketPrLinks(deps.db, t.id),
      subtasks: listSubtasks(deps.db, t.id),
    });
  });

  api.patch("/tickets/:id", async (c) => {
    const body = UpdateTicketInput.parse({ ...(await c.req.json()), id: c.req.param("id") });
    return c.json(updateTicket(deps.db, body.id, body));
  });

  api.delete("/tickets/:id", (c) => {
    deleteTicket(deps.db, c.req.param("id"));
    return c.json({ ok: true });
  });

  api.post("/tickets/:id/move", async (c) => {
    const body = MoveTicketInput.parse({ ...(await c.req.json()), id: c.req.param("id") });
    return c.json(moveTicket(deps.db, body));
  });

  // ---- pr links ----

  api.post("/tickets/:id/links", async (c) => {
    const body = LinkPrInput.parse({ ...(await c.req.json()), ticket_id: c.req.param("id") });
    if (!parsePrUrl(body.pr_url)) return c.json({ error: "invalid_pr_url" }, 400);
    const link = linkPr(deps.db, body.ticket_id, body.pr_url);
    // Act on the link's default "open" state right away — don't gate the
    // transition on a successful GitHub fetch (private repos / missing scope
    // would otherwise leave the ticket stuck).
    maybeTransition(deps.db, body.ticket_id);
    // fire-and-forget sync to fill in real state/title/head_sha
    void (async () => {
      try {
        const info = await deps.gql.fetchPullRequest(link.owner, link.repo, link.number);
        if (info) {
          deps.db
            .prepare(
              `UPDATE ticket_pr_links SET state = ?, title = ?, head_sha = ?, last_synced_at = ? WHERE id = ?`,
            )
            .run(info.state, info.title, info.headRefOid, Date.now(), link.id);
          maybeTransition(deps.db, body.ticket_id);
        }
      } catch (err) {
        console.error("[links] initial sync failed", err);
      }
    })();
    return c.json(link, 201);
  });

  api.delete("/links/:linkId", (c) => {
    unlinkPr(deps.db, c.req.param("linkId"));
    return c.json({ ok: true });
  });

  // ---- agent sessions ----

  api.get("/tickets/:id/sessions", (c) =>
    c.json(listTicketSessions(deps.db, c.req.param("id"))),
  );

  api.post("/tickets/:id/sessions", async (c) => {
    const body = StartSessionInput.parse({
      ...(await c.req.json().catch(() => ({}))),
      ticket_id: c.req.param("id"),
    });
    try {
      const session = startSession(deps.db, {
        ticket_id: body.ticket_id,
        agent: body.agent,
        worktree: body.worktree,
        include_parent: body.include_parent,
      });
      return c.json(session, 201);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? (err as { code: string }).code : "error";
      const message = err instanceof Error ? err.message : "unknown";
      return c.json({ error: code, message }, 400);
    }
  });

  api.get("/sessions/:id", (c) => {
    const s = getSession(deps.db, c.req.param("id"));
    if (!s) return c.json({ error: "not_found" }, 404);
    return c.json({ session: s, log_tail: tailSessionLog(s.log_path) });
  });

  // ---- github auth ----

  api.get("/auth/github/status", (c) => c.json(getConnectionStatus(deps.db)));

  const StartInput = z.object({}).optional();
  api.post("/auth/github/start", async (c) => {
    void StartInput;
    if (!deps.ghClientId) return c.json({ error: "no_client_id" }, 400);
    try {
      pruneExpiredSessions(deps.db);
      const code = await startDeviceFlow(deps.ghClientId);
      const session_id = nanoid(16);
      recordPending(deps.db, session_id, code);
      return c.json({
        session_id,
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        expires_in: code.expires_in,
        interval: code.interval,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      const code =
        err instanceof Error && "code" in err ? (err as { code: string }).code : "error";
      return c.json({ error: code, message: msg }, 400);
    }
  });

  api.post("/auth/github/poll", async (c) => {
    const { session_id } = (await c.req.json()) as { session_id?: string };
    if (!session_id) return c.json({ error: "missing_session_id" }, 400);
    if (!getPending(deps.db, session_id)) {
      // Session may have been cleared after a successful exchange — if we
      // already have a token, report authorized so a late poll doesn't look
      // like failure.
      if (getConnectionStatus(deps.db).connected) return c.json({ status: "authorized" });
      return c.json({ error: "unknown_session" }, 404);
    }
    const result = await advancePending(deps.ghClientId, session_id, deps.db, deps.secretKey);
    return c.json(result);
  });

  api.post("/auth/github/disconnect", (c) => {
    clearToken(deps.db);
    return c.json({ ok: true });
  });

  // ---- beads ----

  function beadsClientFor(space_id: string) {
    try {
      return beadsForSpace(deps.db, space_id);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? (err as { code: string }).code : "error";
      const message = err instanceof Error ? err.message : String(err);
      const status = code === "no_repo_root" ? 400 : 404;
      throw Object.assign(new Error(message), { http: { status, code } });
    }
  }

  function handleBeadsErr(c: Context, err: unknown) {
    const e = err as { http?: { status: number; code: string }; message?: string };
    const status = e.http?.status ?? 500;
    const code = e.http?.code ?? "error";
    return c.json({ error: code, message: e.message ?? String(err) }, status as 400 | 404 | 500);
  }

  api.get("/spaces/:id/beads", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      const status = c.req.query("status");
      const limitRaw = c.req.query("limit");
      const labels = c.req.queries("label") ?? [];
      const parent = c.req.query("parent") || undefined;
      const q = c.req.query("q") || undefined;
      const includeClosed = c.req.query("include_closed") === "1";
      const beads = await client.list({
        status: status ? (status as never) : undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        label: labels.length > 0 ? labels : undefined,
        parent,
        q,
        includeClosed,
      });
      return c.json(beads);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.get("/spaces/:id/labels", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      const beads = await client.listAll({ includeClosed: true });
      const set = new Set<string>();
      for (const b of beads) for (const l of b.labels ?? []) set.add(l);
      return c.json([...set].sort());
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.get("/spaces/:id/beads/:beadId", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      const bead = await client.show(c.req.param("beadId"));
      if (!bead) return c.json({ error: "not_found" }, 404);
      return c.json(bead);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.post("/spaces/:id/beads", async (c) => {
    try {
      const body = CreateBeadInput.parse(await c.req.json());
      const client = beadsClientFor(c.req.param("id"));
      const bead = await client.create(body);
      if (body.ready === false) {
        await client.addGate({
          blocks: bead.id,
          type: "human",
          reason: "needs more human input",
        });
      }
      schedulePush(client);
      return c.json(bead, 201);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.patch("/spaces/:id/beads/:beadId", async (c) => {
    try {
      const body = UpdateBeadInput.parse(await c.req.json());
      const client = beadsClientFor(c.req.param("id"));
      const bead = await client.update(c.req.param("beadId"), body);
      schedulePush(client);
      return c.json(bead);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.delete("/spaces/:id/beads/:beadId", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      await client.close(c.req.param("beadId"));
      schedulePush(client);
      return c.json({ ok: true });
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.post("/spaces/:id/beads/:beadId/deps", async (c) => {
    try {
      const body = AddDepInput.parse(await c.req.json());
      const client = beadsClientFor(c.req.param("id"));
      await client.addDep(c.req.param("beadId"), body.depends_on, body.type);
      schedulePush(client);
      return c.json({ ok: true }, 201);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.delete("/spaces/:id/beads/:beadId/deps/:dependsOn", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      await client.removeDep(c.req.param("beadId"), c.req.param("dependsOn"));
      schedulePush(client);
      return c.json({ ok: true });
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.post("/spaces/:id/beads/:beadId/gates", async (c) => {
    try {
      const body = CreateGateInput.parse(await c.req.json());
      const client = beadsClientFor(c.req.param("id"));
      const gate = await client.addGate({
        blocks: c.req.param("beadId"),
        type: body.type,
        awaitId: body.await_id,
        reason: body.reason,
      });
      schedulePush(client);
      return c.json(gate, 201);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.post("/spaces/:id/gates/:gateId/resolve", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      await client.resolveGate(c.req.param("gateId"));
      schedulePush(client);
      return c.json({ ok: true });
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.get("/spaces/:id/graph", async (c) => {
    try {
      const client = beadsClientFor(c.req.param("id"));
      const parent = c.req.query("parent") || undefined;
      const labels = c.req.queries("label") ?? [];
      const q = (c.req.query("q") || "").trim().toLowerCase();
      const all = await client.listAll({ includeClosed: true });
      let nonGate = all.filter((b) => b.issue_type !== "gate");
      if (labels.length > 0) {
        nonGate = nonGate.filter((b) => {
          const have = b.labels ?? [];
          return labels.every((l) => have.includes(l));
        });
      }
      if (q) {
        nonGate = nonGate.filter((b) =>
          `${b.title}\n${b.description ?? ""}\n${b.id}`.toLowerCase().includes(q),
        );
      }
      // Filter by parent — keep the parent bead itself plus its full descendant
      // tree. Walks both the `parent` field AND any dependency edge of type
      // `parent-child` (since users can `bd dep add … --type parent-child`
      // without populating the parent field).
      if (parent) {
        const childrenOf = new Map<string, string[]>();
        const addChild = (parentId: string, childId: string) => {
          const arr = childrenOf.get(parentId) ?? [];
          if (!arr.includes(childId)) arr.push(childId);
          childrenOf.set(parentId, arr);
        };
        for (const b of nonGate) {
          if (b.parent) addChild(b.parent, b.id);
          for (const d of b.dependencies ?? []) {
            const targetId = "depends_on_id" in d ? d.depends_on_id : d.id;
            const depType =
              "type" in d && typeof d.type === "string"
                ? d.type
                : "dependency_type" in d
                  ? d.dependency_type
                  : null;
            if (depType === "parent-child") addChild(targetId, b.id);
          }
        }
        const keep = new Set<string>([parent]);
        const stack = [parent];
        while (stack.length) {
          const id = stack.pop()!;
          for (const c of childrenOf.get(id) ?? []) {
            if (!keep.has(c)) {
              keep.add(c);
              stack.push(c);
            }
          }
        }
        nonGate = nonGate.filter((b) => keep.has(b.id));
      }
      const idSet = new Set(nonGate.map((b) => b.id));
      const edges: BeadGraphEdge[] = [];
      for (const b of nonGate) {
        // Parent-child edges from bead.parent (if bd export form puts them there)
        if (b.parent && idSet.has(b.parent)) {
          edges.push({ from: b.id, to: b.parent, type: "parent-child" });
        }
        for (const dep of b.dependencies ?? []) {
          const targetId = "depends_on_id" in dep ? dep.depends_on_id : dep.id;
          const depType =
            "type" in dep && typeof dep.type === "string"
              ? dep.type
              : "dependency_type" in dep
                ? dep.dependency_type
                : "blocks";
          if (!idSet.has(targetId)) continue;
          // Skip gate edges in graph view
          if ("issue_type" in dep && dep.issue_type === "gate") continue;
          // Avoid double parent-child edge (already added from .parent field)
          if (depType === "parent-child" && b.parent === targetId) continue;
          edges.push({ from: b.id, to: targetId, type: depType as BeadGraphEdge["type"] });
        }
      }
      const graph: BeadGraph = { nodes: nonGate, edges };
      return c.json(graph);
    } catch (err) {
      return handleBeadsErr(c, err);
    }
  });

  api.get("/spaces/:id/bead-sessions-summary", (c) =>
    c.json(listSpaceBeadSessionSummary(deps.db, c.req.param("id"))),
  );

  api.get("/spaces/:id/beads/:beadId/sessions", (c) =>
    c.json(listBeadSessions(deps.db, c.req.param("id"), c.req.param("beadId"))),
  );

  api.post("/spaces/:id/beads/:beadId/sessions", async (c) => {
    const body = StartBeadSessionInput.parse(await c.req.json().catch(() => ({})));
    try {
      const session = startBeadSession(deps.db, {
        space_id: c.req.param("id"),
        bead_id: c.req.param("beadId"),
        agent: body.agent,
        worktree: body.worktree,
      });
      return c.json(session, 201);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? (err as { code: string }).code : "error";
      const message = err instanceof Error ? err.message : "unknown";
      return c.json({ error: code, message }, 400);
    }
  });

  return api;
}
