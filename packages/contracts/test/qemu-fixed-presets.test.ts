import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBenchmarkPreset, validateHarborJobConfig } from "../src/index.js";

const root = new URL("../../../presets/benchmarks/", import.meta.url);
const source =
  "https://github.com/evalstate/terminal-bench-2-1.git@75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e";

function load(name: string) {
  return validateBenchmarkPreset(
    JSON.parse(readFileSync(new URL(`terminal-bench-2-1-${name}.json`, root), "utf8")),
  );
}

describe("QEMU-fixed diagnostic presets", () => {
  it.each(["all-tasks-1-trial", "all-tasks-5-trials"])(
    "preserves the original native configuration for %s except source",
    (name) => {
      const original = load(name);
      const fixed = load(`${name}-qemu-fixed`);
      expect(fixed.preset).toBe(`${name}-qemu-fixed`);
      expect(fixed.leaderboard_eligible).toBe(false);
      expect(fixed.job).toEqual({
        ...original.job,
        datasets: [{ repo: source, path: "tasks" }],
      });
      expect(original.job.datasets[0]).toEqual({
        repo: "https://github.com/harbor-framework/terminal-bench-2-1.git@d49e28f1e4ddd13d289e85a5f312a66750951932",
        path: "tasks",
      });
      expect(fixed.job.n_concurrent_trials).toBe(8);
      expect(() => validateHarborJobConfig(fixed.job)).not.toThrow();
    },
  );

  it("defines two QEMU tasks, two native attempts, concurrency two and no retries", () => {
    const fixed = load("two-tasks-2-trials-qemu-fixed");
    expect(fixed.leaderboard_eligible).toBe(false);
    expect(fixed.job).toEqual({
      ...load("all-tasks-1-trial-qemu-fixed").job,
      datasets: [
        {
          repo: source,
          path: "tasks",
          task_names: ["qemu-startup", "qemu-alpine-ssh"],
        },
      ],
      n_attempts: 2,
      n_concurrent_trials: 2,
      retry: { max_retries: 0 },
    });
    expect(() => validateHarborJobConfig(fixed.job)).not.toThrow();
  });

  it("does not duplicate unrelated smoke presets", () => {
    expect(
      readdirSync(root).filter((name) => name.endsWith("-qemu-fixed.json")),
    ).toEqual([
      "terminal-bench-2-1-all-tasks-1-trial-qemu-fixed.json",
      "terminal-bench-2-1-all-tasks-5-trials-qemu-fixed.json",
      "terminal-bench-2-1-two-tasks-2-trials-qemu-fixed.json",
    ]);
  });
});
