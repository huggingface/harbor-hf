import { downloadFile, listFiles, uploadFile } from "@huggingface/hub";
import { sha256 } from "@harbor-hf/contracts";
import {
  type CreateResult,
  type ImmutableObjectStore,
  ImmutableConflictError,
  type ObjectEntry,
} from "@harbor-hf/control-core";

const defaultDownloadConcurrency = 8;
const defaultRetryDelaysMs = [250, 1_000, 3_000] as const;

export interface HuggingFaceBucketStoreOptions {
  bucketId: string;
  accessToken: string;
  downloadConcurrency?: number;
  retryDelaysMs?: readonly number[];
}

function transientDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TypeError" && error.message === "fetch failed") return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH"
  )
    return true;
  return transientDownloadError(error.cause);
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HuggingFaceBucketStore implements ImmutableObjectStore {
  private readonly repo: { type: "bucket"; name: string };
  private readonly credentials: { accessToken: string };
  private readonly downloadConcurrency: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly cache = new Map<string, Uint8Array>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HuggingFaceBucketStoreOptions) {
    const concurrency = options.downloadConcurrency ?? defaultDownloadConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw new Error("Bucket download concurrency must be between 1 and 32");
    this.repo = { type: "bucket", name: options.bucketId };
    this.credentials = { accessToken: options.accessToken };
    this.downloadConcurrency = concurrency;
    this.retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  }

  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    const files: Array<{ key: string; size: number }> = [];
    for await (const entry of listFiles({
      repo: this.repo,
      path: prefix,
      recursive: true,
      ...this.credentials,
    })) {
      if (entry.type === "file") files.push({ key: entry.path, size: entry.size });
    }
    files.sort((left, right) => left.key.localeCompare(right.key));
    const entries = new Array<ObjectEntry>(files.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.downloadConcurrency, files.length) },
      async () => {
        while (next < files.length) {
          const index = next;
          next += 1;
          const file = files[index];
          if (!file) continue;
          const bytes = await this.read(file.key);
          entries[index] = {
            key: file.key,
            size: file.size,
            digest: sha256(bytes),
          };
        }
      },
    );
    await Promise.all(workers);
    return entries;
  }

  async read(key: string): Promise<Uint8Array> {
    const cached = this.cache.get(key);
    if (cached) return Uint8Array.from(cached);
    let bytes: Uint8Array | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const blob = await downloadFile({
          repo: this.repo,
          path: key,
          ...this.credentials,
        });
        if (!blob)
          throw Object.assign(new Error(`object not found: ${key}`), {
            code: "ENOENT",
          });
        bytes = new Uint8Array(await blob.arrayBuffer());
        break;
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined || !transientDownloadError(error)) throw error;
        await sleep(delay);
      }
    }
    if (!bytes) throw new Error(`object download produced no bytes: ${key}`);
    if (!key.startsWith("evidence/")) this.cache.set(key, bytes);
    return Uint8Array.from(bytes);
  }

  async create(key: string, bytes: Uint8Array): Promise<CreateResult> {
    const operation = this.queue.then(() => this.createSerialized(key, bytes));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async createSerialized(
    key: string,
    bytes: Uint8Array,
  ): Promise<CreateResult> {
    const digest = sha256(bytes);
    const existing = await this.readIfPresent(key);
    if (existing) {
      if (sha256(existing) !== digest) throw new ImmutableConflictError(key);
      return { created: false, digest };
    }
    await uploadFile({
      repo: this.repo,
      file: { path: key, content: new Blob([Uint8Array.from(bytes).buffer]) },
      commitTitle: `Create immutable control object ${key}`,
      ...this.credentials,
    });
    this.cache.delete(key);
    const observed = await this.read(key);
    if (sha256(observed) !== digest) throw new ImmutableConflictError(key);
    return { created: true, digest };
  }

  private async readIfPresent(key: string): Promise<Uint8Array | null> {
    try {
      return await this.read(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
