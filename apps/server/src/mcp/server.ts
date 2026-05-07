import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";
import {
  beadsForSpace,
  createSpace,
  getSpace,
  listColumns,
  listSpaces,
} from "../services/spaces.js";
import { schedulePush } from "../services/beads/auto-push.js";
import {
  createTicket,
  getTicket,
  listSubtasks,
  listTicketPrLinks,
  listTickets,
  moveTicket,
  updateTicket,
} from "../services/tickets.js";
import { linkPr, unlinkPr } from "../services/pr-links.js";
import { maybeTransition } from "../workers/pr-poller.js";
import { parsePrUrl } from "@kanco/shared";

export interface McpDeps {
  db: DB;
  gql: GqlClient;
}

// Zod → JSON schema (inline, minimal — MCP needs plain JSON Schema for tool inputs)
function obj(
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties: props, required, additionalProperties: false };
}
const s = { type: "string" } as const;
const sOpt = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;

const tools = [
  {
    name: "list_spaces",
    description: "List all kanban spaces (top-level boards).",
    inputSchema: obj({}),
  },
  {
    name: "create_space",
    description: "Create a new space. Default columns (Todo, Planning, In Progress, In Review, Done) are seeded.",
    inputSchema: obj({ name: s }, ["name"]),
  },
  {
    name: "list_tickets",
    description: "List tickets in a space. Optionally filter to a single column name.",
    inputSchema: obj({ space_id: s, column: sOpt }, ["space_id"]),
  },
  {
    name: "get_ticket",
    description: "Fetch a single ticket with its PR links and subtasks.",
    inputSchema: obj({ id: s }, ["id"]),
  },
  {
    name: "create_ticket",
    description:
      "Create a ticket in a space. Defaults to the Todo column. Set parent_ticket_id to create a subtask.",
    inputSchema: obj(
      {
        space_id: s,
        title: s,
        body: sOpt,
        column: sOpt,
        parent_ticket_id: sOpt,
      },
      ["space_id", "title"],
    ),
  },
  {
    name: "create_subtask",
    description: "Create a subtask under an existing ticket. Shorthand for create_ticket with a parent.",
    inputSchema: obj({ parent_ticket_id: s, title: s, body: sOpt }, ["parent_ticket_id", "title"]),
  },
  {
    name: "update_ticket",
    description: "Update a ticket's title or body.",
    inputSchema: obj({ id: s, title: sOpt, body: sOpt }, ["id"]),
  },
  {
    name: "move_ticket",
    description:
      "Move a ticket to a named column (e.g. 'In Progress'). Counts as a manual move and suppresses automatic PR-driven transitions for 1h.",
    inputSchema: obj({ id: s, column: s }, ["id", "column"]),
  },
  {
    name: "link_pr",
    description:
      "Link a GitHub pull request URL to a ticket. The ticket will then auto-move based on PR state (open → In Review, merged → Done, closed → Todo).",
    inputSchema: obj({ ticket_id: s, pr_url: s }, ["ticket_id", "pr_url"]),
  },
  {
    name: "unlink_pr",
    description: "Remove a PR link from a ticket by link id.",
    inputSchema: obj({ link_id: s }, ["link_id"]),
  },
  // ---- beads (frontend for the `bd` CLI) ----
  {
    name: "list_beads",
    description: "List beads in a space. Optional status filter (open|in_progress|blocked|closed|deferred|pinned|hooked).",
    inputSchema: obj({ space_id: s, status: sOpt }, ["space_id"]),
  },
  {
    name: "get_bead",
    description: "Show a bead with its dependencies, dependents, and gates.",
    inputSchema: obj({ space_id: s, bead_id: s }, ["space_id", "bead_id"]),
  },
  {
    name: "create_bead",
    description: "Create a bead. Default issue_type is 'task'. Auto-pushes to the configured Dolt remote.",
    inputSchema: obj(
      {
        space_id: s,
        title: s,
        description: sOpt,
        issue_type: sOpt,
        priority: num,
      },
      ["space_id", "title"],
    ),
  },
  {
    name: "update_bead",
    description: "Update a bead's title, description, status, or priority. Status enum: open|in_progress|blocked|closed|deferred|pinned|hooked.",
    inputSchema: obj(
      {
        space_id: s,
        bead_id: s,
        title: sOpt,
        description: sOpt,
        status: sOpt,
        priority: num,
      },
      ["space_id", "bead_id"],
    ),
  },
  {
    name: "close_bead",
    description: "Close a bead.",
    inputSchema: obj({ space_id: s, bead_id: s }, ["space_id", "bead_id"]),
  },
  {
    name: "add_bead_dep",
    description: "Link bead_id to depends_on with a dependency type (blocks|tracks|related|parent-child|discovered-from). Default: blocks.",
    inputSchema: obj(
      { space_id: s, bead_id: s, depends_on: s, type: sOpt },
      ["space_id", "bead_id", "depends_on"],
    ),
  },
  {
    name: "add_bead_gate",
    description: "Attach an async gate that blocks a bead until resolved. type ∈ human|timer|gh:run|gh:pr|bead. For gh:pr, await_id is the PR number.",
    inputSchema: obj(
      { space_id: s, bead_id: s, type: s, await_id: s, reason: sOpt },
      ["space_id", "bead_id", "type", "await_id"],
    ),
  },
  {
    name: "get_bead_graph",
    description: "Return all non-gate beads with their cross-bead dependency edges as { nodes, edges }. Use for graph visualizations.",
    inputSchema: obj({ space_id: s }, ["space_id"]),
  },
  {
    name: "dolt_push",
    description: "Force a `bd dolt push` for a space. Auto-push runs after every write so manual invocation is rare.",
    inputSchema: obj({ space_id: s }, ["space_id"]),
  },
] as const;

type ToolName = (typeof tools)[number]["name"];

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(deps: McpDeps, clientLabel: string = "mcp"): Server {
  const server = new Server(
    { name: "kanco", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as ToolName;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "list_spaces":
        return textResult(listSpaces(deps.db));

      case "create_space": {
        const { name: spaceName } = z.object({ name: z.string().min(1) }).parse(args);
        return textResult(createSpace(deps.db, spaceName));
      }

      case "list_tickets": {
        const { space_id, column } = z
          .object({ space_id: z.string(), column: z.string().optional() })
          .parse(args);
        let tickets = listTickets(deps.db, space_id);
        if (column) {
          const cols = listColumns(deps.db, space_id);
          const col = cols.find((c) => c.name.toLowerCase() === column.toLowerCase());
          if (col) tickets = tickets.filter((t) => t.column_id === col.id);
        }
        return textResult(tickets);
      }

      case "get_ticket": {
        const { id } = z.object({ id: z.string() }).parse(args);
        const t = getTicket(deps.db, id);
        if (!t) throw new Error(`ticket ${id} not found`);
        return textResult({
          ticket: t,
          links: listTicketPrLinks(deps.db, id),
          subtasks: listSubtasks(deps.db, id),
        });
      }

      case "create_ticket": {
        const p = z
          .object({
            space_id: z.string(),
            title: z.string().min(1),
            body: z.string().optional(),
            column: z.string().optional(),
            parent_ticket_id: z.string().optional(),
          })
          .parse(args);
        if (!getSpace(deps.db, p.space_id)) throw new Error(`space ${p.space_id} not found`);
        const t = createTicket(deps.db, {
          space_id: p.space_id,
          title: p.title,
          body: p.body ?? null,
          column_name: p.column,
          parent_ticket_id: p.parent_ticket_id ?? null,
          created_by: `mcp:${clientLabel}`,
        });
        return textResult(t);
      }

      case "create_subtask": {
        const p = z
          .object({
            parent_ticket_id: z.string(),
            title: z.string().min(1),
            body: z.string().optional(),
          })
          .parse(args);
        const parent = getTicket(deps.db, p.parent_ticket_id);
        if (!parent) throw new Error(`parent ticket ${p.parent_ticket_id} not found`);
        const t = createTicket(deps.db, {
          space_id: parent.space_id,
          title: p.title,
          body: p.body ?? null,
          parent_ticket_id: parent.id,
          created_by: `mcp:${clientLabel}`,
        });
        return textResult(t);
      }

      case "update_ticket": {
        const p = z
          .object({ id: z.string(), title: z.string().optional(), body: z.string().optional() })
          .parse(args);
        return textResult(updateTicket(deps.db, p.id, p));
      }

      case "move_ticket": {
        const p = z.object({ id: z.string(), column: z.string() }).parse(args);
        const t = getTicket(deps.db, p.id);
        if (!t) throw new Error(`ticket ${p.id} not found`);
        const cols = listColumns(deps.db, t.space_id);
        const col = cols.find((c) => c.name.toLowerCase() === p.column.toLowerCase());
        if (!col) throw new Error(`column '${p.column}' not found in space`);
        const maxPos = deps.db
          .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM tickets WHERE column_id = ?`)
          .get(col.id) as { m: number };
        return textResult(
          moveTicket(deps.db, { id: p.id, column_id: col.id, position: maxPos.m + 1, manual: true }),
        );
      }

      case "link_pr": {
        const p = z.object({ ticket_id: z.string(), pr_url: z.string() }).parse(args);
        if (!parsePrUrl(p.pr_url)) throw new Error("invalid PR URL");
        const link = linkPr(deps.db, p.ticket_id, p.pr_url);
        try {
          const info = await deps.gql.fetchPullRequest(link.owner, link.repo, link.number);
          if (info) {
            deps.db
              .prepare(
                `UPDATE ticket_pr_links SET state = ?, title = ?, head_sha = ?, last_synced_at = ? WHERE id = ?`,
              )
              .run(info.state, info.title, info.headRefOid, Date.now(), link.id);
            maybeTransition(deps.db, p.ticket_id);
          }
        } catch (err) {
          console.error("[mcp.link_pr] initial sync failed", err);
        }
        return textResult(
          deps.db.prepare(`SELECT * FROM ticket_pr_links WHERE id = ?`).get(link.id),
        );
      }

      case "unlink_pr": {
        const { link_id } = z.object({ link_id: z.string() }).parse(args);
        unlinkPr(deps.db, link_id);
        return textResult({ ok: true });
      }

      // ---- beads ----

      case "list_beads": {
        const p = z
          .object({ space_id: z.string(), status: z.string().optional() })
          .parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        const list = await client.list({ status: p.status as never });
        return textResult(list);
      }

      case "get_bead": {
        const p = z.object({ space_id: z.string(), bead_id: z.string() }).parse(args);
        const bead = await beadsForSpace(deps.db, p.space_id).show(p.bead_id);
        if (!bead) throw new Error(`bead ${p.bead_id} not found`);
        return textResult(bead);
      }

      case "create_bead": {
        const p = z
          .object({
            space_id: z.string(),
            title: z.string().min(1),
            description: z.string().optional(),
            issue_type: z.string().optional(),
            priority: z.number().int().optional(),
          })
          .parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        const bead = await client.create({
          title: p.title,
          description: p.description,
          issue_type: (p.issue_type ?? "task") as never,
          priority: p.priority,
        });
        schedulePush(client);
        return textResult(bead);
      }

      case "update_bead": {
        const p = z
          .object({
            space_id: z.string(),
            bead_id: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
            status: z.string().optional(),
            priority: z.number().int().optional(),
          })
          .parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        const bead = await client.update(p.bead_id, {
          title: p.title,
          description: p.description,
          status: p.status as never,
          priority: p.priority,
        });
        schedulePush(client);
        return textResult(bead);
      }

      case "close_bead": {
        const p = z.object({ space_id: z.string(), bead_id: z.string() }).parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        await client.close(p.bead_id);
        schedulePush(client);
        return textResult({ ok: true });
      }

      case "add_bead_dep": {
        const p = z
          .object({
            space_id: z.string(),
            bead_id: z.string(),
            depends_on: z.string(),
            type: z.string().optional(),
          })
          .parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        await client.addDep(p.bead_id, p.depends_on, (p.type ?? "blocks") as never);
        schedulePush(client);
        return textResult({ ok: true });
      }

      case "add_bead_gate": {
        const p = z
          .object({
            space_id: z.string(),
            bead_id: z.string(),
            type: z.string(),
            await_id: z.string(),
            reason: z.string().optional(),
          })
          .parse(args);
        const client = beadsForSpace(deps.db, p.space_id);
        const gate = await client.addGate({
          blocks: p.bead_id,
          type: p.type as never,
          awaitId: p.await_id,
          reason: p.reason,
        });
        schedulePush(client);
        return textResult(gate);
      }

      case "get_bead_graph": {
        const { space_id } = z.object({ space_id: z.string() }).parse(args);
        const client = beadsForSpace(deps.db, space_id);
        const all = await client.listAll({ includeClosed: true });
        const nonGate = all.filter((b) => b.issue_type !== "gate");
        const idSet = new Set(nonGate.map((b) => b.id));
        const edges = nonGate.flatMap((b) => {
          const out: { from: string; to: string; type: string }[] = [];
          if (b.parent && idSet.has(b.parent))
            out.push({ from: b.id, to: b.parent, type: "parent-child" });
          for (const d of b.dependencies ?? []) {
            const targetId = "depends_on_id" in d ? d.depends_on_id : d.id;
            const depType =
              "type" in d && typeof d.type === "string"
                ? d.type
                : "dependency_type" in d
                  ? d.dependency_type
                  : "blocks";
            if (!idSet.has(targetId)) continue;
            if ("issue_type" in d && d.issue_type === "gate") continue;
            if (depType === "parent-child" && b.parent === targetId) continue;
            out.push({ from: b.id, to: targetId, type: depType });
          }
          return out;
        });
        return textResult({ nodes: nonGate, edges });
      }

      case "dolt_push": {
        const { space_id } = z.object({ space_id: z.string() }).parse(args);
        const client = beadsForSpace(deps.db, space_id);
        const result = await client.doltPush();
        return textResult(result);
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}

export function createMcpTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
