import { ImmutableConflictError } from "@harbor-hf/control-core";
import { HubApiError } from "@huggingface/hub";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@huggingface/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@huggingface/hub")>()),
  ...hub,
}));

import { HuggingFaceBucketStore } from "../src/bucket-store.js";

const token = ["hf", "not-a-real-credential"].join("_");

function store(
  options: { retryDelaysMs?: readonly number[]; listTimeoutMs?: number } = {},
) {
  return new HuggingFaceBucketStore({
    bucketId: "example/control",
    accessToken: token,
    ...options,
  });
}

describe("HuggingFaceBucketStore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an object and verifies the uploaded bytes", async () => {
    hub.downloadFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Blob(["payload"]));
    hub.uploadFile.mockResolvedValue(undefined);
    hub.listFiles.mockImplementation(async function* ({ path }: { path: string }) {
      yield {
        type: "file",
        path,
        size: 7,
        xetHash: "a".repeat(64),
      };
    });

    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).resolves.toMatchObject({
      created: true,
      source_identity: `xet:${"a".repeat(64)}`,
    });
    expect(hub.uploadFile).toHaveBeenCalledTimes(1);
    expect(hub.uploadFile.mock.calls[0]?.[0]).toMatchObject({
      repo: { type: "bucket", name: "example/control" },
      file: { path: "control/v1/object.json" },
    });
    expect(hub.listFiles).toHaveBeenCalledTimes(2);
    for (const [options] of hub.listFiles.mock.calls)
      expect(options).toMatchObject({
        path: "control/v1/object.json",
        recursive: false,
        expand: true,
      });
  });

  it("fails an upload when targeted metadata has no xet identity", async () => {
    hub.downloadFile.mockResolvedValueOnce(null);
    hub.uploadFile.mockResolvedValue(undefined);
    hub.listFiles.mockImplementation(async function* ({ path }: { path: string }) {
      yield {
        type: "file",
        path,
        size: 7,
        uploadedAt: "2026-08-24T10:00:00Z",
      };
    });

    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).rejects.toThrow("Bucket object has no valid xetHash");
    expect(hub.uploadFile).toHaveBeenCalledTimes(1);
    expect(hub.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "control/v1/object.json",
        recursive: false,
        expand: true,
      }),
    );
  });

  it("adopts identical objects and rejects immutable conflicts", async () => {
    hub.downloadFile
      .mockResolvedValueOnce(new Blob(["payload"]))
      .mockResolvedValueOnce(new Blob(["payload"]));
    hub.listFiles.mockImplementation(async function* ({ path }: { path: string }) {
      yield {
        type: "file",
        path,
        size: 7,
        xetHash: "a".repeat(64),
      };
    });
    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).resolves.toMatchObject({
      created: false,
      source_identity: `xet:${"a".repeat(64)}`,
    });

    hub.downloadFile.mockResolvedValueOnce(new Blob(["different"]));
    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).rejects.toBeInstanceOf(ImmutableConflictError);
    expect(hub.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects an overwrite between upload verification and metadata capture", async () => {
    hub.downloadFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Blob(["payload"]));
    hub.uploadFile.mockResolvedValue(undefined);
    let listing = 0;
    hub.listFiles.mockImplementation(async function* ({ path }: { path: string }) {
      listing += 1;
      yield {
        type: "file",
        path,
        size: 7,
        xetHash: (listing === 1 ? "a" : "b").repeat(64),
      };
    });

    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).rejects.toBeInstanceOf(ImmutableConflictError);
  });

  it("lists Bucket metadata without downloading objects", async () => {
    hub.listFiles.mockImplementation(async function* () {
      for (let index = 0; index < 12; index += 1)
        yield {
          type: "file",
          path: `control/v1/${String(index).padStart(2, "0")}.json`,
          size: 1,
          xetHash: index.toString(16).padStart(64, "0"),
        };
    });

    const entries = await store().list("control/v1");

    expect(entries).toHaveLength(12);
    expect(hub.downloadFile).not.toHaveBeenCalled();
    expect(hub.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ expand: true, fetch: expect.any(Function) }),
    );
  });

  it("invalidates cached bytes when listed source identity changes", async () => {
    const bucket = store();
    let identity = "a";
    hub.listFiles.mockImplementation(async function* ({ path }: { path: string }) {
      yield {
        type: "file",
        path: `${path}/object.json`,
        size: 3,
        xetHash: identity.repeat(64),
      };
    });
    hub.downloadFile
      .mockResolvedValueOnce(new Blob(["old"]))
      .mockResolvedValueOnce(new Blob(["new"]));

    await bucket.list("control/v1");
    await expect(bucket.read("control/v1/object.json")).resolves.toEqual(
      new TextEncoder().encode("old"),
    );
    await expect(bucket.read("control/v1/object.json")).resolves.toEqual(
      new TextEncoder().encode("old"),
    );
    expect(hub.downloadFile).toHaveBeenCalledTimes(1);

    identity = "b";
    await bucket.list("control/v1");
    await expect(bucket.read("control/v1/object.json")).resolves.toEqual(
      new TextEncoder().encode("new"),
    );
    expect(hub.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("retries transient Bucket listing failures", async () => {
    hub.listFiles
      .mockImplementationOnce(async function* () {
        yield* [];
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async function* () {
        yield {
          type: "file",
          path: "control/v1/object.json",
          size: 1,
          xetHash: "a".repeat(64),
        };
      });

    await expect(
      store({ retryDelaysMs: [0] }).list("control/v1"),
    ).resolves.toHaveLength(1);
    expect(hub.listFiles).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid Bucket list timeouts", () => {
    expect(() => store({ listTimeoutMs: 0 })).toThrow(
      "Bucket list timeout must be a positive integer",
    );
  });

  it("retries transient fetch failures with bounded delays", async () => {
    hub.downloadFile
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(
        Object.assign(new Error("temporary timeout"), { code: "ETIMEDOUT" }),
      )
      .mockResolvedValueOnce(new Blob(["payload"]));

    await expect(
      store({ retryDelaysMs: [0, 0] }).read("control/v1/object.json"),
    ).resolves.toEqual(new TextEncoder().encode("payload"));
    expect(hub.downloadFile).toHaveBeenCalledTimes(3);
  });

  it("keeps retrying transient fetch failures during a long rebuild", async () => {
    vi.useFakeTimers();
    try {
      hub.downloadFile
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(new Blob(["payload"]));

      const reading = store().read("control/v1/object.json");
      await vi.runAllTimersAsync();
      await expect(reading).resolves.toEqual(new TextEncoder().encode("payload"));
      expect(hub.downloadFile).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient Hub API download failures", async () => {
    hub.downloadFile
      .mockRejectedValueOnce(
        new HubApiError("https://huggingface.co/buckets/example", 504),
      )
      .mockResolvedValueOnce(new Blob(["payload"]));

    await expect(
      store({ retryDelaysMs: [0] }).read("control/v1/object.json"),
    ).resolves.toEqual(new TextEncoder().encode("payload"));
    expect(hub.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("retries transient failures while materializing a lazy Blob", async () => {
    hub.downloadFile
      .mockResolvedValueOnce({
        arrayBuffer: async () => {
          throw new TypeError("terminated", {
            cause: Object.assign(new Error("socket closed"), {
              code: "UND_ERR_SOCKET",
            }),
          });
        },
      })
      .mockResolvedValueOnce(new Blob(["payload"]));

    await expect(
      store({ retryDelaysMs: [0] }).read("control/v1/object.json"),
    ).resolves.toEqual(new TextEncoder().encode("payload"));
    expect(hub.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient download failures", async () => {
    hub.downloadFile.mockRejectedValue(
      new HubApiError(
        "https://huggingface.co/buckets/example",
        403,
        undefined,
        "authorization failed",
      ),
    );

    await expect(
      store({ retryDelaysMs: [0, 0] }).read("control/v1/object.json"),
    ).rejects.toThrow("authorization failed");
    expect(hub.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("lists file keys and sizes in deterministic order", async () => {
    hub.listFiles.mockImplementation(async function* () {
      yield {
        type: "file",
        path: "control/v1/z.json",
        size: 1,
        xetHash: "A".repeat(64),
      };
      yield { type: "directory", path: "control/v1/nested", size: 0 };
      yield {
        type: "file",
        path: "control/v1/a.json",
        size: 1,
        xetHash: "b".repeat(64),
      };
    });
    const entries = await store().list("control/v1");

    expect(entries).toEqual([
      {
        key: "control/v1/a.json",
        size: 1,
        source_identity: `xet:${"b".repeat(64)}`,
      },
      {
        key: "control/v1/z.json",
        size: 1,
        source_identity: `xet:${"a".repeat(64)}`,
      },
    ]);
    expect(hub.downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "file", path: "control/v1/missing.json", size: 1 }],
    [
      {
        type: "file",
        path: "control/v1/invalid-xet.json",
        size: 1,
        xetHash: "not-a-hash",
        uploadedAt: "2026-08-24T10:00:00Z",
      },
    ],
    [
      {
        type: "file",
        path: "control/v1/upload-time-only.json",
        size: 1,
        uploadedAt: "2026-08-24T10:00:00Z",
      },
    ],
  ])("rejects a Bucket file without a valid identity", async (entry) => {
    hub.listFiles.mockImplementation(async function* () {
      yield entry;
    });

    await expect(store().list("control/v1")).rejects.toThrow();
    expect(hub.downloadFile).not.toHaveBeenCalled();
  });
});
