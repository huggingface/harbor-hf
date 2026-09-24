import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PresetSourceSnapshot } from "@harbor-hf/control-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];
const revision = "a".repeat(40);
const digest = "b".repeat(64);

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function config(sources: unknown = []): Promise<ReturnType<typeof loadConfig>> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-preset-runtime-"));
  roots.push(root);
  return loadConfig({
    NODE_ENV: "test",
    HARBOR_HF_NAMESPACE: "synthetic",
    HARBOR_HF_BUCKET_ID: "synthetic/artifacts",
    HARBOR_HF_BUCKET_ROOT: join(root, "store"),
    HARBOR_HF_PROJECTION_PATH: join(root, "projection.sqlite"),
    HARBOR_HF_AUTH_PATH: join(root, "auth.sqlite"),
    HARBOR_HF_PRESETS_ROOT: resolve("presets"),
    HARBOR_HF_AUTH_MODE: "development",
    HARBOR_HF_PRESET_SOURCES: JSON.stringify(sources),
  });
}

const configured = { repository: "example/preset-source", kind: "dataset", revision };

function agentPreset(agent: string, version: string): string {
  return JSON.stringify({
    schema_version: "v1",
    agent,
    version,
    harbor_agent: { name: "demo-agent" },
    reasoning_option: null,
    reasoning_values: ["default"],
  });
}

function snapshot(name: string, content: string): PresetSourceSnapshot {
  return {
    source: { ...configured, path: "presets" },
    files: [{ path: `agents/${name}`, content }],
    digest,
  };
}

/** Directories this service created, so a failed startup cannot leave one behind. */
async function presetDirectories(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((item) => item.startsWith("harbor-hf-presets-")).sort();
}

describe("preset sources at startup", () => {
  it("adds a pinned source to the catalog and removes the merge when it closes", async () => {
    const runtime = await createRuntime(
      await config([configured]),
      () => undefined,
      async () => snapshot("extra.json", agentPreset("extra", "0.1.0")),
    );
    runtimes.push(runtime);

    expect(runtime.presets.agent("extra", "0.1.0").agent).toBe("extra");
    expect(runtime.presets.agent("pi", "0.84.4").agent).toBe("pi");
    expect(runtime.preset_sources).toEqual([
      {
        repository: "example/preset-source",
        kind: "dataset",
        revision,
        path: "presets",
        digest,
        agents: [{ agent: "extra", version: "0.1.0" }],
        benchmarks: [],
      },
    ]);
    const merged = runtime.config.presets_root;
    expect(merged).not.toBe(resolve("presets"));
    expect(await readdir(join(merged, "agents"))).toContain("extra.json");

    await runtime.close();
    await expect(readdir(merged)).rejects.toThrow();
  });

  it("publishes the source provenance with the catalog it belongs to", async () => {
    const runtime = await createRuntime(
      await config([configured]),
      () => undefined,
      async () => snapshot("extra.json", agentPreset("extra", "0.1.0")),
    );
    runtimes.push(runtime);
    const app = await buildApp(runtime);
    const response = await app.inject({ method: "GET", url: "/api/v1/presets" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ agents: unknown[]; sources: unknown[] }>();
    expect(body.agents).toContainEqual(
      expect.objectContaining({ agent: "extra", version: "0.1.0" }),
    );
    expect(body.sources).toEqual([
      expect.objectContaining({
        repository: "example/preset-source",
        digest,
        agents: [{ agent: "extra", version: "0.1.0" }],
      }),
    ]);
  });

  it("reads the baked catalog directly when no source is configured", async () => {
    const runtime = await createRuntime(await config(), () => undefined);
    runtimes.push(runtime);
    expect(runtime.config.presets_root).toBe(resolve("presets"));
    expect(runtime.preset_sources).toEqual([]);
  });

  it("stops before a run can use a source that cannot be read or verified", async () => {
    const before = await presetDirectories();
    await expect(
      createRuntime(
        await config([configured]),
        () => undefined,
        async () => {
          throw new Error("preset source is unavailable");
        },
      ),
    ).rejects.toThrow("preset source is unavailable");
    expect(await presetDirectories()).toEqual(before);

    await expect(
      createRuntime(
        await config([configured]),
        () => undefined,
        async () => snapshot("pi-0.84.4.json", agentPreset("pi", "0.84.4")),
      ),
    ).rejects.toThrow("both provide pi-0.84.4.json");
    expect(await presetDirectories()).toEqual(before);
  });
});
