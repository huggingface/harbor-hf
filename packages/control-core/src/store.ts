import { constants } from "node:fs";
import { access, mkdir, open, opendir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "@harbor-hf/contracts";

export interface ObjectEntry {
  key: string;
  digest: string;
  size: number;
}

export interface CreateResult {
  created: boolean;
  digest: string;
}

export interface ImmutableObjectStore {
  list(prefix: string): Promise<readonly ObjectEntry[]>;
  read(key: string): Promise<Uint8Array>;
  create(key: string, bytes: Uint8Array): Promise<CreateResult>;
}

export class ImmutableConflictError extends Error {
  constructor(readonly key: string) {
    super(`immutable object conflict at ${key}`);
    this.name = "ImmutableConflictError";
  }
}

function safePath(root: string, key: string): string {
  if (!key || key.startsWith("/") || key.includes("\u0000")) {
    throw new Error("object key must be a non-empty relative path");
  }
  const candidate = resolve(root, normalize(key));
  const prefix = `${resolve(root)}${sep}`;
  if (!candidate.startsWith(prefix))
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

export class FilesystemObjectStore implements ImmutableObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    const keys: string[] = [];
    await walk(this.root, safePath(this.root, prefix), keys);
    keys.sort();
    const entries = await Promise.all(
      keys.map(async (key) => {
        const bytes = await this.read(key);
        return { key, digest: sha256(bytes), size: bytes.byteLength };
      }),
    );
    return entries;
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
      return { created: false, digest };
    } catch (error) {
      if (
        !(error instanceof ImmutableConflictError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      if (error instanceof ImmutableConflictError) throw error;
    }

    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (sha256(existing) !== digest) throw new ImmutableConflictError(key);
      return { created: false, digest };
    }
    return { created: true, digest };
  }
}

export async function createJson(
  store: ImmutableObjectStore,
  key: string,
  value: unknown,
): Promise<CreateResult> {
  return store.create(key, new TextEncoder().encode(canonicalJson(value)));
}
