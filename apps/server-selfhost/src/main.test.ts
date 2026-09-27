import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { pairAndCall } from "../../../tests/e2e/scenario.ts";
import { loadConfig } from "./config.ts";
import { start } from "./main.ts";

let server: Awaited<ReturnType<typeof start>>;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "otc-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await start(
    loadConfig({ PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, STUN_URLS: "" }),
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("pairs a device over real sockets and calls both ways", async () => {
  await pairAndCall({ base, setupToken: server.setupToken as string });
});

it("serves the API and rejects unknown socket paths", async () => {
  expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/nope`);
  await new Promise((resolve) => ws.addEventListener("error", resolve));
});
