import { sha256 } from "@harbor-hf/contracts";
import {
  type CreateResult,
  ImmutableConflictError,
  type ObjectEntry,
  type ObjectStore,
} from "@harbor-hf/control-core";
import {
  HubApiError,
  type ListFileEntry,
  listFiles,
  uploadFile,
} from "@huggingface/hub";

const defaultRetryDelaysMs = [
  250, 1_000, 3_000, 10_000, 30_000, 60_000, 120_000,
] as const;
const defaultListTimeoutMs = 30_000;
const defaultCacheMaxBytes = 64 * 1024 * 1024;
const defaultHubUrl = "https://huggingface.co";
const xetHashPattern = /^[0-9a-f]{64}$/i;

export interface HuggingFaceBucketStoreOptions {
  bucketId: string;
  accessToken: string;
  retryDelaysMs?: readonly number[];
  listTimeoutMs?: number;
  cacheMaxBytes?: number;
  fetch?: typeof fetch;
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

function encodedPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HuggingFaceBucketStore implements ObjectStore {
  private readonly repo: { type: "bucket"; name: string };
  private readonly credentials: { accessToken: string };
  private readonly retryDelaysMs: readonly number[];
  private readonly listTimeoutMs: number;
  private readonly cacheMaxBytes: number;
  private readonly fetch: typeof fetch;
  private readonly cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private readonly sourceIdentities = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HuggingFaceBucketStoreOptions) {
    this.repo = { type: "bucket", name: options.bucketId };
    this.credentials = { accessToken: options.accessToken };
    this.retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
    this.listTimeoutMs = options.listTimeoutMs ?? defaultListTimeoutMs;
    this.cacheMaxBytes = options.cacheMaxBytes ?? defaultCacheMaxBytes;
    this.fetch = options.fetch ?? fetch;
    if (!Number.isSafeInteger(this.listTimeoutMs) || this.listTimeoutMs <= 0)
      throw new Error("Bucket list timeout must be a positive integer");
    if (!Number.isSafeInteger(this.cacheMaxBytes) || this.cacheMaxBytes < 0)
      throw new Error("Bucket cache limit must be a nonnegative integer");
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
        this.deleteCached(entry.key);
      this.sourceIdentities.set(entry.key, entry.source_identity);
    }
  }

  private deleteCached(key: string): void {
    const cached = this.cache.get(key);
    if (!cached) return;
    this.cache.delete(key);
    this.cacheBytes -= cached.byteLength;
  }

  private setCached(key: string, bytes: Uint8Array): void {
    if (
      key.startsWith("evidence/") ||
      bytes.byteLength > this.cacheMaxBytes ||
      this.cacheMaxBytes === 0
    )
      return;
    this.deleteCached(key);
    while (this.cacheBytes + bytes.byteLength > this.cacheMaxBytes) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.deleteCached(oldest);
    }
    this.cache.set(key, bytes);
    this.cacheBytes += bytes.byteLength;
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
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Uint8Array.from(cached);
    }
    let bytes: Uint8Array | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        bytes = await this.download(key);
        break;
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined || !transientDownloadError(error)) throw error;
        await sleep(delay);
      }
    }
    if (!bytes) throw new Error(`object download produced no bytes: ${key}`);
    this.setCached(key, bytes);
    return Uint8Array.from(bytes);
  }

  private async download(key: string): Promise<Uint8Array> {
    const url = new URL(
      `/buckets/${encodedPath(this.repo.name)}/resolve/${encodedPath(key)}`,
      defaultHubUrl,
    );
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
      redirect: "follow",
    });
    if (response.status === 404)
      throw Object.assign(new Error(`object not found: ${key}`), {
        code: "ENOENT",
      });
    if (!response.ok)
      throw new HubApiError(
        url.href,
        response.status,
        response.headers.get("X-Request-Id") ?? undefined,
        `Bucket object download failed with HTTP ${response.status}`,
      );
    return new Uint8Array(await response.arrayBuffer());
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
    this.deleteCached(key);
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
      fetch: this.fetch,
      ...this.credentials,
    });
    return {
      created: true,
      digest,
      source_identity: await this.stableSourceIdentity(key, digest),
    };
  }

  async put(key: string, bytes: Uint8Array): Promise<{ digest: string }> {
    const operation = this.queue.then(() => this.putSerialized(key, bytes));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async putSerialized(
    key: string,
    bytes: Uint8Array,
  ): Promise<{ digest: string }> {
    const digest = sha256(bytes);
    this.deleteCached(key);
    await uploadFile({
      repo: this.repo,
      file: { path: key, content: new Blob([Uint8Array.from(bytes).buffer]) },
      commitTitle: `Update run state ${key}`,
      fetch: this.fetch,
      ...this.credentials,
    });
    await this.stableSourceIdentity(key, digest);
    return { digest };
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
        this.fetch(input, {
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
    this.deleteCached(key);
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
