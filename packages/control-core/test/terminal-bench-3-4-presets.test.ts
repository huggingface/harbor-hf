import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const catalog = await PresetCatalog.load(
  fileURLToPath(new URL("../../../presets", import.meta.url)),
);

const versions = [
  {
    benchmark: "terminal-bench-3-0",
    revision: "2b0442c3c583b710ca8da14c8e601b99f2f1f244",
  },
  {
    benchmark: "terminal-bench-4-0",
    revision: "452bf305c6daa62fc59061d22133a7cbc7c1572e",
  },
] as const;

const variants = [
  { preset: "one-task-1-trial", attempts: 1, concurrency: 1, final: false },
  { preset: "all-tasks-1-trial", attempts: 1, concurrency: 8, final: false },
  { preset: "all-tasks-5-trials", attempts: 5, concurrency: 8, final: true },
] as const;

describe.each(versions)("$benchmark built-in presets", ({ benchmark, revision }) => {
  it.each(variants)(
    "$preset uses its exact release",
    ({ preset, attempts, concurrency, final }) => {
      const actual = catalog.benchmark(benchmark, preset);
      expect(actual.leaderboard_eligible).toBe(final);
      expect(actual.job).toEqual({
        datasets: [
          {
            repo: `https://github.com/harbor-framework/terminal-bench.git@${revision}`,
            path: "tasks",
            ...(preset === "one-task-1-trial"
              ? { task_names: ["interleaved-vigenere"] }
              : {}),
          },
        ],
        n_attempts: attempts,
        n_concurrent_trials: concurrency,
        environment: {
          type: "hf-sandbox",
          kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
        },
      });
      expect(actual.job.agent_timeout_multiplier).toBeUndefined();
      expect(actual.job.retry).toBeUndefined();
    },
  );
});
