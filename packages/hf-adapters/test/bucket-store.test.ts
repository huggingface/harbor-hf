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

function store() {
  return new HuggingFaceBucketStore({
    bucketId: "example/control",
    accessToken: token,
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
