import { describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));

vi.mock("@huggingface/hub", async (importOriginal) => {
  const original = await importOriginal<typeof import("@huggingface/hub")>();
  return {
    ...original,
    listFiles: async function* (parameters: { path?: string }) {
      const prefix = parameters.path ?? "";
      for (const [path, bytes] of [...memory.objects].sort()) {
        if (!path.startsWith(prefix)) continue;
        const seed =
          bytes.length === 0 ? "00" : bytes[0]?.toString(16).padStart(2, "0");
        yield {
          type: "file",
          path,
          size: bytes.byteLength,
          xetHash: (seed ?? "00").repeat(32),
        };
      }
    },
    uploadFile: async (parameters: { file: { path: string; content: Blob } }) => {
      memory.objects.set(
        parameters.file.path,
        new Uint8Array(await parameters.file.content.arrayBuffer()),
      );
      return undefined;
    },
  };
});

import { ImmutableConflictError } from "@harbor-hf/control-core";
import { HuggingFaceBucketStore } from "../src/bucket-store.js";

function store(): HuggingFaceBucketStore {
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const marker = "/resolve/";
    const index = url.pathname.indexOf(marker);
    const key = decodeURIComponent(url.pathname.slice(index + marker.length));
    const bytes = memory.objects.get(key);
    return bytes
      ? new Response(bytes, { status: 200 })
      : new Response("", { status: 404 });
  };
  return new HuggingFaceBucketStore({
    bucketId: "example/bucket",
    accessToken: "test-token",
    retryDelaysMs: [],
    fetch: fakeFetch,
  });
}

describe("HuggingFaceBucketStore", () => {
  it("keeps at most eight Bucket requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const held: Array<() => void> = [];
    const slowFetch: typeof fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((release) => held.push(release));
      active--;
      return new Response(new TextEncoder().encode("{}"), { status: 200 });
    };
    const bucket = new HuggingFaceBucketStore({
      bucketId: "example/bucket",
      accessToken: "test-token",
      retryDelaysMs: [],
      cacheMaxBytes: 0,
      fetch: slowFetch,
    });
    const reads = Array.from({ length: 20 }, (_, index) =>
      bucket.read(`runs/run-${String(index).padStart(24, "0")}/run.json`),
    );
    while (held.length < 8) await new Promise((resolve) => setTimeout(resolve, 1));
    for (let released = 0; released < 20; released++) {
      while (held.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      held.shift()?.();
    }
    await Promise.all(reads);
    expect(peak).toBe(8);
  });

  it("creates immutable objects and updates mutable objects", async () => {
    memory.objects.clear();
    const bucket = store();
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");

    expect((await bucket.create("runs/a/run.json", first)).created).toBe(true);
    expect((await bucket.create("runs/a/run.json", first)).created).toBe(false);
    await expect(bucket.create("runs/a/run.json", second)).rejects.toBeInstanceOf(
      ImmutableConflictError,
    );
    await bucket.put("runs/a/state.json", first);
    await bucket.put("runs/a/state.json", second);

    expect(new TextDecoder().decode(await bucket.read("runs/a/state.json"))).toBe(
      "second",
    );
    expect((await bucket.list("runs/")).map((entry) => entry.key)).toEqual([
      "runs/a/run.json",
      "runs/a/state.json",
    ]);
  });

  it("reports a missing object and rejects invalid limits", async () => {
    memory.objects.clear();
    await expect(store().read("missing.json")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      () =>
        new HuggingFaceBucketStore({
          bucketId: "example/bucket",
          accessToken: "test-token",
          listTimeoutMs: 0,
        }),
    ).toThrow("positive integer");
    expect(
      () =>
        new HuggingFaceBucketStore({
          bucketId: "example/bucket",
          accessToken: "test-token",
          cacheMaxBytes: -1,
        }),
    ).toThrow("nonnegative integer");
  });
});

it("fresh mutable metadata reads bypass stale cached content without a Bucket scan", async () => {
  memory.objects.clear();
  const bucket = store();
  const key = "runs/example/pricing-corrections.json";
  memory.objects.set(key, new TextEncoder().encode("before"));
  expect(new TextDecoder().decode(await bucket.read(key))).toBe("before");
  memory.objects.set(key, new TextEncoder().encode("after"));
  const listing = vi.spyOn(bucket, "list");
  expect(new TextDecoder().decode(await bucket.read(key))).toBe("before");
  expect(new TextDecoder().decode(await bucket.read(key, { fresh: true }))).toBe(
    "after",
  );
  expect(listing).not.toHaveBeenCalled();
  memory.objects.delete(key);
  await expect(bucket.read(key, { fresh: true })).rejects.toMatchObject({
    code: "ENOENT",
  });
});
