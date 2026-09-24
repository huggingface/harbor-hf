import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializePresetRoot,
  parsePresetSources,
  type PresetSourceSnapshot,
} from "../src/preset-sources.js";

const roots: string[] = [];
const revision = "a".repeat(40);
const digest = "b".repeat(64);

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-preset-sources-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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

function benchmarkPreset(benchmark: string, preset: string): string {
  return JSON.stringify({
    schema_version: "v1",
    benchmark,
    preset,
    leaderboard_eligible: false,
    job: {
      datasets: [
        {
          repo: "https://example.test/tasks.git@revision",
          path: "tasks",
        },
      ],
      n_attempts: 1,
      n_concurrent_trials: 1,
      environment: {
        type: "hf-sandbox",
        kwargs: { flavor: "cpu-basic", job_timeout: "none" },
      },
    },
  });
}

async function baked(root: string): Promise<void> {
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "benchmarks"), { recursive: true });
  await writeFile(join(root, "agents", "demo.json"), agentPreset("demo", "1.0.0"));
  await writeFile(
    join(root, "benchmarks", "demo.json"),
    benchmarkPreset("demo-bench", "one-task"),
  );
}

function snapshot(files: { path: string; content: string }[]): PresetSourceSnapshot {
  return {
    source: {
      repository: "example/preset-source",
      kind: "dataset",
      revision,
      path: "presets",
    },
    files,
    digest,
  };
}

describe("parsePresetSources", () => {
  it("accepts a pinned source and defaults the directory to the repository root", () => {
    expect(
      parsePresetSources([
        {
          repository: "example/preset-source",
          kind: "model",
          revision,
        },
      ]),
    ).toEqual([
      { repository: "example/preset-source", kind: "model", revision, path: "" },
    ]);
    expect(parsePresetSources([])).toEqual([]);
  });

  const rejected: Array<[string, unknown]> = [
    ["a non-list", {}],
    ["an entry that is not an object", ["example/source"]],
    ["an unknown field", [{ repository: "a/b", kind: "dataset", revision, note: "x" }]],
    ["a repository URL", [{ repository: "https://x/a/b", kind: "dataset", revision }]],
    [
      "a repository without a namespace",
      [{ repository: "example", kind: "dataset", revision }],
    ],
    ["an unknown kind", [{ repository: "a/b", kind: "space", revision }]],
    ["a short revision", [{ repository: "a/b", kind: "dataset", revision: "abcdef0" }]],
    [
      "an uppercase revision",
      [{ repository: "a/b", kind: "dataset", revision: revision.toUpperCase() }],
    ],
    [
      "an absolute path",
      [{ repository: "a/b", kind: "dataset", revision, path: "/presets" }],
    ],
    [
      "a traversing path",
      [{ repository: "a/b", kind: "dataset", revision, path: "../presets" }],
    ],
  ];
  it.each(rejected)("refuses %s", (_label, value) => {
    expect(() => parsePresetSources(value)).toThrow();
  });

  it("refuses the same source twice and more than the limit", () => {
    const source = { repository: "a/b", kind: "dataset", revision, path: "presets" };
    expect(() => parsePresetSources([source, source])).toThrow("configured twice");
    expect(() => parsePresetSources(Array.from({ length: 9 }, () => source))).toThrow(
      "at most",
    );
  });
});

describe("materializePresetRoot", () => {
  it("merges pinned sources over the baked catalog and reports provenance", async () => {
    const bakedRoot = await directory();
    await baked(bakedRoot);
    const target = await directory();
    const root = await materializePresetRoot({
      bakedRoot,
      snapshots: [
        snapshot([
          { path: "agents/extra.json", content: agentPreset("extra", "0.1.0") },
          {
            path: "benchmarks/extra.json",
            content: benchmarkPreset("extra-bench", "one"),
          },
        ]),
      ],
      directory: target,
    });

    expect(root.root).toBe(target);
    expect(root.directory).toBe(target);
    expect(
      JSON.parse(await readFile(join(target, "agents", "extra.json"), "utf8")),
    ).toMatchObject({ agent: "extra" });
    expect(
      JSON.parse(await readFile(join(target, "agents", "demo.json"), "utf8")),
    ).toMatchObject({ agent: "demo" });
    expect(root.sources).toEqual([
      {
        repository: "example/preset-source",
        kind: "dataset",
        revision,
        path: "presets",
        digest,
        agents: [{ agent: "extra", version: "0.1.0" }],
        benchmarks: [{ benchmark: "extra-bench", preset: "one" }],
      },
    ]);
  });

  it("refuses two owners of one preset file", async () => {
    const bakedRoot = await directory();
    await baked(bakedRoot);
    await expect(
      materializePresetRoot({
        bakedRoot,
        snapshots: [
          snapshot([
            { path: "agents/demo.json", content: agentPreset("demo", "1.0.0") },
          ]),
        ],
        directory: await directory(),
      }),
    ).rejects.toThrow("both provide demo.json");
  });

  it("refuses two owners of one preset identity under different file names", async () => {
    const bakedRoot = await directory();
    await baked(bakedRoot);
    await expect(
      materializePresetRoot({
        bakedRoot,
        snapshots: [
          snapshot([
            { path: "agents/other.json", content: agentPreset("demo", "1.0.0") },
          ]),
        ],
        directory: await directory(),
      }),
    ).rejects.toThrow("both provide the same preset");
  });

  it("names the source and the file of an invalid preset", async () => {
    const bakedRoot = await directory();
    await baked(bakedRoot);
    await expect(
      materializePresetRoot({
        bakedRoot,
        snapshots: [snapshot([{ path: "benchmarks/broken.json", content: "{}" }])],
        directory: await directory(),
      }),
    ).rejects.toThrow(
      /example\/preset-source@a{40}\/presets returned an invalid preset in broken\.json/,
    );
  });

  it("refuses JSON that cannot be read and files outside the preset directories", async () => {
    const bakedRoot = await directory();
    await baked(bakedRoot);
    await expect(
      materializePresetRoot({
        bakedRoot,
        snapshots: [snapshot([{ path: "agents/broken.json", content: "{" }])],
        directory: await directory(),
      }),
    ).rejects.toThrow("invalid JSON in broken.json");
    await expect(
      materializePresetRoot({
        bakedRoot,
        snapshots: [snapshot([{ path: "workbench/recipe.json", content: "{}" }])],
        directory: await directory(),
      }),
    ).rejects.toThrow("outside agents/ and benchmarks/");
  });
});
