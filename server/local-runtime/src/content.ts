import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { R2Bucket, R2ObjectBody } from "../../../workers/shared/src/cloudflare";

export function safeObjectPath(root: string, key: string): string {
  if (!key || key.includes("\0") || key.startsWith("/") || key.startsWith("\\")) throw new Error("Invalid content key");
  const base = resolve(root);
  const target = resolve(base, ...key.replaceAll("\\", "/").split("/"));
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Content key escapes the configured root");
  return target;
}

async function bytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export class LocalContentBucket implements R2Bucket {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const path = safeObjectPath(this.root, key);
    let stat;
    try { stat = statSync(path); } catch { return null; }
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
      text: async () => readFileSync(path, "utf8"),
    };
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string): Promise<unknown> {
    const path = safeObjectPath(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    writeFileSync(temporary, await bytes(value));
    renameSync(temporary, path);
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) rmSync(safeObjectPath(this.root, key), { force: true });
  }
}
