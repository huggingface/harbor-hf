import { expect, test } from "@playwright/test";

const runs = [
  { role: "diagnostic", status: "finished", name: "recipe-one", model: "model-one" },
].map((item, index) => {
  const run_id = `run-${String(index + 1).padStart(24, "0")}`;
  return {
    record: {
      schema_version: "v1",
      run_id,
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: "synthetic-actor",
      role: item.role,
      harbor_revision: "d".repeat(40),
      ...(item.name ? { workbench_recipe: { name: item.name } } : {}),
      submission: {
        benchmark: { name: "synthetic-benchmark", preset: "sample" },
        model: { id: item.model, provider: "provider", reasoning_effort: "off" },
        harness: { agent: "command-agent", version: "recipe-revision" },
        cost_ceiling_usd_per_trial: 0.25,
      },
      harbor_job_config: {
        agents: [{ import_path: "plugin:CommandAgent", model_name: item.model }],
        n_attempts: 1,
      },
    },
    state: {
      schema_version: "v1",
      run_id,
      revision: 0,
      updated_at: "2026-01-01T00:00:00Z",
      desired_state: "run",
      actor: "synthetic-actor",
      parent_jobs: [],
    },
    status: item.status,
    result: {
      stats: {
        evals: {
          one: {
            exception_stats: { AgentTimeoutError: ["trial-timeout", "trial-timeout"] },
          },
        },
      },
    },
  };
});

test("native agent timeout is separate from infrastructure in summary and diagnostics", async ({
  page,
}) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    if (route.request().method() !== "GET") {
      writes.push(route.request().method());
      await route.abort();
      return;
    }
    const base = `/api/v1/runs/${runs[0]?.record.run_id}`;
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
        workbench: { runner: "hf-jobs", setup_enabled: false },
        write_mode: "disabled",
        ready: true,
        projection: { runs: 1, trials: 0, parent_jobs: 0 },
        capacity: { max_active_parent_jobs: 16 },
        resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
      },
      "/api/v1/runs": { runs },
      "/api/v1/jobs": { jobs: [] },
      [base]: runs[0],
      [`${base}/trials`]: { trials: [] },
      [`${base}/progress`]: {
        observed_at: "2026-01-01T00:00:00Z",
        jobs_observed_at: null,
        lock: null,
        trials: [],
        jobs: [],
      },
    };
    await route.fulfill({
      json: responses[new URL(route.request().url()).pathname] ?? {},
    });
  });
  await page.goto("/runs");
  const table = page.getByRole("table");
  await expect(table.getByText("Agent timeouts: 1", { exact: true })).toBeVisible();
  await expect(
    table.getByText("Infra-related trials: 0 · unclassified: 0", { exact: true }),
  ).toBeVisible();
  await expect(table.getByText("1 affected trial", { exact: true })).toHaveClass(
    /text-red-400/,
  );
  await table.getByRole("link", { name: /Harbor-reported exceptions/ }).click();
  const panel = page.getByRole("region", { name: "Harbor-reported exceptions" });
  await expect(
    panel.getByText("Agent execution timeout: 1", { exact: true }),
  ).toBeVisible();
  const row = panel
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /AgentTimeoutError/ }) });
  await expect(row.getByText("Agent execution timeout", { exact: true })).toBeVisible();
  await expect(
    row.getByText(/Environment \/ transport|Provider failure|Unclassified/),
  ).toHaveCount(0);
  await expect(
    panel.getByText(/native type alone does not prove timeout origin/),
  ).toBeVisible();
  await expect(page.getByText(/replacement candidate/i)).toHaveCount(0);
  expect(writes).toEqual([]);
});
