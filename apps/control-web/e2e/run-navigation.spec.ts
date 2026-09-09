import { expect, test } from "@playwright/test";

const runs = [
  { role: "diagnostic", status: "finished", name: "recipe-one", model: "model-one" },
  { role: "final", status: "running", name: "recipe-two", model: "model-two" },
  { role: "diagnostic", status: "queued", name: null, model: "historical-model" },
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
    result: null,
  };
});

test("Runs recipe identity, exact role and URL search survive refresh, reload and back", async ({
  page,
}) => {
  const writes: string[] = [];
  const progressRequests: string[] = [];
  let listRequests = 0;
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      writes.push(request.method());
    if (new URL(request.url()).pathname.endsWith("/progress"))
      progressRequests.push(request.url());
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/runs") listRequests++;
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
        source_revision: "synthetic-source",
        harbor_revision: "d".repeat(40),
        write_mode: "disabled",
        ready: true,
        projection: { runs: 3, trials: 0, parent_jobs: 0 },
        capacity: { max_active_parent_jobs: 16 },
        resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
      },
      "/api/v1/runs": { runs },
      "/api/v1/jobs": { jobs: [] },
    };
    for (const run of runs) {
      const base = `/api/v1/runs/${run.record.run_id}`;
      responses[base] = run;
      responses[`${base}/trials`] = { trials: [] };
      responses[`${base}/progress`] = {
        observed_at: "2026-01-01T00:00:00Z",
        jobs_observed_at: null,
        lock: null,
        trials: [],
        jobs: [],
      };
    }
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.clock.install();
  await page.goto("/runs");
  const table = page.getByRole("table");
  const role = page.getByRole("combobox", { name: "Run role", exact: true });
  const search = page.getByLabel("Search runs", { exact: true });
  await expect(role).toHaveValue("all");
  await expect(table.getByText(/recipe-one/)).toBeVisible();
  await expect(table.getByText(/recipe-two/)).toBeVisible();
  await expect(table.getByText(/plugin:CommandAgent/)).toBeVisible();
  await expect(table.getByText(/recipe-one/)).toHaveAttribute(
    "title",
    "Native agent: plugin:CommandAgent",
  );
  await expect(page.getByRole("link", { name: "New Workbench run" })).toHaveAttribute(
    "href",
    "/workbench",
  );
  await role.selectOption("final");
  await expect(page).toHaveURL(/role=final/);
  await expect(table.getByRole("link", { name: /model-two/ })).toBeVisible();
  await expect(table.getByRole("link", { name: /model-one/ })).toHaveCount(0);
  await expect(table.getByText("Final", { exact: true })).toBeVisible();
  await role.selectOption("diagnostic");
  await search.fill("RECIPE-ONE");
  await expect(page).toHaveURL(/role=diagnostic&q=RECIPE-ONE/);
  await expect(table.getByRole("link", { name: /historical-model/ })).toHaveCount(0);
  await expect(table.getByRole("link", { name: /model-one/ })).toBeVisible();
  const previousRequests = listRequests;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => listRequests).toBeGreaterThan(previousRequests);
  await expect(search).toHaveValue("RECIPE-ONE");
  const beforePolling = listRequests;
  await page.clock.fastForward(10_001);
  await expect.poll(() => listRequests).toBeGreaterThan(beforePolling);
  await expect(role).toHaveValue("diagnostic");
  await expect(search).toHaveValue("RECIPE-ONE");
  await expect(table.getByRole("link", { name: /historical-model/ })).toHaveCount(0);
  await page.reload();
  await expect(role).toHaveValue("diagnostic");
  await expect(search).toHaveValue("RECIPE-ONE");
  await expect(table.getByRole("link", { name: /model-one/ })).toBeVisible();
  expect(progressRequests).toEqual([]);
  await table.getByRole("link", { name: /model-one/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runs[0]?.record.run_id}$`));
  await page.goBack();
  await expect(role).toHaveValue("diagnostic");
  await expect(search).toHaveValue("RECIPE-ONE");
  await search.fill("not-found");
  await expect(page.getByText("No runs match these filters")).toBeVisible();
  await search.fill("000000000000000000000003");
  await expect(table.getByRole("link", { name: /historical-model/ })).toBeVisible();
  await search.fill("SYNTHETIC-BENCHMARK");
  await role.selectOption("all");
  await expect(table.getByRole("link", { name: /model-two/ })).toBeVisible();
  expect(writes).toEqual([]);
});
