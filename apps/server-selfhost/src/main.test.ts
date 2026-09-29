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
  dataDir = mkdtempSync(join(tmpdir(), "olp-"));
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
  expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({
    ok: true,
    software: expect.stringMatching(/^openloungephone\//),
    protocol: 1,
  });
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/nope`);
  await new Promise((resolve) => ws.addEventListener("error", resolve));
});

it("adopts a database created before the rename", async () => {
  const { writeFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "olp-legacy-"));
  const { openSqlite, migrate } = await import("@openloungephone/db/node");
  const legacy = openSqlite(join(dir, "opentincan.sqlite"));
  migrate(legacy.db);
  legacy.db.exec("INSERT INTO settings (key, value) VALUES ('marker', 'kept')");
  legacy.db.close();
  writeFileSync(join(dir, "unrelated.txt"), "x");
  const s = await start(loadConfig({ PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, STUN_URLS: "" }));
  await s.close();
  expect(existsSync(join(dir, "opentincan.sqlite"))).toBe(false);
  const renamed = openSqlite(join(dir, "openloungephone.sqlite"));
  expect(renamed.db.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({
    value: "kept",
  });
  renamed.db.close();
  rmSync(dir, { recursive: true, force: true });
});
