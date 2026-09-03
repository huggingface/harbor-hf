import { constants } from "node:fs";
import { access, mkdir, open, opendir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "@harbor-hf/contracts";

export interface ObjectEntry {
  key: string;
  size: number;
  source_identity: string;
}

export interface CreateResult {
  created: boolean;
  digest: string;
  source_identity: string;
}

export interface ObjectStore {
  list(prefix: string): Promise<readonly ObjectEntry[]>;
  read(key: string): Promise<Uint8Array>;
  create(key: string, bytes: Uint8Array): Promise<CreateResult>;
  put(key: string, bytes: Uint8Array): Promise<{ digest: string }>;
}

export class ImmutableConflictError extends Error {
  constructor(readonly key: string) {
    super(`immutable object conflict at ${key}`);
    this.name = "ImmutableConflictError";
  }
}

function safePath(root: string, key: string): string {
  if (!key || key.startsWith("/") || key.includes("\u0000"))
    throw new Error("object key must be a non-empty relative path");
  const candidate = resolve(root, normalize(key));
  if (!candidate.startsWith(`${resolve(root)}${sep}`))
    throw new Error("object key escapes the store root");
  return candidate;
}

async function walk(root: string, directory: string, output: string[]): Promise<void> {
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of handle) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
  }
}

export class FilesystemObjectStore implements ObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    const keys: string[] = [];
    await walk(this.root, safePath(this.root, prefix), keys);
    keys.sort();
    return Promise.all(
      keys.map(async (key) => {
        const path = safePath(this.root, key);
        const info = await stat(path);
        const bytes = await readFile(path);
        return { key, size: info.size, source_identity: sha256(bytes) };
      }),
    );
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(safePath(this.root, key));
  }

  async create(key: string, bytes: Uint8Array): Promise<CreateResult> {
    const path = safePath(this.root, key);
    const digest = sha256(bytes);
    await mkdir(dirname(path), { recursive: true });
    try {
      await access(path, constants.F_OK);
      const existing = await readFile(path);
      if (sha256(existing) !== digest) throw new ImmutableConflictError(key);
      return { created: false, digest, source_identity: digest };
    } catch (error) {
      if (error instanceof ImmutableConflictError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
    return { created: true, digest, source_identity: digest };
  }

  async put(key: string, bytes: Uint8Array): Promise<{ digest: string }> {
    const path = safePath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    return { digest: sha256(bytes) };
  }
}

export async function readJson(store: ObjectStore, key: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await store.read(key))) as unknown;
}

export async function createJson(
  store: ObjectStore,
  key: string,
  value: unknown,
): Promise<CreateResult> {
  return store.create(key, new TextEncoder().encode(canonicalJson(value)));
}

export async function putJson(
  store: ObjectStore,
  key: string,
  value: unknown,
): Promise<{ digest: string }> {
  return store.put(key, new TextEncoder().encode(canonicalJson(value)));
}
