import { expect, type BrowserContext, test } from "@playwright/test";
import type { LaunchPricingV1 } from "@harbor-hf/contracts";

const runId = "run-0123456789abcdef01234567";
const setupId = "setup-synthetic";
const revision = "agent-recipe-0123456789abcdef01234567";
const digest = "a".repeat(64);
const pricing: LaunchPricingV1 = {
  currency: "USD",
  input_usd_per_million: 2,
  cached_usd_per_million: 0.5,
  output_usd_per_million: 8,
};
const confirmation =
  "Launch this exact tested recipe and accept the displayed per-trial cost limit.";

function fixture() {
  let recordedPricing: LaunchPricingV1 | undefined;
  let submitted: Record<string, unknown> | undefined;
  let previews = 0;
  let setupRequests = 0;
  const record = () => ({
    schema_version: "v1",
    run_id: runId,
    created_at: "2026-01-01T00:00:00Z",
    submitted_by: "synthetic-actor",
    role: "final",
    harbor_revision: "d".repeat(40),
    submission: {
      benchmark: { name: "example-benchmark", preset: "all-tasks" },
      model: { id: "publisher/model", provider: "provider", reasoning_effort: "off" },
      harness: { agent: "command-agent", version: revision },
      cost_ceiling_usd_per_trial: 100,
    },
    harbor_job_config: { n_attempts: 1 },
    ...(recordedPricing ? { pricing: recordedPricing } : {}),
  });
  const run = () => ({
    record: record(),
    state: {
      schema_version: "v1",
      run_id: runId,
      revision: 0,
      updated_at: "2026-01-01T00:00:00Z",
      desired_state: "run",
      actor: "synthetic-actor",
      parent_jobs: [],
    },
    status: "finished",
    result: {
      n_total_trials: 1,
      stats: {
        n_completed_trials: 1,
        n_input_tokens: 1_000_000,
        n_output_tokens: 100_000,
        n_cache_tokens: 250_000,
        cost_usd: 77,
      },
    },
    shared_estimate: {
      basis: "launch_rates_reported_usage",
      cost_usd: recordedPricing ? 2.425 : null,
      unavailable_reason: recordedPricing ? null : "pricing_unset",
    },
  });
  async function mock(context: BrowserContext) {
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (path === "/api/v1/workbench/preview") {
        previews++;
        const recipe = request.postDataJSON();
        return json({
          recipe,
          recipe_digest: digest,
          revision_id: revision,
          setup_command: recipe.setup_command,
          run_command: recipe.run_command,
          environment: [],
          harbor_agent: {
            import_path: "example.agent:Agent",
            override_setup_timeout_sec: 60,
            kwargs: {},
          },
          warnings: [],
        });
      }
      if (path === "/api/v1/workbench/setup-tests") {
        if (request.method() === "GET") return json({ setups: [] });
        setupRequests++;
        expect(request.postDataJSON()).not.toHaveProperty("pricing");
        return json(
          {
            setup_test_id: setupId,
            recipe_digest: digest,
            revision_id: revision,
            status: "passed",
            created_at: "2026-01-01T00:00:00Z",
            started_at: "2026-01-01T00:00:01Z",
            completed_at: "2026-01-01T00:00:02Z",
            exit_code: 0,
            error: null,
            files: [],
          },
          202,
        );
      }
      if (path === `/api/v1/workbench/setup-tests/${setupId}/logs`)
        return json({ stdout: "setup ready", stderr: "" });
      if (path === "/api/v1/runs" && request.method() === "POST") {
        submitted = request.postDataJSON() as Record<string, unknown>;
        recordedPricing = submitted.pricing as LaunchPricingV1 | undefined;
        return json({ created: true, run: record() }, 201);
      }
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
          source_revision: "synthetic",
          harbor_revision: "d".repeat(40),
          write_mode: "enabled",
          ready: true,
          projection: { runs: 1, trials: 0, parent_jobs: 0 },
          capacity: { max_active_parent_jobs: 1 },
          workbench: { runner: "hf-jobs", setup_enabled: true },
          resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
        },
        "/api/v1/presets": {
          benchmarks: [
            {
              schema_version: "v1",
              benchmark: "example-benchmark",
              preset: "all-tasks",
              leaderboard_eligible: true,
              job: { n_concurrent_trials: 1, n_attempts: 1 },
            },
          ],
          agents: [],
        },
        "/api/v1/runs": { runs: [run()] },
        [`/api/v1/runs/${runId}`]: run(),
        [`/api/v1/runs/${runId}/trials`]: { trials: [] },
        [`/api/v1/runs/${runId}/progress`]: {
          observed_at: "2026-01-01T00:00:02Z",
          jobs_observed_at: null,
          lock: null,
          trials: [],
          jobs: [],
        },
        "/api/v1/jobs": { jobs: [] },
        "/api/v1/leaderboard": {
          rows: [
            {
              benchmark: "example-benchmark",
              preset: "all-tasks",
              agent: "command-agent",
              agent_version: revision,
              model: "publisher/model",
              provider: "provider",
              reasoning_effort: "off",
              n_attempts: 1,
              n_trials: 3,
              pass_rate: 1,
              cost_usd: 77,
              shared_estimate: {
                basis: "launch_rates_reported_usage",
                cost_usd: recordedPricing ? 6.35 : null,
                estimated_runs: recordedPricing ? 2 : 0,
                total_runs: 3,
              },
            },
          ],
        },
      };
      if (!(path in responses))
        throw new Error(`Unexpected synthetic request: ${path}`);
      return json(responses[path]);
    });
    await context.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch();
      // Vite's refresh preamble needs inline script; dynamic evaluation is forbidden.
      return route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "Content-Security-Policy":
            "script-src 'self' 'unsafe-inline'; object-src 'none'",
        },
      });
    });
  }
  return {
    mock,
    submission: () => submitted,
    previews: () => previews,
    setups: () => setupRequests,
  };
}

for (const enabled of [true, false])
  test(`launch pricing ${enabled ? "recorded and shared" : "omitted by default"} under no-eval CSP`, async ({
    page,
    context,
    browser,
  }, testInfo) => {
    const shared = fixture();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await shared.mock(context);
    await page.goto("/workbench");
    await expect(page.getByLabel("Record launch pricing")).not.toBeChecked();
    if (enabled) {
      await page.getByLabel("Record launch pricing").check();
      await page.getByLabel("Input incl. cache USD/M").fill("2");
      await page.reload();
      await expect(page.getByLabel("Input incl. cache USD/M")).toHaveValue("2");
      await expect(page.getByLabel("Cached input USD/M")).toHaveValue("");
    }
    await expect(page.getByText(revision).first()).toBeVisible();
    await page
      .getByLabel("Start one disposable CPU setup test for this exact recipe.")
      .check();
    await page.getByRole("button", { name: "Run setup test" }).click();
    await expect(page.getByText("Setup passed")).toBeVisible();
    await page.getByLabel("Recorded model", { exact: true }).fill("publisher/model");
    await page
      .getByLabel("Harness model string", { exact: true })
      .fill("provider/model");
    const previews = shared.previews();
    if (enabled) {
      await page.getByLabel(confirmation).check();
      await page.getByLabel("Cached input USD/M").fill("0.5");
      await page.getByLabel("Output USD/M").fill("8");
      await expect(page.getByLabel(confirmation)).not.toBeChecked();
      await expect(page.getByText("Setup passed")).toBeVisible();
      expect(shared.previews()).toBe(previews);
      expect(shared.setups()).toBe(1);
    }
    await page.getByLabel(confirmation).check();
    await page.getByRole("button", { name: "Launch Harbor run" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    if (enabled) expect(shared.submission()?.pricing).toEqual(pricing);
    else expect(shared.submission()).not.toHaveProperty("pricing");
    const estimate = page
      .getByRole("region", { name: "Run summary" })
      .getByLabel(/^Launch estimate \(USD\):/);
    if (enabled) await expect(estimate).toBeVisible();
    else await expect(estimate).toHaveCount(0);
    await expect(
      page.getByLabel("Reported cost (USD): 77", { exact: true }),
    ).toBeVisible();
    if (enabled) {
      const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      try {
        await shared.mock(other);
        const reader = await other.newPage();
        await reader.goto(`/runs/${runId}`);
        await expect(
          reader.getByLabel("Launch estimate (USD): 2.425", { exact: true }),
        ).toBeVisible();
        await reader.screenshot({
          path: "/tmp/launch-pricing-detail.png",
          fullPage: true,
        });
        await reader.goto("/runs");
        await expect(
          reader.getByRole("columnheader", { name: "Shared estimate" }),
        ).toBeVisible();
        await expect(
          reader.getByLabel("Launch estimate (USD): 2.425", { exact: true }),
        ).toBeVisible();
        await reader.goto("/");
        await expect(reader.getByText("2/3 runs · partial subtotal")).toBeVisible();
        await expect(
          reader.getByLabel("Launch estimate (USD): 6.35", { exact: true }),
        ).toBeVisible();
        await reader.screenshot({
          path: "/tmp/launch-pricing-leaderboard.png",
          fullPage: true,
        });
      } finally {
        await other.close();
      }
    }
    expect(errors).toEqual([]);
  });
