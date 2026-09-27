import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Store } from "@openloungephone/db";
import { migrate, openSqlite } from "@openloungephone/db/node";
import { encode, MAX_MESSAGE_BYTES } from "@openloungephone/protocol";
import {
  buildIceServers,
  type Conn,
  type ConnectionHandler,
  createApi,
  ensureSetupToken,
  Gateway,
  type ServerEnv,
} from "@openloungephone/server-app";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { blobDir, fileBlobStore, openAiTranscriber } from "./adapters.ts";
import { type Config, loadConfig } from "./config.ts";

const KEEPALIVE_MS = 30_000;

/** Installs from before the rename to Open Lounge Phone kept their data in opentincan.sqlite. */
function adoptLegacyDatabase(dataDir: string, dbPath: string): void {
  const legacy = `${dataDir}/opentincan.sqlite`;
  if (existsSync(dbPath) || !existsSync(legacy)) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, dbPath + suffix);
  }
}

export async function start(config: Config) {
  mkdirSync(config.dataDir, { recursive: true });
  const dbPath = `${config.dataDir}/openloungephone.sqlite`;
  adoptLegacyDatabase(config.dataDir, dbPath);
  const { sql, db } = openSqlite(dbPath);
  const applied = migrate(db);

  const env: ServerEnv = {
    store: new Store(sql),
    blobs: fileBlobStore(blobDir(config.dataDir)),
    ...(config.transcribe ? { transcriber: openAiTranscriber(config.transcribe) } : {}),
    defer: (work) => {
      work.catch((e) => console.error("[error] background task failed", e));
    },
    ...(config.publicUrlExplicit ? { publicUrl: config.publicUrl } : {}),
    now: () => Date.now(),
    iceServers: () => buildIceServers(config.ice, Date.now()),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    log: (level, msg, extra) => console[level](`[${level}] ${msg}`, extra ?? ""),
  };
  if (applied.length) env.log("info", "applied migrations", { applied });

  const gateway = new Gateway(env);
  const app = new Hono();
  app.route("/api", createApi(env, gateway));
  const staticSite = (prefix: string, root: string) => {
    if (!existsSync(root)) {
      env.log("warn", `${root} not built; run \`npm run build\` to serve ${prefix}`);
      return;
    }
    const rewrite = (p: string) => p.slice(prefix.length - 1) || "/";
    app.use(`${prefix}*`, serveStatic({ root, rewriteRequestPath: rewrite }));
    // Single-page app fallback.
    app.get(`${prefix}*`, serveStatic({ root, path: "index.html" }));
  };
  staticSite("/device/", config.deviceDir);
  staticSite("/", config.companionDir);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  const attach = (ws: WebSocket, open: (conn: Conn) => ConnectionHandler) => {
    const conn: Conn = {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const handler = open(conn);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text frames only");
      handler.message(data.toString());
    });
    ws.on("close", () => handler.closed());
    ws.on("error", (e) => env.log("warn", "socket error", { error: String(e) }));
  };

  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, KEEPALIVE_MS);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const open =
      path === "/ws/device"
        ? (c: Conn) => gateway.openDevice(c)
        : path === "/ws/app"
          ? (c: Conn) => gateway.openApp(c)
          : undefined;
    if (!open) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, open));
  });

  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const setupToken = await ensureSetupToken(env);
  console.log(`Open Lounge Phone listening on ${config.publicUrl}`);
  if (setupToken) {
    console.log(`\n  First run! Open this link to create your household:\n`);
    console.log(`    ${config.publicUrl}/#setup=${setupToken}\n`);
    console.log(`  The link works once. Restart the server to get a new one.\n`);
  }

  return {
    port,
    setupToken,
    close: async () => {
      clearInterval(keepalive);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const running = await start(loadConfig());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void running.close().then(() => process.exit(0)));
  }
}
