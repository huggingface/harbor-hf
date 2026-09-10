import { expect, type Page, test } from "@playwright/test";

const runId = "run-0123456789abcdef01234567";
const pricingKey = "harbor-hf.browser-pricing.v1";
const record = {
  schema_version: "v1",
  run_id: runId,
  created_at: "2026-01-01T00:00:00Z",
  submitted_by: "test-operator",
  role: "diagnostic",
  harbor_revision: "harbor-revision",
  submission: {
    benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
    model: { id: "publisher/model", provider: "provider", reasoning_effort: "off" },
    harness: { agent: "pi", version: "0.84.4" },
    cost_ceiling_usd: 0.25,
  },
  harbor_job_config: {
    job_name: "job",
    n_attempts: 1,
    agents: [
      {
        name: "pi",
        model_name: "huggingface/publisher/model:provider",
        kwargs: { version: "0.84.4" },
      },
    ],
  },
};

const state = {
  schema_version: "v1",
  run_id: runId,
  revision: 1,
  updated_at: "2026-01-01T00:00:02Z",
  desired_state: "run",
  actor: "test-operator",
  parent_jobs: [{ id: "job-parent-one", started_at: "2026-01-01T00:00:01Z" }],
};

const run = {
  record,
  state,
  status: "completed",
  result: {
    n_total_trials: 1,
    stats: {
      n_completed_trials: 1,
      n_errored_trials: 0,
      n_cancelled_trials: 0,
      n_retries: 0,
      n_pending_trials: 0,
      n_running_trials: 0,
      n_input_tokens: 1000000,
      n_output_tokens: 100000,
      n_cache_tokens: 250000,
      cost_usd: 77,
      evals: { reward: { metrics: [{ mean: 1 }] } },
    },
  },
};

async function mockPricing(page: Page, writes: string[]) {
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      writes.push(request.method());
  });
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
        workbench: { runner: "hf-jobs", setup_enabled: false },
        source_revision: "synthetic-source",
        harbor_revision: "synthetic-harbor",
        write_mode: "disabled",
        ready: true,
        projection: { runs: 1, trials: 0, parent_jobs: 0 },
        capacity: { max_active_parent_jobs: 16 },
        resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
      },
      "/api/v1/runs": { runs: [run] },
      "/api/v1/jobs": { jobs: [] },
      [`/api/v1/runs/${runId}`]: run,
      [`/api/v1/runs/${runId}/trials`]: { trials: [] },
      [`/api/v1/runs/${runId}/progress`]: {
        observed_at: "2026-01-01T00:00:03Z",
        jobs_observed_at: null,
        lock: null,
        trials: [],
        jobs: [],
      },
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(responses[path] ?? {}),
    });
  });
}
async function openEditor(page: Page) {
  await page.getByText("Pricing scenarios · editable USD / million tokens").click();
}
async function save(page: Page, name: string) {
  await page.getByLabel("Scenario name", { exact: true }).fill(name);
  for (const [label, rate] of [
    ["Standard input", "2"],
    ["Standard output", "8"],
    ["Standard cached", "0.5"],
    ["Long-context input", "4"],
    ["Long-context output", "16"],
    ["Long-context cached", "1"],
  ]) {
    await page.getByLabel(`${label} (USD/M)`, { exact: true }).fill(rate ?? "");
  }
  await page.getByRole("button", { name: "Save & Use", exact: true }).click();
  await expect(page.getByRole("option", { name, exact: true })).toBeAttached();
  await expect(page.getByLabel("Scenario name", { exact: true })).toBeEnabled();
}

test("browser-only pricing CRUD, reload, route drafts and list estimates", async ({
  page,
}) => {
  const writes: string[] = [];
  await mockPricing(page, writes);
  await page.goto(`/runs/${runId}`);
  await openEditor(page);
  await save(page, "First");
  await expect(
    page.getByLabel("Scenario estimate USD: 2.425", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Standard input (USD/M)", { exact: true }).fill("20");
  await page.getByLabel("Scenario name", { exact: true }).fill("Renamed with rates");
  await page.getByRole("button", { name: "Save & Use", exact: true }).click();
  await expect(
    page.getByLabel("Scenario estimate USD: 15.925", { exact: true }),
  ).toBeVisible();
  const first = await page.getByLabel("Saved scenario", { exact: true }).inputValue();
  await page.getByRole("button", { name: "New scenario", exact: true }).click();
  await save(page, "Second");
  await page.getByLabel("Saved scenario", { exact: true }).selectOption(first);
  await page.getByLabel("Scenario tier", { exact: true }).selectOption("longContext");
  await page.reload();
  await expect(page.getByLabel("Saved scenario", { exact: true })).toHaveValue(first);
  await expect(page.getByLabel("Scenario tier", { exact: true })).toHaveValue(
    "longContext",
  );
  await expect(
    page.getByLabel("Scenario estimate USD: 4.85", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Scenario estimate", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Scenario estimate USD: 4.85", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reported cost", exact: true }),
  ).toBeVisible();
  await page.locator(`a[href="/runs/${runId}"]`).click();
  await openEditor(page);
  await page.getByRole("button", { name: "Delete scenario", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Renamed with rates", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Scenario name", { exact: true }).fill("Unsaved name");
  await page.getByLabel("Standard input (USD/M)", { exact: true }).fill("17");
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator(`a[href="/runs/${runId}"]`).click();
  await openEditor(page);
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "Unsaved name",
  );
  await expect(page.getByLabel("Standard input (USD/M)", { exact: true })).toHaveValue(
    "17",
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), pricingKey),
  ).not.toContain("Unsaved name");
  await page.getByRole("button", { name: "Clear saved pricing", exact: true }).click();
  await expect(
    page.getByLabel("Saved scenario", { exact: true }).locator("option"),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Saved scenario", { exact: true })).toHaveValue("");
  expect(writes).toEqual([]);
});

test("native cross-tab sync preserves dirty drafts and reports conflicts", async ({
  page,
  context,
}) => {
  const writes: string[] = [];
  await mockPricing(page, writes);
  await page.goto(`/runs/${runId}`);
  await openEditor(page);
  await save(page, "Shared");
  const other = await context.newPage();
  await mockPricing(other, writes);
  await other.goto(`/runs/${runId}`);
  await openEditor(other);
  await expect(other.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "Shared",
  );
  await other.getByLabel("Standard input (USD/M)", { exact: true }).fill("99");
  await page.getByLabel("Scenario name", { exact: true }).fill("Renamed externally");
  await page.getByRole("button", { name: "Save & Use", exact: true }).click();
  await expect(other.getByRole("alert")).toContainText("Your draft is retained");
  await expect(other.getByLabel("Standard input (USD/M)", { exact: true })).toHaveValue(
    "99",
  );
  await expect(
    other.getByRole("button", { name: "Save & Use", exact: true }),
  ).toBeDisabled();
  await other.getByRole("button", { name: "Reload saved values", exact: true }).click();
  await expect(other.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "Renamed externally",
  );
  await expect(other.getByLabel("Standard input (USD/M)", { exact: true })).toHaveValue(
    "2",
  );
  await page.getByRole("button", { name: "Clear saved pricing", exact: true }).click();
  await expect(other.getByLabel("Saved scenario", { exact: true })).toHaveValue("");
  await expect(
    other.getByLabel("Scenario estimate USD: unavailable", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("pricing renders and saves with CSP forbidding dynamic compilation", async ({
  page,
}) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockPricing(page, writes);
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        // Vite React refresh needs inline script; eval remains forbidden.
        "Content-Security-Policy":
          "script-src 'self' 'unsafe-inline'; object-src 'none'",
      },
    });
  });
  await page.goto(`/runs/${runId}`);
  await openEditor(page);
  await save(page, "CSP pricing");
  await expect(
    page.getByLabel("Scenario estimate USD: 2.425", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openEditor(page);
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "CSP pricing",
  );
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
