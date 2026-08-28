import { sha256 } from "@harbor-hf/contracts";
import {
  type CreateResult,
  ImmutableConflictError,
  type ImmutableObjectStore,
  type ObjectEntry,
} from "@harbor-hf/control-core";
import {
  downloadFile,
  HubApiError,
  type ListFileEntry,
  listFiles,
  uploadFile,
} from "@huggingface/hub";

const defaultRetryDelaysMs = [
  250, 1_000, 3_000, 10_000, 30_000, 60_000, 120_000,
] as const;
const defaultListTimeoutMs = 30_000;
const xetHashPattern = /^[0-9a-f]{64}$/i;

export interface HuggingFaceBucketStoreOptions {
  bucketId: string;
  accessToken: string;
  retryDelaysMs?: readonly number[];
  listTimeoutMs?: number;
}

function transientDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof HubApiError &&
    [408, 429, 500, 502, 503, 504].includes(error.statusCode)
  )
    return true;
  if (
    error.name === "TypeError" &&
    (error.message === "fetch failed" || error.message === "terminated")
  )
    return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  )
    return true;
  return transientDownloadError(error.cause);
}

function sourceIdentity(entry: ListFileEntry): string {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0)
    throw new Error(`invalid Bucket object size for ${entry.path}`);
  if (entry.xetHash === undefined || !xetHashPattern.test(entry.xetHash))
    throw new Error(`Bucket object has no valid xetHash: ${entry.path}`);
  return `xet:${entry.xetHash.toLowerCase()}`;
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HuggingFaceBucketStore implements ImmutableObjectStore {
  private readonly repo: { type: "bucket"; name: string };
  private readonly credentials: { accessToken: string };
  private readonly retryDelaysMs: readonly number[];
  private readonly listTimeoutMs: number;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly sourceIdentities = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HuggingFaceBucketStoreOptions) {
    this.repo = { type: "bucket", name: options.bucketId };
    this.credentials = { accessToken: options.accessToken };
    this.retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
    this.listTimeoutMs = options.listTimeoutMs ?? defaultListTimeoutMs;
    if (!Number.isSafeInteger(this.listTimeoutMs) || this.listTimeoutMs <= 0)
      throw new Error("Bucket list timeout must be a positive integer");
  }

  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    const files = await this.listEntriesWithRetry(prefix, true);
    this.observeSourceIdentities(files);
    files.sort((left, right) => left.key.localeCompare(right.key));
    return files;
  }

  private observeSourceIdentities(entries: readonly ObjectEntry[]): void {
    for (const entry of entries) {
      const previous = this.sourceIdentities.get(entry.key);
      if (previous !== undefined && previous !== entry.source_identity)
        this.cache.delete(entry.key);
      this.sourceIdentities.set(entry.key, entry.source_identity);
    }
  }

  private async listEntriesWithRetry(
    key: string,
    recursive: boolean,
  ): Promise<ObjectEntry[]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.listEntries(key, recursive);
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined || !transientDownloadError(error)) throw error;
        await sleep(delay);
      }
    }
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
    this.cache.delete(key);
    const existing = await this.readIfPresent(key);
    if (existing) {
      if (sha256(existing) !== digest) throw new ImmutableConflictError(key);
      return {
        created: false,
        digest,
        source_identity: await this.stableSourceIdentity(key, digest),
      };
    }
    await uploadFile({
      repo: this.repo,
      file: { path: key, content: new Blob([Uint8Array.from(bytes).buffer]) },
      commitTitle: `Create immutable control object ${key}`,
      ...this.credentials,
    });
    return {
      created: true,
      digest,
      source_identity: await this.stableSourceIdentity(key, digest),
    };
  }

  private async readIfPresent(key: string): Promise<Uint8Array | null> {
    try {
      return await this.read(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async objectMetadata(key: string): Promise<ObjectEntry> {
    const entries = await this.listEntriesWithRetry(key, false);
    this.observeSourceIdentities(entries);
    const entry = entries[0];
    if (entries.length !== 1 || !entry)
      throw new Error(`Bucket object metadata is unavailable or ambiguous: ${key}`);
    return entry;
  }

  private async listEntries(key: string, recursive: boolean): Promise<ObjectEntry[]> {
    const entries: ObjectEntry[] = [];
    for await (const entry of listFiles({
      repo: this.repo,
      path: key,
      recursive,
      expand: true,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(this.listTimeoutMs),
        }),
      ...this.credentials,
    })) {
      if (entry.type === "file" && (recursive || entry.path === key))
        entries.push({
          key: entry.path,
          size: entry.size,
          source_identity: sourceIdentity(entry),
        });
    }
    return entries;
  }

  private async stableSourceIdentity(key: string, digest: string): Promise<string> {
    const before = await this.objectMetadata(key);
    this.cache.delete(key);
    const observed = await this.read(key);
    const after = await this.objectMetadata(key);
    if (
      before.size !== after.size ||
      before.source_identity !== after.source_identity ||
      observed.byteLength !== after.size ||
      sha256(observed) !== digest
    )
      throw new ImmutableConflictError(key);
    return after.source_identity;
  }
}
