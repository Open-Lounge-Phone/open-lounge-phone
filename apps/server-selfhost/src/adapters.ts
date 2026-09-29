import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateServerKey, publicKeyOf } from "@openloungephone/federation";
import type {
  BlobStore,
  FederationKeyStore,
  StoredFederationKeys,
  Transcriber,
} from "@openloungephone/server-app";

/** Blobs as files under `root`, with the content type in a sidecar file. */
export function fileBlobStore(root: string): BlobStore {
  const pathFor = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(`${resolve(root)}/`)) throw new Error(`bad blob key ${key}`);
    return path;
  };
  return {
    async put(key, data, contentType) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, new Uint8Array(data));
      await writeFile(`${path}.type`, contentType);
    },
    async get(key) {
      const path = pathFor(key);
      try {
        const [data, contentType] = await Promise.all([
          readFile(path),
          readFile(`${path}.type`, "utf8"),
        ]);
        return {
          data: data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer,
          contentType,
        };
      } catch {
        return undefined;
      }
    },
    async delete(key) {
      const path = pathFor(key);
      await rm(path, { force: true });
      await rm(`${path}.type`, { force: true });
    },
  };
}

/**
 * Speech-to-text via any OpenAI-compatible `/v1/audio/transcriptions` endpoint, e.g. a local
 * whisper.cpp server, faster-whisper-server/speaches, or a hosted API.
 */
export function openAiTranscriber(opts: {
  url: string;
  model: string;
  apiKey?: string;
}): Transcriber {
  return {
    async transcribe(audio, contentType) {
      const ext = contentType.split("/")[1]?.split(";")[0] ?? "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: contentType }), `voicemail.${ext}`);
      form.append("model", opts.model);
      form.append("response_format", "json");
      const res = await fetch(opts.url, {
        method: "POST",
        body: form,
        ...(opts.apiKey ? { headers: { authorization: `Bearer ${opts.apiKey}` } } : {}),
      });
      if (!res.ok) throw new Error(`transcription HTTP ${res.status}`);
      return ((await res.json()) as { text?: string }).text ?? "";
    },
  };
}

export const blobDir = (dataDir: string) => join(dataDir, "blobs");

/** This server's federation key: created once in DATA_DIR, readable only by its owner. */
export async function federationKeyFile(dataDir: string): Promise<string> {
  const path = join(dataDir, "federation-key.jwk");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = await generateServerKey();
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  return key;
}

/** Writes a file readable only by its owner, atomically (write aside, then rename). */
function writePrivate(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * This server's key as files in DATA_DIR: `federation-key.jwk` is the current key (created by
 * `federationKeyFile`); after a rotation, `federation-key.previous.json` holds the key it
 * replaced (its public half: nothing is signed with it again) and the signed hand-over, which
 * `.well-known` publishes until the overlap ends; the file is removed after that. Both files are
 * mode 600; back them up together.
 */
export function federationKeyStore(dataDir: string): FederationKeyStore {
  const keyPath = join(dataDir, "federation-key.jwk");
  const previousPath = join(dataDir, "federation-key.previous.json");
  const read = () => (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : undefined);
  return {
    async load() {
      const privateKey = read();
      if (!privateKey) return undefined;
      if (!existsSync(previousPath)) return { privateKey };
      try {
        const r = JSON.parse(readFileSync(previousPath, "utf8")) as NonNullable<
          StoredFederationKeys["rotation"]
        > & { server_key: string };
        // A hand-over for a key that isn't current (e.g. the key file was restored) is ignored.
        if (r.server_key !== publicKeyOf(privateKey)) return { privateKey };
        if (Date.now() >= r.expires * 1000) {
          rmSync(previousPath, { force: true });
          return { privateKey };
        }
        const { server_key: _, ...rotation } = r;
        return { privateKey, rotation };
      } catch {
        return { privateKey };
      }
    },
    async save(next, expectPublicKey) {
      // Synchronous from here on: one process, so nothing can interleave.
      const current = read();
      if (!current || publicKeyOf(current) !== expectPublicKey) return false;
      const serverKey = publicKeyOf(next.privateKey);
      // The hand-over first (it names the new key, so it is ignored until the key file moves).
      if (next.rotation) {
        writePrivate(
          previousPath,
          `${JSON.stringify({ ...next.rotation, server_key: serverKey })}\n`,
        );
      } else rmSync(previousPath, { force: true });
      writePrivate(keyPath, `${next.privateKey}\n`);
      return true;
    },
  };
}

/**
 * Outbound fetch for federation. `*.localhost` names are loopback by definition (RFC 6761), but
 * not every resolver knows that, so they're sent to 127.0.0.1 directly (dev and interop tests).
 */
export function loopbackFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname.endsWith(".localhost")) {
    url.hostname = "127.0.0.1";
    return fetch(new Request(url, request));
  }
  return fetch(request);
}
