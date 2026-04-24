import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db/client.js";
import { buildApi } from "./api/routes.js";
import { makeGqlClient } from "./github/gql.js";
import { resolveSecret } from "./github/crypto.js";
import { startPoller } from "./workers/pr-poller.js";
import { makeMcpHandler } from "./mcp/http.js";
import { recoverOrphanSessions, startOrphanReaper } from "./services/sessions.js";

const DATA_DIR = process.env.KANCO_DATA_DIR ?? "./kanco-data";
const PORT = Number(process.env.KANCO_PORT ?? 8787);
const HOST = process.env.KANCO_HOST ?? "0.0.0.0";
// Public Client ID of the shared "kanco-board" GitHub App. Baked in so users
// don't need to register their own. Override with KANCO_GH_CLIENT_ID for forks.
const DEFAULT_GH_CLIENT_ID = "Iv23lijl9awJl5CoxL49";
const GH_CLIENT_ID = process.env.KANCO_GH_CLIENT_ID || DEFAULT_GH_CLIENT_ID;
const STATIC_DIR = process.env.KANCO_STATIC_DIR ?? "./public";

const db = openDb(join(DATA_DIR, "kanco.db"));
const secretKey = resolveSecret(DATA_DIR);
const gql = makeGqlClient(db, secretKey, GH_CLIENT_ID);
recoverOrphanSessions(db);
const stopOrphanReaper = startOrphanReaper(db);

const app = new Hono();
app.route("/api", buildApi({ db, gql, secretKey, ghClientId: GH_CLIENT_ID }));

const indexHtmlPath = join(STATIC_DIR, "index.html");
const hasSpa = existsSync(indexHtmlPath);

if (hasSpa) {
  // Serve any static asset that exists (logo.svg, /assets/*, favicon, etc.);
  // serveStatic calls next() on miss so the SPA fallback below still fires.
  app.use("*", serveStatic({ root: STATIC_DIR }));
  app.get("*", (c) => c.html(readFileSync(indexHtmlPath, "utf8")));
} else {
  app.get("/", (c) =>
    c.text(
      "kanco server is running. The SPA build was not found — build apps/web and copy its dist/ to apps/server/public/.",
    ),
  );
}

const mcpHandler = makeMcpHandler({ db, gql });
const honoListener = getRequestListener(app.fetch);
const stopPoller = startPoller(db, gql);

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? "";
  if (path === "/mcp") {
    void mcpHandler(req, res);
    return;
  }
  void honoListener(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[kanco] listening on http://${HOST}:${PORT}`);
  console.log(`[kanco] data dir: ${DATA_DIR}`);
  console.log(
    `[kanco] gh client id: ${GH_CLIENT_ID ? "configured" : "MISSING (set KANCO_GH_CLIENT_ID)"}`,
  );
  console.log(`[kanco] MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    console.log("[kanco] force exit");
    process.exit(1);
  }
  shuttingDown = true;
  console.log("[kanco] shutting down");
  stopPoller();
  stopOrphanReaper();
  server.close(() => process.exit(0));
  // SSE streams (/api/events) keep sockets open indefinitely — drop them so
  // close() can resolve. Available in Node 18.2+.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  setTimeout(() => {
    console.log("[kanco] shutdown timed out, force exiting");
    process.exit(1);
  }, 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
