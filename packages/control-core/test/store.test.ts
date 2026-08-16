import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemObjectStore, ImmutableConflictError } from "../src/store.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("FilesystemObjectStore", () => {
  it("adopts identical bytes and rejects conflicting bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-store-"));
    roots.push(root);
    const store = new FilesystemObjectStore(root);
    expect(
      (await store.create("control/schema=v1/a.json", new TextEncoder().encode("one")))
        .created,
    ).toBe(true);
    expect(
      (await store.create("control/schema=v1/a.json", new TextEncoder().encode("one")))
        .created,
    ).toBe(false);
    await expect(
      store.create("control/schema=v1/a.json", new TextEncoder().encode("two")),
    ).rejects.toBeInstanceOf(ImmutableConflictError);
    expect((await store.list("control/schema=v1")).map((entry) => entry.key)).toEqual([
      "control/schema=v1/a.json",
    ]);
  });

  it("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-store-"));
    roots.push(root);
    const store = new FilesystemObjectStore(root);
    await expect(store.create("../escape", new Uint8Array())).rejects.toThrow(
      "escapes",
    );
  });
});
