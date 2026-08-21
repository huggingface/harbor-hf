import { downloadFile, uploadFile } from "@huggingface/hub";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceBucketWriteProbe } from "../bucket-write-probe.js";

vi.mock("@huggingface/hub", () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));

const mockedUpload = vi.mocked(uploadFile);
const mockedDownload = vi.mocked(downloadFile);

describe("Bucket write probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads a new path with the proposed token and verifies exact bytes", async () => {
    const bytes = new TextEncoder().encode("probe\n");
    mockedUpload.mockResolvedValue({
      commit: { oid: "a".repeat(40), url: "https://huggingface.co/commit-placeholder" },
      hookOutput: "",
    });
    mockedDownload.mockResolvedValue(new Blob([bytes]));

    await new HuggingFaceBucketWriteProbe().createAndVerify({
      bucketId: "example/control-artifacts",
      accessToken: "proposed-control-placeholder",
      path: "installer/write-probes/schema=v1/install/probe",
      bytes,
    });

    expect(mockedUpload).toHaveBeenCalledOnce();
    expect(mockedUpload.mock.calls[0]?.[0]).toMatchObject({
      repo: { type: "bucket", name: "example/control-artifacts" },
      accessToken: "proposed-control-placeholder",
      file: { path: "installer/write-probes/schema=v1/install/probe" },
    });
    expect(mockedDownload.mock.calls[0]?.[0]).toMatchObject({
      repo: { type: "bucket", name: "example/control-artifacts" },
      path: "installer/write-probes/schema=v1/install/probe",
      accessToken: "proposed-control-placeholder",
    });
  });

  it("bounds successful upload and download exchanges through injected fetch", async () => {
    const expected = Uint8Array.from([1, 2, 3, 4]);
    const request = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> =>
        new Response(String(input).includes("download") ? expected : null, {
          status: 200,
        }),
    ) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      await parameters.fetch("https://provider.invalid/upload", {
        method: "POST",
        signal: parameters.abortSignal ?? null,
      });
      return {
        commit: {
          oid: "a".repeat(40),
          url: "https://provider.invalid/commit-placeholder",
        },
        hookOutput: "",
      };
    });
    mockedDownload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("download fetch is missing");
      return (await parameters.fetch("https://provider.invalid/download")).blob();
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 50,
        maxResponseBytes: 8,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: expected,
      }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts an upload that makes no progress before response headers", async () => {
    const request = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const rejectAborted = () => reject(signal.reason);
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      })) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      await parameters.fetch("https://provider.invalid/upload", {
        signal: parameters.abortSignal ?? null,
      });
      return {
        commit: {
          oid: "a".repeat(40),
          url: "https://provider.invalid/commit-placeholder",
        },
        hookOutput: "",
      };
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 20,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("inactivity limit");
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("aborts a download response stream that stops making progress", async () => {
    const request = (async (): Promise<Response> =>
      new Response(new ReadableStream<Uint8Array>())) as typeof fetch;
    mockedUpload.mockResolvedValue({
      commit: {
        oid: "a".repeat(40),
        url: "https://provider.invalid/commit-placeholder",
      },
      hookOutput: "",
    });
    mockedDownload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("download fetch is missing");
      return (await parameters.fetch("https://provider.invalid/download")).blob();
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 20,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("inactivity limit");
  });

  it("allows periodic progress beyond one total inactivity interval", async () => {
    const expected = Uint8Array.from([1, 2, 3, 4]);
    const request = (async (): Promise<Response> => {
      let offset = 0;
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => {
              controller.enqueue(expected.slice(offset, offset + 1));
              offset += 1;
              if (offset === expected.byteLength) {
                clearInterval(timer);
                controller.close();
              }
            }, 10);
          },
          cancel() {
            clearInterval(timer);
          },
        }),
      );
    }) as typeof fetch;
    mockedUpload.mockResolvedValue({
      commit: {
        oid: "a".repeat(40),
        url: "https://provider.invalid/commit-placeholder",
      },
      hookOutput: "",
    });
    mockedDownload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("download fetch is missing");
      return (await parameters.fetch("https://provider.invalid/download")).blob();
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 25,
        maxResponseBytes: expected.byteLength,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: expected,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses an independent inactivity deadline for each concurrent exchange", async () => {
    let activeChunks = 0;
    let chunksWhenStalledRequestAborted: number | null = null;
    const request = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("stalled")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const rejectAborted = () => {
            chunksWhenStalledRequestAborted = activeChunks;
            reject(signal.reason);
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener("abort", rejectAborted, { once: true });
        });
      }
      let timer: ReturnType<typeof setInterval>;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => {
                activeChunks += 1;
                controller.enqueue(Uint8Array.from([activeChunks]));
                if (activeChunks === 10) {
                  clearInterval(timer);
                  controller.close();
                }
              }, 10);
            },
            cancel() {
              clearInterval(timer);
            },
          }),
        ),
      );
    }) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      await Promise.all([
        parameters.fetch("https://provider.invalid/stalled", {
          signal: parameters.abortSignal ?? null,
        }),
        parameters.fetch("https://provider.invalid/active", {
          signal: parameters.abortSignal ?? null,
        }),
      ]);
      return {
        commit: {
          oid: "a".repeat(40),
          url: "https://provider.invalid/commit-placeholder",
        },
        hookOutput: "",
      };
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 25,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("inactivity limit");
    if (chunksWhenStalledRequestAborted === null) {
      throw new Error("stalled request was not aborted");
    }
    expect(chunksWhenStalledRequestAborted).toBeLessThan(6);
  });

  it("resets inactivity while a streamed request body makes progress", async () => {
    const request = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!(init?.body instanceof ReadableStream)) {
        throw new Error("progress request body is missing");
      }
      const reader = init.body.getReader();
      while (true) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        if ((await reader.read()).done) break;
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      await parameters.fetch("https://provider.invalid/upload", {
        body: new Uint8Array(256 * 1024),
        method: "POST",
        signal: parameters.abortSignal ?? null,
      });
      return {
        commit: {
          oid: "a".repeat(40),
          url: "https://provider.invalid/commit-placeholder",
        },
        hookOutput: "",
      };
    });
    mockedDownload.mockResolvedValue(new Blob([Uint8Array.from([1])]));

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 25,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).resolves.toBeUndefined();
  });

  it("bounds an upload response even when the SDK does not consume it", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = (async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
          },
          cancel,
        }),
      )) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      await parameters.fetch("https://provider.invalid/upload", {
        signal: parameters.abortSignal ?? null,
      });
      return {
        commit: {
          oid: "a".repeat(40),
          url: "https://provider.invalid/commit-placeholder",
        },
        hookOutput: "",
      };
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 50,
        maxResponseBytes: 4,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalled();
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("aborts sibling exchanges when the SDK fails after fetch returns", async () => {
    let siblingOutcome: Promise<"aborted" | "resolved"> | null = null;
    const request = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          resolve(new Response(null));
          return;
        }
        const rejectAborted = () => reject(signal.reason);
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      })) as typeof fetch;
    mockedUpload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("upload fetch is missing");
      siblingOutcome = parameters
        .fetch("https://provider.invalid/sibling", {
          signal: parameters.abortSignal ?? null,
        })
        .then(
          () => "resolved",
          () => "aborted",
        );
      throw new Error("SDK response parsing failed");
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 100,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("fresh Bucket write/read-back probe failed");
    if (!siblingOutcome) throw new Error("sibling exchange was not started");
    await expect(siblingOutcome).resolves.toBe("aborted");
  });

  it("bounds lazy SDK Blob reads and preserves fetch response metadata", async () => {
    const expected = Uint8Array.from([1, 2, 3, 4]);
    const request = (async (): Promise<Response> => {
      const response = new Response(expected);
      for (const [property, value] of [
        ["redirected", true],
        ["type", "cors"],
        ["url", "https://provider.invalid/final-download"],
      ] as const) {
        Object.defineProperty(response, property, { value });
      }
      return response;
    }) as typeof fetch;
    mockedUpload.mockResolvedValue({
      commit: {
        oid: "a".repeat(40),
        url: "https://provider.invalid/commit-placeholder",
      },
      hookOutput: "",
    });
    mockedDownload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("download fetch is missing");
      const lazy = new Blob([expected]);
      vi.spyOn(lazy, "arrayBuffer").mockImplementation(async () => {
        const response = await parameters.fetch?.("https://provider.invalid/download");
        if (!response) throw new Error("download response is missing");
        expect(response.redirected).toBe(true);
        expect(response.type).toBe("cors");
        expect(response.url).toBe("https://provider.invalid/final-download");
        return response.arrayBuffer();
      });
      return lazy;
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 25,
        maxResponseBytes: expected.byteLength,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: expected,
      }),
    ).resolves.toBeUndefined();
  });

  it("cancels a streamed response before it exceeds its byte bound", async () => {
    const cancel = vi.fn();
    const request = (async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
          },
          cancel,
        }),
      )) as typeof fetch;
    mockedUpload.mockResolvedValue({
      commit: {
        oid: "a".repeat(40),
        url: "https://provider.invalid/commit-placeholder",
      },
      hookOutput: "",
    });
    mockedDownload.mockImplementation(async (parameters) => {
      if (!parameters.fetch) throw new Error("download fetch is missing");
      return (await parameters.fetch("https://provider.invalid/download")).blob();
    });

    await expect(
      new HuggingFaceBucketWriteProbe({
        fetch: request,
        idleTimeoutMs: 50,
        maxResponseBytes: 4,
      }).createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a wrong-size Blob before materializing its bytes", async () => {
    const observed = new Blob([Uint8Array.from([1, 2])]);
    const arrayBuffer = vi.spyOn(observed, "arrayBuffer");
    mockedUpload.mockResolvedValue({
      commit: {
        oid: "a".repeat(40),
        url: "https://provider.invalid/commit-placeholder",
      },
      hookOutput: "",
    });
    mockedDownload.mockResolvedValue(observed);

    await expect(
      new HuggingFaceBucketWriteProbe().createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "candidate-token",
        path: "installations/probe.json",
        bytes: Uint8Array.from([1]),
      }),
    ).rejects.toThrow("does not match");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("validates bounds and probe content before provider calls", async () => {
    expect(() => new HuggingFaceBucketWriteProbe({ idleTimeoutMs: 0 })).toThrow(
      "bounds are invalid",
    );
    expect(() => new HuggingFaceBucketWriteProbe({ maxResponseBytes: 0 })).toThrow(
      "bounds are invalid",
    );
    const probe = new HuggingFaceBucketWriteProbe();
    for (const bytes of [new Uint8Array(), new Uint8Array(1025)]) {
      await expect(
        probe.createAndVerify({
          bucketId: "example/control-artifacts",
          accessToken: "candidate-token",
          path: "installations/probe.json",
          bytes,
        }),
      ).rejects.toThrow("content exceeds its limit");
    }
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it("does not surface access tokens or provider response bodies", async () => {
    mockedUpload.mockRejectedValue(
      new Error("candidate-token provider-private-response-body"),
    );

    const failure = new HuggingFaceBucketWriteProbe().createAndVerify({
      bucketId: "example/control-artifacts",
      accessToken: "candidate-token",
      path: "installations/probe.json",
      bytes: Uint8Array.from([1]),
    });
    await expect(failure).rejects.toThrow("fresh Bucket write/read-back probe failed");
    await expect(failure).rejects.not.toThrow("candidate-token");
    await expect(failure).rejects.not.toThrow("provider-private-response-body");
  });

  it("rejects missing or changed read-back content", async () => {
    const probe = new HuggingFaceBucketWriteProbe();
    mockedUpload.mockResolvedValue({
      commit: { oid: "a".repeat(40), url: "https://huggingface.co/commit-placeholder" },
      hookOutput: "",
    });
    mockedDownload.mockResolvedValueOnce(null);
    await expect(
      probe.createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "proposed-control-placeholder",
        path: "installer/write-probes/schema=v1/install/first",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("missing");

    mockedDownload.mockResolvedValueOnce(new Blob([new Uint8Array([2])]));
    await expect(
      probe.createAndVerify({
        bucketId: "example/control-artifacts",
        accessToken: "proposed-control-placeholder",
        path: "installer/write-probes/schema=v1/install/second",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("does not match");
  });
});
