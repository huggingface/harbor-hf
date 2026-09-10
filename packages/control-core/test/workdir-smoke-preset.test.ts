import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const catalog = await PresetCatalog.load(
  fileURLToPath(new URL("../../../presets", import.meta.url)),
);

describe("two-task workdir smoke preset", () => {
  it("retains native smoke inputs with exactly two unretried logical trials", () => {
    const original = catalog.benchmark("terminal-bench-2-1", "three-tasks-3-trials");
    const preset = catalog.benchmark(
      "terminal-bench-2-1",
      "two-tasks-1-trial-workdir-smoke",
    );
    expect(preset).toEqual({
      ...original,
      preset: "two-tasks-1-trial-workdir-smoke",
      job: {
        ...original.job,
        datasets: [
          {
            ...original.job.datasets[0],
            task_names: ["prove-plus-comm", "openssl-selfsigned-cert"],
          },
        ],
        n_attempts: 1,
        n_concurrent_trials: 2,
        retry: { max_retries: 0 },
      },
    });
    expect(preset.leaderboard_eligible).toBe(false);
    expect(
      new Set(preset.job.datasets[0]?.task_names).size * preset.job.n_attempts,
    ).toBe(2);
    expect(preset.job.agents).toBeUndefined();
    expect(preset.job.environment.kwargs.job_timeout).toBe("none");
    expect(catalog.benchmarks[0]?.preset).toBe("all-tasks-1-trial-qemu-fixed");
  });
});
