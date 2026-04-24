import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import type { DB } from "../db/client.js";
import type { GqlClient } from "../github/gql.js";

export interface McpHandlerDeps {
  db: DB;
  gql: GqlClient;
}

/**
 * Returns a raw Node http handler for the MCP Streamable HTTP transport.
 * A fresh server+transport pair is created per request. Fine for local
 * single-user use; revisit if we support many concurrent MCP clients.
 */
export function makeMcpHandler(deps: McpHandlerDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer({ db: deps.db, gql: deps.gql });
    await server.connect(transport);

    let body: unknown = undefined;
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end("invalid json");
          return;
        }
      }
    }

    try {
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[mcp] handler error", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("mcp error");
      } else {
        res.end();
      }
    }
  };
}
