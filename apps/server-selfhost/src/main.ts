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
  FedCalls,
  federationApp,
  Gateway,
  LinkRegistry,
  type LinkSocket,
  presenceFlusher,
  presenceHook,
  type ServerEnv,
  type ServerLink,
  STREAM_PATH,
  sweepSpace,
} from "@openloungephone/server-app";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import {
  blobDir,
  federationKeyFile,
  fileBlobStore,
  loopbackFetch,
  openAiTranscriber,
} from "./adapters.ts";
import { type Config, loadConfig } from "./config.ts";

const KEEPALIVE_MS = 30_000;
/** Expired history is deleted once a day here (a Durable Object host sweeps on activity). */
const SWEEP_MS = 24 * 60 * 60 * 1000;

/** Installs from before the rename to Open Lounge Phone kept their data in opentincan.sqlite. */
function adoptLegacyDatabase(dataDir: string, dbPath: string): void {
  const legacy = `${dataDir}/opentincan.sqlite`;
  if (existsSync(dbPath) || !existsSync(legacy)) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, dbPath + suffix);
  }
}

/** A `ws` socket as a server-pair stream socket. */
function streamSocket(ws: WebSocket): LinkSocket {
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

function wireStream(ws: WebSocket, sock: LinkSocket, link: ServerLink): void {
  ws.on("message", (data, isBinary) => {
    if (!isBinary) void link.receive(sock, data.toString());
  });
  ws.on("close", () => link.closed(sock));
  ws.on("error", () => link.closed(sock));
}

/** Dials another server's stream; `*.localhost` goes to loopback (see `loopbackFetch`). */
async function dialStream(url: string, link: ServerLink): Promise<LinkSocket> {
  const target = new URL(url);
  if (target.hostname.endsWith(".localhost")) target.hostname = "127.0.0.1";
  const ws = new WebSocket(target, { maxPayload: MAX_MESSAGE_BYTES });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const sock = streamSocket(ws);
  wireStream(ws, sock, link);
  return sock;
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
    openSignup: config.openSignup,
    ...(config.fairUse ? { fairUse: config.fairUse } : {}),
    ...(config.turnstile ? { turnstile: config.turnstile } : {}),
    ...(config.operators.length ? { operators: config.operators } : {}),
    ...(config.hub ? { hub: config.hub } : {}),
    trustProxy: config.trustProxy,
    ...(config.federation ? { federationKey: await federationKeyFile(config.dataDir) } : {}),
    fetch: loopbackFetch,
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
  // Federated calls: server-pair streams (dialed with `ws`), placement and presence sharing.
  const links = new LinkRegistry(env, gateway, dialStream);
  env.calls = new FedCalls(env, gateway, links);
  env.onPresence = presenceHook(env, gateway);
  env.flushPresence = presenceFlusher(env, gateway);
  const app = new Hono();
  app.route("/api", createApi(env, gateway));
  // Server-to-server: /.well-known/openloungephone and the signed /fed/v1 endpoints.
  app.route("/", federationApp(env, gateway));
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
  // Server-pair streams: separate from client sockets (no keepalive; the dialer closes when idle).
  const streamServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
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

  const sweepAll = async () => {
    try {
      for (const id of await env.store.householdIds()) await sweepSpace(env, id);
    } catch (e) {
      env.log("warn", "history sweep failed", { error: String(e) });
    }
  };
  const sweeper = setInterval(() => void sweepAll(), SWEEP_MS);
  sweeper.unref();
  void sweepAll();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === STREAM_PATH) {
      const from = new URL(req.url ?? "/", "http://x").searchParams.get("from") ?? "";
      streamServer.handleUpgrade(req, socket, head, (ws) => {
        const sock = streamSocket(ws);
        const link = links.accept(from, sock);
        if (!link) return ws.close(4400, "bad host");
        wireStream(ws, sock, link);
      });
      return;
    }
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
  if (config.openSignup) console.log("  Open sign-up is ON: anyone can create an account.");
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
      clearInterval(sweeper);
      links.close();
      for (const ws of wss.clients) ws.terminate();
      for (const ws of streamServer.clients) ws.terminate();
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
