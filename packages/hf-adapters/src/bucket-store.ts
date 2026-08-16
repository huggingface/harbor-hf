import { downloadFile, listFiles, uploadFile } from "@huggingface/hub";
import { sha256 } from "@harbor-hf/contracts";
import {
  type CreateResult,
  type ImmutableObjectStore,
  ImmutableConflictError,
  type ObjectEntry,
} from "@harbor-hf/control-core";

export interface HuggingFaceBucketStoreOptions {
  bucketId: string;
  accessToken: string;
}

export class HuggingFaceBucketStore implements ImmutableObjectStore {
  private readonly repo: { type: "bucket"; name: string };
  private readonly credentials: { accessToken: string };
  private readonly cache = new Map<string, Uint8Array>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HuggingFaceBucketStoreOptions) {
    this.repo = { type: "bucket", name: options.bucketId };
    this.credentials = { accessToken: options.accessToken };
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
    return Promise.all(
      files.map(async (file) => {
        const bytes = await this.read(file.key);
        return { key: file.key, size: file.size, digest: sha256(bytes) };
      }),
    );
  }

  async read(key: string): Promise<Uint8Array> {
    const cached = this.cache.get(key);
    if (cached) return Uint8Array.from(cached);
    const blob = await downloadFile({
      repo: this.repo,
      path: key,
      ...this.credentials,
    });
    if (!blob)
      throw Object.assign(new Error(`object not found: ${key}`), { code: "ENOENT" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
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
