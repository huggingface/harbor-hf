import { resolve } from "node:path";
import { validateStrictHarborJobConfig } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/index.js";

describe("native two-task canary", () => {
  it("retains the historical selection with bounded native trial settings", async () => {
    const catalog = await PresetCatalog.load(resolve("presets"));
    const preset = catalog.benchmark("terminal-bench-2-1", "two-task-canary");
    const config = validateStrictHarborJobConfig(preset.job);

    expect(config.datasets).toEqual([
      {
        repo: "https://github.com/harbor-framework/terminal-bench-2-1.git@d49e28f1e4ddd13d289e85a5f312a66750951932",
        path: "tasks",
        task_names: ["adaptive-rejection-sampler", "modernize-scientific-stack"],
      },
    ]);
    expect(config.n_attempts).toBe(1);
    expect(config.n_concurrent_trials).toBe(1);
    expect(config.retry).toEqual({ max_retries: 0 });
    expect(config.environment).toEqual({
      type: "hf-sandbox",
      kwargs: { flavor: "cpu-upgrade", job_timeout: "30m" },
    });
    expect(catalog.leaderboardEligible("terminal-bench-2-1", "two-task-canary")).toBe(
      false,
    );
  });

  it("returns independent configuration without changing the saved selection", async () => {
    const catalog = await PresetCatalog.load(resolve("presets"));
    const preset = catalog.benchmark("terminal-bench-2-1", "two-task-canary");
    preset.job.n_attempts = 10;
    expect(
      catalog.benchmark("terminal-bench-2-1", "two-task-canary").job.n_attempts,
    ).toBe(1);
  });
});
