import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  benchmarkCatalogPrefix,
  initializeBenchmarkCatalog,
  listReviewedBenchmarkConfigs,
} from "../src/run-configs.js";
import {
  listWorkbenchConfigurations,
  saveWorkbenchConfiguration,
} from "../src/saved-workbench.js";
import { createJson, FilesystemObjectStore } from "../src/store.js";
import { fastAgentWorkbenchStarter, fxWorkbenchStarter } from "../src/workbench.js";

let root: string;
let store: FilesystemObjectStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workbench-library-"));
  store = new FilesystemObjectStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("saved configurations", () => {
  it("persists both starters across store recreation, isolates owners, and adopts identical saves", async () => {
    const first = await saveWorkbenchConfiguration(
      store,
      "owner-a",
      fastAgentWorkbenchStarter,
    );
    expect(
      await saveWorkbenchConfiguration(store, "owner-a", fastAgentWorkbenchStarter),
    ).toEqual(first);
    await saveWorkbenchConfiguration(store, "owner-a", fxWorkbenchStarter);
    expect(
      await listWorkbenchConfigurations(new FilesystemObjectStore(root), "owner-a"),
    ).toHaveLength(2);
    expect(await listWorkbenchConfigurations(store, "owner-b")).toEqual([]);
  });
  it("retains old revisions when a named recipe changes", async () => {
    await saveWorkbenchConfiguration(store, "owner", fastAgentWorkbenchStarter);
    await saveWorkbenchConfiguration(store, "owner", {
      ...fastAgentWorkbenchStarter,
      setup_timeout_seconds: 400,
    });
    expect(await listWorkbenchConfigurations(store, "owner")).toHaveLength(2);
  });
  it("rejects credentials and malformed recipes before writing", async () => {
    await expect(saveWorkbenchConfiguration(store, "owner", {})).rejects.toThrow();
    await expect(
      saveWorkbenchConfiguration(store, "owner", {
        ...fastAgentWorkbenchStarter,
        environment: [
          { name: "PASSWORD", source: "literal", value: "not-a-real-secret" },
        ],
      }),
    ).rejects.toThrow();
    expect(await store.list("control/")).toEqual([]);
  });
  it("rejects a saved recipe whose digest was changed", async () => {
    const saved = await saveWorkbenchConfiguration(
      store,
      "owner",
      fastAgentWorkbenchStarter,
    );
    const [entry] = await store.list("control/");
    if (!entry) throw new Error("missing fixture");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, entry.key),
      JSON.stringify({ ...saved, revision: `sha256:${"0".repeat(64)}` }),
    );
    await expect(listWorkbenchConfigurations(store, "owner")).rejects.toThrow(
      "integrity",
    );
  });
});

describe("benchmark catalog", () => {
  it("seeds once and accepts a data-only replacement without a restart", async () => {
    await initializeBenchmarkCatalog(store);
    await initializeBenchmarkCatalog(store);
    const initial = await listReviewedBenchmarkConfigs(store);
    const first = initial[0];
    if (!first) throw new Error("missing seeded configuration");
    const { revision: _revision, ...item } = first;
    await createJson(store, `${benchmarkCatalogPrefix}0000000001.json`, {
      schema_version: "v1",
      version: 1,
      items: [
        {
          ...item,
          name: "another-compatible-preset",
          label: "Another preset",
          size: "medium",
        },
      ],
    });
    const current = await listReviewedBenchmarkConfigs(store);
    expect(current[0]?.name).toBe("another-compatible-preset");
    expect(current[0]?.revision).not.toBe(initial[0]?.revision);
  });
  it("accepts an empty catalog to withdraw new submissions", async () => {
    await createJson(store, `${benchmarkCatalogPrefix}0000000001.json`, {
      schema_version: "v1",
      version: 1,
      items: [],
    });
    await initializeBenchmarkCatalog(store);
    expect(await listReviewedBenchmarkConfigs(store)).toEqual([]);
  });
  it("rejects invalid newest catalogs instead of falling back", async () => {
    await initializeBenchmarkCatalog(store);
    await createJson(store, `${benchmarkCatalogPrefix}0000000001.json`, {
      schema_version: "v1",
      version: 2,
      items: [],
    });
    await expect(listReviewedBenchmarkConfigs(store)).rejects.toThrow("version");
  });
  it("rejects duplicate names and inconsistent ceilings", async () => {
    await initializeBenchmarkCatalog(store);
    const first = (await listReviewedBenchmarkConfigs(store))[0];
    if (!first) throw new Error("missing seeded configuration");
    const { revision: _revision, ...item } = first;
    await createJson(store, `${benchmarkCatalogPrefix}0000000001.json`, {
      schema_version: "v1",
      version: 1,
      items: [item, item],
    });
    await expect(listReviewedBenchmarkConfigs(store)).rejects.toThrow("unique");
    await createJson(store, `${benchmarkCatalogPrefix}0000000002.json`, {
      schema_version: "v1",
      version: 2,
      items: [{ ...item, default_ceiling_microusd: item.max_ceiling_microusd + 1 }],
    });
    await expect(listReviewedBenchmarkConfigs(store)).rejects.toThrow("ceiling");
  });
});
