import { Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";
import {
  CreateSpaceInput,
  CreateTicketInput,
  LinkPrInput,
  MoveTicketInput,
  StartSessionInput,
  UpdateSpaceInput,
  UpdateTicketInput,
  parsePrUrl,
} from "@kanco/shared";
import {
  createSpace,
  getSpace,
  listBoardColumns,
  listSpaces,
  updateSpace,
} from "../services/spaces.js";
import {
  getSession,
  listTicketSessions,
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
    const space = createSpace(deps.db, body.name, body.repo_root ?? null);
    return c.json(space, 201);
  });

  api.patch("/spaces/:id", async (c) => {
    const body = UpdateSpaceInput.parse({ ...(await c.req.json()), id: c.req.param("id") });
    const space = updateSpace(deps.db, body.id, {
      name: body.name,
      repo_root: body.repo_root,
    });
    return c.json(space);
  });

  api.get("/spaces/:id", (c) => {
    const space = getSpace(deps.db, c.req.param("id"));
    if (!space) return c.json({ error: "not_found" }, 404);
    return c.json(space);
  });

  api.get("/spaces/:id/columns", (c) => c.json(listBoardColumns(deps.db, c.req.param("id"))));

  api.get("/spaces/:id/tickets", (c) => {
    const space_id = c.req.param("id");
    return c.json({
      tickets: listTickets(deps.db, space_id),
      links: listSpacePrLinks(deps.db, space_id),
      columns: listBoardColumns(deps.db, space_id),
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

  return api;
}
