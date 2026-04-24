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
  createSpace,
  getSpace,
  listColumns,
  listSpaces,
} from "../services/spaces.js";
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

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}

export function createMcpTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
