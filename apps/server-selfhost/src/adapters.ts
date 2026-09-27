import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BlobStore, Transcriber } from "@openloungephone/server-app";

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
