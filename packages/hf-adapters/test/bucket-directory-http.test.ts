import { describe, expect, it, vi } from "vitest";
import { HuggingFaceBucketStore } from "../src/bucket-store.js";

const prefix = "runs/run-0123456789abcdef01234567/job/";
const next = "https://huggingface.co/api/buckets/example/artifacts/tree?cursor=next";
const directory = (name: string) => ({
  type: "directory",
  path: `${prefix}${name}`,
  size: 0,
});
const page = (names: string[], more = false) =>
  new Response(JSON.stringify(names.map(directory)), {
    headers: more ? { Link: `<${next}>; rel="next"` } : {},
  });
const store = (transport: typeof fetch, retryDelaysMs: number[] = []) =>
  new HuggingFaceBucketStore({
    bucketId: "example/artifacts",
    accessToken: ["hf", "synthetic"].join("_"),
    fetch: transport,
    retryDelaysMs,
  });

describe("shallow directory HTTP pagination", () => {
  it("discovers beyond 100 entries through the real SDK without recursive reads", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `trial-${index}`);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(names, true))
      .mockResolvedValueOnce(page(["later-trial"]));
    const listing = await store(transport).listDirectory(prefix, ["lock.json"]);
    expect(listing.directories).toHaveLength(101);
    expect(listing.directories).toContain(`${prefix}later-trial/`);
    expect(listing.files).toEqual([]);
    expect(String(transport.mock.calls[0]?.[0])).toContain("recursive=false");
    expect(transport.mock.calls[1]?.[0]).toBe(next);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not return a partial directory inventory when a later page fails", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(["earlier"], true))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(store(transport).listDirectory(prefix)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("discards partially accumulated directories before retrying discovery", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(["removed-before-retry"], true))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(page(["current"]));
    expect(await store(transport, [0]).listDirectory(prefix)).toEqual({
      files: [],
      directories: [`${prefix}current/`],
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
