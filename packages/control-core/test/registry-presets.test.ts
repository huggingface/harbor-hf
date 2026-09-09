import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBenchmarkPreset } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const ref = `sha256:${"a".repeat(64)}`;
const git = { repo: "https://example.test/tasks.git@revision", path: "tasks" };
const names = ["example/benchmark-one", "another/benchmark_two.v2"];
function preset(dataset: object) {
  return {
    schema_version: "v1",
    benchmark: "example-benchmark",
    preset: "selected-tasks",
    leaderboard_eligible: false,
    job: {
      datasets: [dataset],
      n_attempts: 3,
      n_concurrent_trials: 1,
      environment: {
        type: "hf-sandbox",
        kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
      },
    },
  };
}

describe("native registry benchmark presets", () => {
  it.each([...names.map((name) => ({ name, ref })), git])(
    "preserves native selection through both compilation paths: %j",
    async (source) => {
      const dataset = {
        ...source,
        task_names: Array.from({ length: 50 }, (_, index) => `task-${index}`),
        exclude_task_names: ["unused-*"],
        n_tasks: 50,
      };
      const input = preset(dataset);
      expect(validateBenchmarkPreset(input)).toEqual(input);
      const root = await mkdtemp(join(tmpdir(), "registry-presets-"));
      try {
        await mkdir(join(root, "benchmarks"));
        await mkdir(join(root, "agents"));
        await writeFile(
          join(root, "benchmarks", "example.json"),
          JSON.stringify(input),
        );
        await writeFile(
          join(root, "agents", "example.json"),
          JSON.stringify({
            schema_version: "v1",
            agent: "example-agent",
            version: "1.0.0",
            harbor_agent: { import_path: "example.agent:Agent" },
            reasoning_option: null,
            reasoning_values: ["default"],
          }),
        );
        const catalog = await PresetCatalog.load(root);
        const submission = {
          benchmark: { name: input.benchmark, preset: input.preset },
          model: {
            id: "example/model",
            provider: "example",
            reasoning_effort: "default",
          },
          harness: { agent: "example-agent", version: "1.0.0" },
          cost_ceiling_usd_per_trial: 1,
          n_concurrent_trials: 2,
        };
        const normal = catalog.buildJobConfig("run-example", submission, "/data");
        const workbench = catalog.buildWorkbenchJobConfig(
          "run-example",
          { ...submission, model: { ...submission.model, reasoning_effort: "off" } },
          "/data",
          { import_path: "harbor_hf_agents.command_agent.agent:CommandAgent" },
        );
        for (const config of [normal, workbench]) {
          expect(config.datasets).toEqual([dataset]);
          expect(config.n_attempts).toBe(3);
          expect(config.n_concurrent_trials).toBe(2);
          expect(config.agents).toHaveLength(1);
          expect(dataset.task_names.length * config.n_attempts!).toBe(150);
          expect(config.datasets).not.toBe(input.job.datasets);
          config.datasets?.splice(0);
          expect(catalog.benchmark(input.benchmark, input.preset)).toEqual(input);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {},
    { name: names[0] },
    { ref },
    { name: "bare-name", ref },
    { name: "example/name/extra", ref },
    { name: "example/../name", ref },
    { name: "example/.hidden", ref },
    { name: "example/-name", ref },
    { name: "example/name\n", ref },
    { name: " example/name", ref },
    { name: "example/name@latest", ref },
    { name: names[0], ref: "latest" },
    { name: names[0], ref: `sha256:${"A".repeat(64)}` },
    { name: names[0], ref: `${ref}\n` },
    { name: names[0], ref: ref.slice(0, -1) },
    { name: names[0], ref, version: "v1" },
    { name: names[0], ref, ...git },
    { name: names[0], ref, path: "tasks" },
    { name: names[0], ref, registry_url: "https://example.test" },
    { name: names[0], ref, registry_path: "/data/registry" },
    { name: names[0], ref, download_dir: "/data/cache" },
    { name: names[0], ref, task_names: [] },
    { name: names[0], ref, task_names: [""] },
    { name: names[0], ref, exclude_task_names: [1] },
    { name: names[0], ref, n_tasks: 0 },
    { name: names[0], ref, n_tasks: 1.5 },
    { ...git, ref },
    { repo: git.repo },
    { path: "tasks" },
  ])(
    "rejects incomplete, mixed, mutable or unreviewed dataset fields: %j",
    (dataset) => {
      expect(() => validateBenchmarkPreset(preset(dataset))).toThrow();
    },
  );
});
