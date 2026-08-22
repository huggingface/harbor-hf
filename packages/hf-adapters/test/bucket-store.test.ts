import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImmutableConflictError } from "@harbor-hf/control-core";

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
  options: { downloadConcurrency?: number; retryDelaysMs?: readonly number[] } = {},
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

    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).resolves.toMatchObject({ created: true });
    expect(hub.uploadFile).toHaveBeenCalledTimes(1);
    expect(hub.uploadFile.mock.calls[0]?.[0]).toMatchObject({
      repo: { type: "bucket", name: "example/control" },
      file: { path: "control/v1/object.json" },
    });
  });

  it("adopts identical objects and rejects immutable conflicts", async () => {
    hub.downloadFile.mockResolvedValueOnce(new Blob(["payload"]));
    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).resolves.toMatchObject({ created: false });

    hub.downloadFile.mockResolvedValueOnce(new Blob(["different"]));
    await expect(
      store().create("control/v1/object.json", new TextEncoder().encode("payload")),
    ).rejects.toBeInstanceOf(ImmutableConflictError);
    expect(hub.uploadFile).not.toHaveBeenCalled();
  });

  it("bounds concurrent downloads while listing a large ledger", async () => {
    hub.listFiles.mockImplementation(async function* () {
      for (let index = 0; index < 12; index += 1)
        yield {
          type: "file",
          path: `control/v1/${String(index).padStart(2, "0")}.json`,
          size: 1,
        };
    });
    let active = 0;
    let maximum = 0;
    hub.downloadFile.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Blob(["x"]);
    });

    const entries = await store({ downloadConcurrency: 3 }).list("control/v1");

    expect(entries).toHaveLength(12);
    expect(maximum).toBe(3);
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
    hub.downloadFile.mockRejectedValue(new Error("authorization failed"));

    await expect(
      store({ retryDelaysMs: [0, 0] }).read("control/v1/object.json"),
    ).rejects.toThrow("authorization failed");
    expect(hub.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("lists files in deterministic order with verified digests", async () => {
    hub.listFiles.mockImplementation(async function* () {
      yield { type: "file", path: "control/v1/z.json", size: 1 };
      yield { type: "directory", path: "control/v1/nested", size: 0 };
      yield { type: "file", path: "control/v1/a.json", size: 1 };
    });
    hub.downloadFile.mockImplementation(
      async ({ path }: { path: string }) =>
        new Blob([path.endsWith("a.json") ? "a" : "z"]),
    );

    const entries = await store().list("control/v1");

    expect(entries.map((entry) => entry.key)).toEqual([
      "control/v1/a.json",
      "control/v1/z.json",
    ]);
    expect(entries.every((entry) => entry.digest.startsWith("sha256:"))).toBe(true);
  });
});
