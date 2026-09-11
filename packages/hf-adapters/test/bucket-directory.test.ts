import { describe, expect, it, vi } from "vitest";

const listing = vi.hoisted(() => ({
  entries: [] as { type: string; path: string; size: number; xetHash?: string }[],
  calls: vi.fn(),
}));
vi.mock("@huggingface/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@huggingface/hub")>()),
  listFiles: async function* (parameters: unknown) {
    listing.calls(parameters);
    yield* listing.entries;
  },
}));
import { HuggingFaceBucketStore } from "../src/bucket-store.js";

function fixture() {
  listing.calls.mockClear();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response("first"));
  const store = new HuggingFaceBucketStore({
    bucketId: "example/bucket",
    accessToken: "test-token",
    retryDelaysMs: [],
    fetch,
  });
  return { fetch, store };
}

describe("Bucket shallow directory adapter", () => {
  it("requests nonrecursive metadata, returns immediate directories and selected native source hashes", async () => {
    const { store, fetch } = fixture();
    listing.entries = [
      { type: "directory", path: "runs/a/job/trial-a", size: 0 },
      { type: "file", path: "runs/a/job/lock.json", size: 5, xetHash: "A".repeat(64) },
      { type: "file", path: "runs/a/job/job.log", size: 100 },
      { type: "file", path: "runs/a/job/trial-a/agent/trajectory.json", size: 100 },
      { type: "directory", path: "runs/a/job/trial-a/agent", size: 0 },
      { type: "directory", path: "runs/other/job/trial-b", size: 0 },
    ];
    expect(await store.listDirectory("runs/a/job/", ["lock.json"])).toEqual({
      files: [
        {
          key: "runs/a/job/lock.json",
          size: 5,
          source_identity: `xet:${"a".repeat(64)}`,
        },
      ],
      directories: ["runs/a/job/trial-a/"],
    });
    expect(listing.calls).toHaveBeenCalledWith(
      expect.objectContaining({ path: "runs/a/job/", recursive: false, expand: true }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates lower-level cached bytes when shallow file identities change", async () => {
    const { store, fetch } = fixture();
    listing.entries = [
      { type: "file", path: "runs/a/result.json", size: 5, xetHash: "a".repeat(64) },
    ];
    await store.listDirectory("runs/a/");
    expect(new TextDecoder().decode(await store.read("runs/a/result.json"))).toBe(
      "first",
    );
    await store.listDirectory("runs/a/");
    await store.read("runs/a/result.json");
    expect(fetch).toHaveBeenCalledTimes(1);
    listing.entries[0] = {
      type: "file",
      path: "runs/a/result.json",
      size: 6,
      xetHash: "b".repeat(64),
    };
    fetch.mockResolvedValueOnce(new Response("second"));
    await store.listDirectory("runs/a/");
    expect(new TextDecoder().decode(await store.read("runs/a/result.json"))).toBe(
      "second",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid selected source hashes and propagates listing failures", async () => {
    const { store } = fixture();
    listing.entries = [
      { type: "file", path: "runs/a/result.json", size: 5, xetHash: "bad" },
    ];
    await expect(store.listDirectory("runs/a/", ["result.json"])).rejects.toThrow(
      "xetHash",
    );
    listing.calls.mockImplementationOnce(() => {
      throw new Error("listing failed");
    });
    await expect(store.listDirectory("runs/a/")).rejects.toThrow("listing failed");
    listing.entries = [];
    expect(await store.listDirectory("runs/a/")).toEqual({
      files: [],
      directories: [],
    });
  });
});
