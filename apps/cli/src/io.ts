// Terminal input and output. Commands take an `Io`, so tests can script the answers.
import { createInterface } from "node:readline/promises";

export interface Io {
  /** Whether a person is at the keyboard (prompts are allowed). */
  interactive: boolean;
  out(line?: string): void;
  err(line: string): void;
  /** A line of text; `fallback` when the answer is empty. */
  ask(question: string, fallback?: string): Promise<string>;
  /** A secret: typed without echo, never printed. Empty = skip. */
  askSecret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

export function terminalIo(): Io {
  const stdin = process.stdin;
  const interactive = stdin.isTTY === true && process.stdout.isTTY === true;
  const line = async (question: string) => {
    const rl = createInterface({ input: stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    interactive,
    out: (l = "") => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    async ask(question, fallback) {
      const answer = await line(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      return answer || fallback || "";
    },
    askSecret: (question) => readHidden(`${question} (hidden; Enter to skip): `),
    async confirm(question, fallback) {
      const answer = (await line(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      if (!answer) return fallback;
      return answer === "y" || answer === "yes";
    },
  };
}

/** Reads one line from a TTY with echo off. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** An `Io` with scripted answers, for tests (and `--yes` runs never call it). */
export function scriptedIo(answers: string[] = [], interactive = true) {
  const lines: string[] = [];
  const queue = [...answers];
  const next = () => queue.shift() ?? "";
  const io: Io = {
    interactive,
    out: (l = "") => void lines.push(l),
    err: (l) => void lines.push(`ERR ${l}`),
    ask: async (_q, fallback) => next() || fallback || "",
    askSecret: async () => next(),
    confirm: async (_q, fallback) => {
      const a = next().toLowerCase();
      return a ? a === "y" || a === "yes" : fallback;
    },
  };
  return { io, lines, remaining: queue };
}
