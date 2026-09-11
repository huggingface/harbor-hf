import { expect, test, type BrowserContext } from "@playwright/test";
import type { LaunchPricingV1, PricingCorrectionRequestV1 } from "@harbor-hf/contracts";
import type { RunView } from "../src/api";
import { launchEstimate } from "@harbor-hf/contracts/pricing";

const id = "run-0123456789abcdef01234567";
const launch: LaunchPricingV1 = {
  currency: "USD",
  input_usd_per_million: 2,
  output_usd_per_million: 0.5,
  cached_usd_per_million: 8,
};
function fixture(unpriced = false) {
  const run: RunView = {
    record: {
      schema_version: "v1",
      run_id: id,
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: "fixture-actor",
      role: "final",
      harbor_revision: "d".repeat(40),
      ...(unpriced ? {} : { pricing: launch }),
      submission: {
        benchmark: { name: "fixture-benchmark", preset: "fixture-preset" },
        model: { id: "publisher/model", provider: "provider", reasoning_effort: "off" },
        harness: { agent: "fixture-agent", version: "1" },
        cost_ceiling_usd: 100,
      },
      harbor_job_config: { n_attempts: 1, agents: [{ name: "fixture-agent" }] },
    },
    state: {
      schema_version: "v1",
      run_id: id,
      revision: 0,
      updated_at: "2026-01-01T00:00:00Z",
      actor: "fixture-actor",
      desired_state: "run",
      parent_jobs: [],
    },
    status: "finished",
    result: {
      stats: {
        n_input_tokens: 1000000,
        n_output_tokens: 100000,
        n_cache_tokens: 250000,
        cost_usd: 77,
      },
    },
    pricing_corrections: null,
    pricing_corrections_available: true,
  };
  const mutations: PricingCorrectionRequestV1[] = [];
  let reject = false;
  const estimate = () => ({
    ...launchEstimate(
      run.pricing_corrections?.revisions.at(-1)?.pricing ?? run.record.pricing,
      run.result,
    ),
    basis: run.pricing_corrections
      ? "corrected_rates_reported_usage"
      : "launch_rates_reported_usage",
  });
  return {
    run,
    mutations,
    fail() {
      reject = true;
    },
    async install(context: BrowserContext, role = "operator") {
      await context.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const json = (body: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        if (request.method() === "PATCH" && path.endsWith("/pricing-corrections")) {
          const body = request.postDataJSON() as PricingCorrectionRequestV1;
          mutations.push(body);
          if (
            reject ||
            body.expected_revision !== (run.pricing_corrections?.revisions.length ?? 0)
          )
            return json(
              {
                error: { code: "pricing_conflict", message: "Review current history" },
              },
              409,
            );
          run.pricing_corrections = {
            schema_version: "v1",
            run_id: id,
            revisions: [
              ...(run.pricing_corrections?.revisions ?? []),
              {
                revision: body.expected_revision + 1,
                actor: "fixture-editor",
                updated_at: "2026-01-02T00:00:00Z",
                reason: body.reason,
                pricing: body.pricing,
              },
            ],
          };
          return json(run.pricing_corrections);
        }
        if (request.method() !== "GET")
          throw new Error("Unexpected execution side effect");
        if (path.endsWith("/session"))
          return json({
            authenticated: true,
            actor: { username: "fixture-user", role, transport: "session" },
          });
        if (path.endsWith("/system"))
          return json({
            ready: true,
            write_mode: "enabled",
            source_revision: "fixture",
            harbor_revision: "fixture",
            projection: { runs: 1, trials: 0, parent_jobs: 0 },
            capacity: { max_active_parent_jobs: 1 },
            workbench: { runner: "disabled", setup_enabled: false },
            resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
          });
        if (path === "/api/v1/runs")
          return json({ runs: [{ ...run, shared_estimate: estimate() }] });
        if (path === `/api/v1/runs/${id}`)
          return json({ ...run, shared_estimate: estimate() });
        if (path.endsWith("/leaderboard"))
          return json({
            rows: [
              {
                benchmark: "fixture-benchmark",
                preset: "fixture-preset",
                agent: "fixture-agent",
                agent_version: "1",
                model: "publisher/model",
                provider: "provider",
                reasoning_effort: "off",
                n_attempts: 1,
                n_trials: 1,
                pass_rate: 1,
                cost_usd: 77,
                shared_estimate: {
                  basis: run.pricing_corrections
                    ? "effective_rates_reported_usage"
                    : "launch_rates_reported_usage",
                  cost_usd: estimate().cost_usd,
                  estimated_runs: estimate().cost_usd === null ? 0 : 1,
                  total_runs: 1,
                },
              },
            ],
          });
        if (path.endsWith("/trials")) return json({ trials: [] });
        if (path.endsWith("/progress"))
          return json({
            observed_at: new Date().toISOString(),
            jobs_observed_at: null,
            lock: null,
            trials: [],
            jobs: [],
          });
        if (path.endsWith("/presets")) return json({ benchmarks: [], agents: [] });
        if (path.endsWith("/jobs")) return json({ jobs: [] });
        return json({}, 404);
      });
    },
  };
}

test("swapped output/cache correction is confirmed, audited and shared across detail, Runs and leaderboard", async ({
  page,
  context,
  browser,
}) => {
  const state = fixture();
  await state.install(context);
  const reader = await browser.newContext();
  await state.install(reader, "reader");
  const other = await reader.newPage();
  await other.clock.install();
  await other.goto(`/runs/${id}`);
  await expect(other.getByRole("button", { name: "Correct shared rates" })).toHaveCount(
    0,
  );
  await page.goto(`/runs/${id}`);
  await page.getByRole("button", { name: "Correct shared rates" }).click();
  await page.getByLabel("Correction output USD/M").fill("8");
  await page.getByLabel("Correction cached USD/M").fill("0.5");
  await expect(
    page.getByRole("button", { name: "Save audited correction" }),
  ).toBeDisabled();
  await page
    .getByLabel("Correction reason")
    .fill("Output and cache rates were transposed");
  await page
    .getByRole("checkbox", {
      name: "I confirm these shared rates and the audit reason.",
    })
    .check();
  await page.getByRole("button", { name: "Save audited correction" }).click();
  await expect(
    page.getByLabel("Corrected estimate (USD): 2.425", { exact: true }),
  ).toBeVisible();
  await page.getByText("Shared estimate rates · corrected", { exact: true }).click();
  await expect(
    page.getByText(/Original launch: USD\/M: input 2, cached 8, output 0.5/),
  ).toBeVisible();
  await expect(
    page.getByText(/Reason: Output and cache rates were transposed/),
  ).toBeVisible();
  await other.bringToFront();
  await other.clock.runFor(30_001);
  await expect(
    other.getByLabel("Corrected estimate (USD): 2.425", { exact: true }),
  ).toBeVisible();
  await page.goto("/runs");
  await expect(
    page.getByLabel("Corrected estimate (USD): 2.425", { exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByLabel("Shared effective estimate (USD): 2.425", { exact: true }),
  ).toBeVisible();
  expect(state.mutations).toHaveLength(1);
  expect(state.run.record.pricing).toEqual(launch);
  await reader.close();
});

test("historical unpriced runs require all rates; conflict blocks automatic resubmission", async ({
  page,
  context,
}) => {
  const state = fixture(true);
  await state.install(context);
  await page.goto(`/runs/${id}`);
  await page
    .getByRole("button", { name: "Add shared rates (unpriced launch)" })
    .click();
  await page.getByLabel("Correction input USD/M").fill("0");
  await page.getByLabel("Correction output USD/M").fill("8");
  await page.getByLabel("Correction reason").fill("Add historical rates");
  await page
    .getByRole("checkbox", {
      name: "I confirm these shared rates and the audit reason.",
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Save audited correction" }),
  ).toBeDisabled();
  await page.getByLabel("Correction cached USD/M").fill("0.5");
  await page
    .getByRole("checkbox", {
      name: "I confirm these shared rates and the audit reason.",
    })
    .check();
  state.fail();
  await page.getByRole("button", { name: "Save audited correction" }).click();
  await expect(
    page.getByText(/Review refreshed history before trying again/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save audited correction" }),
  ).toBeDisabled();
  expect(state.mutations).toHaveLength(1);
  expect(state.run.record).not.toHaveProperty("pricing");
});
