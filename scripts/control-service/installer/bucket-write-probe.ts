import { downloadFile, uploadFile } from "@huggingface/hub";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PROBE_CONTENT_BYTES = 1024;

class BucketWriteProbeError extends Error {}

export interface BucketWriteProbeInput {
  bucketId: string;
  accessToken: string;
  path: string;
  bytes: Uint8Array;
}

export interface BucketWriteProbeAdapter {
  createAndVerify(input: BucketWriteProbeInput): Promise<void>;
}

interface BucketWriteProbeOptions {
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

interface ActivityDeadline {
  signal: AbortSignal;
  touch(): void;
  close(): void;
}

type ProgressRequestInit = RequestInit & {
  duplex?: "half";
  progressHint?: unknown;
};

function activityDeadline(idleTimeoutMs: number): ActivityDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(
      () =>
        controller.abort(
          new BucketWriteProbeError(
            "Bucket write probe request exceeded its inactivity limit",
          ),
        ),
      idleTimeoutMs,
    );
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    close() {
      clearTimeout(timer);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Bucket write probe request was aborted");
}

function progressBody(
  init: RequestInit | undefined,
  touch: () => void,
): RequestInit | undefined {
  if (!init?.body) return init;
  let stream: ReadableStream<Uint8Array> | null = null;
  let contentLength: number | null = null;
  let defaultContentType: string | null = null;
  if (init.body instanceof Blob) {
    stream = init.body.stream();
    contentLength = init.body.size;
  } else if (init.body instanceof ReadableStream) {
    stream = init.body as ReadableStream<Uint8Array>;
  } else if (typeof init.body === "string") {
    const bytes = new TextEncoder().encode(init.body);
    stream = new Blob([bytes]).stream();
    contentLength = bytes.byteLength;
    defaultContentType = "text/plain;charset=UTF-8";
  } else if (init.body instanceof URLSearchParams) {
    const bytes = new TextEncoder().encode(init.body.toString());
    stream = new Blob([bytes]).stream();
    contentLength = bytes.byteLength;
    defaultContentType = "application/x-www-form-urlencoded;charset=UTF-8";
  } else if (init.body instanceof ArrayBuffer) {
    stream = new Blob([init.body]).stream();
    contentLength = init.body.byteLength;
  } else if (ArrayBuffer.isView(init.body)) {
    const bytes = Uint8Array.from(
      new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength),
    );
    stream = new Blob([bytes]).stream();
    contentLength = bytes.byteLength;
  }
  if (!stream) return init;

  const headers = new Headers(init.headers);
  if (contentLength !== null && !headers.has("content-length")) {
    headers.set("content-length", String(contentLength));
  }
  if (defaultContentType !== null && !headers.has("content-type")) {
    headers.set("content-type", defaultContentType);
  }
  const body = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        touch();
        controller.enqueue(chunk);
      },
    }),
  );
  return {
    ...init,
    body,
    headers,
    ...({ duplex: "half" } satisfies ProgressRequestInit),
  };
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const reason = abortReason(signal);
      void reader.cancel(reason).catch(() => undefined);
      reject(reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function copyResponseMetadata(source: Response, target: Response): Response {
  for (const property of ["redirected", "type", "url"] as const) {
    Object.defineProperty(target, property, {
      configurable: true,
      value: source[property],
    });
  }
  return target;
}

async function bufferBoundedResponse(
  response: Response,
  deadline: ActivityDeadline,
  signal: AbortSignal,
  operation: AbortController,
  maximumBytes: number,
): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      const error = new BucketWriteProbeError(
        "Bucket write probe response had an invalid content length",
      );
      operation.abort(error);
      void response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    if (BigInt(declaredLength) > BigInt(maximumBytes)) {
      const error = new BucketWriteProbeError(
        "Bucket write probe response exceeded its size limit",
      );
      operation.abort(error);
      void response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }
  if (!response.body) {
    return copyResponseMetadata(
      response,
      new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }),
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      deadline.touch();
      observedBytes += next.value.byteLength;
      if (observedBytes > maximumBytes) {
        const error = new BucketWriteProbeError(
          "Bucket write probe response exceeded its size limit",
        );
        operation.abort(error);
        throw error;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(observedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return copyResponseMetadata(
    response,
    new Response(observedBytes === 0 ? null : bytes, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

function boundedFetch(
  request: typeof fetch,
  operation: AbortController,
  idleTimeoutMs: number,
  maximumBytes: number,
): typeof fetch {
  return async (input, init) => {
    const deadline = activityDeadline(idleTimeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, operation.signal, deadline.signal])
      : AbortSignal.any([operation.signal, deadline.signal]);
    try {
      const response = await request(input, {
        ...progressBody(init, deadline.touch),
        signal,
      });
      deadline.touch();
      return await bufferBoundedResponse(
        response,
        deadline,
        signal,
        operation,
        maximumBytes,
      );
    } catch (error) {
      operation.abort(error);
      throw error;
    } finally {
      deadline.close();
    }
  };
}

export class HuggingFaceBucketWriteProbe implements BucketWriteProbeAdapter {
  private readonly idleTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly request: typeof fetch;

  constructor(options: BucketWriteProbeOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.request = options.fetch ?? fetch;
    if (this.idleTimeoutMs < 1 || this.maxResponseBytes < 1) {
      throw new Error("Bucket write probe bounds are invalid");
    }
  }

  async createAndVerify(input: BucketWriteProbeInput): Promise<void> {
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAX_PROBE_CONTENT_BYTES
    ) {
      throw new Error("Bucket write probe content exceeds its limit");
    }
    try {
      await this.createAndVerifyBounded(input);
    } catch (error) {
      const detail = error instanceof BucketWriteProbeError ? `: ${error.message}` : "";
      throw new Error(`fresh Bucket write/read-back probe failed${detail}`);
    }
  }

  private async createAndVerifyBounded(input: BucketWriteProbeInput): Promise<void> {
    const repo = { type: "bucket" as const, name: input.bucketId };
    const uploadOperation = new AbortController();
    try {
      await uploadFile({
        repo,
        file: {
          path: input.path,
          content: new Blob([Uint8Array.from(input.bytes).buffer]),
        },
        commitTitle: "Verify Harbor-HF installer Bucket write access",
        accessToken: input.accessToken,
        abortSignal: uploadOperation.signal,
        fetch: boundedFetch(
          this.request,
          uploadOperation,
          this.idleTimeoutMs,
          this.maxResponseBytes,
        ),
      });
    } finally {
      uploadOperation.abort(
        new BucketWriteProbeError("Bucket write probe upload operation ended"),
      );
    }

    const downloadOperation = new AbortController();
    try {
      const observed = await downloadFile({
        repo,
        path: input.path,
        accessToken: input.accessToken,
        fetch: boundedFetch(
          this.request,
          downloadOperation,
          this.idleTimeoutMs,
          this.maxResponseBytes,
        ),
      });
      if (!observed) {
        throw new BucketWriteProbeError("Bucket write probe is missing");
      }
      if (observed.size !== input.bytes.byteLength) {
        throw new BucketWriteProbeError("Bucket write probe content does not match");
      }
      const bytes = new Uint8Array(await observed.arrayBuffer());
      if (
        bytes.byteLength !== input.bytes.byteLength ||
        bytes.some((value, index) => value !== input.bytes[index])
      ) {
        throw new BucketWriteProbeError("Bucket write probe content does not match");
      }
    } finally {
      downloadOperation.abort(
        new BucketWriteProbeError("Bucket write probe download operation ended"),
      );
    }
  }
}
