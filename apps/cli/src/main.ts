// Entry point: `openloungephone <command>`. See args.ts for the commands.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP, parseCli } from "./args.ts";
import { deployCloudflare, execDeployScript } from "./deploy.ts";
import { doctor, runCommand } from "./doctor.ts";
import { type Io, terminalIo } from "./io.ts";
import { selfhostInit } from "./selfhost.ts";
import { status } from "./status.ts";

/** This repository (the CLI runs from its checkout). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const version = (): string =>
  (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;

export async function main(argv: string[], io: Io = terminalIo()): Promise<number> {
  const cmd = parseCli(argv);
  try {
    switch (cmd.kind) {
      case "help": {
        const text = HELP[cmd.topic === "selfhost-init" ? "selfhost" : (cmd.topic ?? "")];
        if (text === undefined) {
          io.err(`no help for "${cmd.topic}"`);
          io.out(HELP[""]);
          return 2;
        }
        io.out(text);
        return 0;
      }
      case "version":
        io.out(`openloungephone ${version()}`);
        return 0;
      case "error":
        io.err(cmd.message);
        return 2;
      case "status":
        return await status(cmd.url, cmd.json, io);
      case "doctor":
        return doctor(io, REPO_ROOT);
      case "selfhost-init":
        return await selfhostInit(cmd.opts, io, REPO_ROOT);
      case "deploy":
        return await deployCloudflare(cmd.opts, io, {
          repoRoot: REPO_ROOT,
          run: runCommand,
          env: process.env,
          exec: execDeployScript(REPO_ROOT),
        });
    }
  } catch (e) {
    io.err((e as Error).message === "cancelled" ? "Cancelled." : String(e));
    return 1;
  }
}
