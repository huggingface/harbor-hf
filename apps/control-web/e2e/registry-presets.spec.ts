import { expect, test } from "@playwright/test";
import { validateBenchmarkPreset } from "@harbor-hf/contracts";

const sources = [
  { name: "example/benchmark-one", ref: `sha256:${"a".repeat(64)}` },
  { name: "another/benchmark_two.v2", ref: `sha256:${"b".repeat(64)}` },
  { repo: "https://example.test/tasks.git@revision", path: "tasks" },
];
const benchmarks = sources.map((source, index) =>
  validateBenchmarkPreset({
    schema_version: "v1",
    benchmark: `example-${index}`,
    preset: "selected-tasks",
    leaderboard_eligible: false,
    job: {
      datasets: [{ ...source, task_names: ["task-one", "task-two"] }],
      n_attempts: 3,
      n_concurrent_trials: index + 1,
      environment: {
        type: "hf-sandbox",
        kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
      },
    },
  }),
);

test("Workbench selects registry and Git presets without source-specific UI", async ({
  page,
}) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/v1/session": {
        authenticated: true,
        actor: {
          username: "synthetic-actor",
          role: "operator",
          transport: "development",
        },
      },
      "/api/v1/system": {
        write_mode: "disabled",
        ready: true,
        workbench: { runner: "disabled", setup_enabled: false },
        projection: { runs: 0, trials: 0, parent_jobs: 0 },
        capacity: { max_active_parent_jobs: 1 },
        resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
      },
      "/api/v1/presets": { benchmarks, agents: [] },
      "/api/v1/workbench/setup-tests": { setups: [] },
    };
    if (path === "/api/v1/workbench/preview") {
      await route.fulfill({
        json: {
          recipe: route.request().postDataJSON(),
          recipe_digest: "a".repeat(64),
          revision_id: "synthetic-revision",
          setup_command: "true",
          run_command: "true",
          environment: [],
          harbor_agent: { import_path: "example.agent:Agent", kwargs: {} },
          warnings: [],
        },
      });
      return;
    }
    expect(route.request().method()).toBe("GET");
    expect(path in responses).toBe(true);
    await route.fulfill({ json: responses[path] });
  });
  await page.goto("/workbench");
  const selector = page.getByRole("combobox", {
    name: "Benchmark preset",
    exact: true,
  });
  for (const benchmark of benchmarks) {
    const value = `${benchmark.benchmark}\n${benchmark.preset}`;
    await selector.selectOption({
      label: `${benchmark.benchmark} · ${benchmark.preset}`,
    });
    await expect(selector).toHaveValue(value);
    await expect(page.getByLabel("Concurrent trials", { exact: true })).toHaveValue(
      String(benchmark.job.n_concurrent_trials),
    );
  }
});
