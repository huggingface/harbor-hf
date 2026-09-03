import { expect, test, type Page } from "@playwright/test";

const leaderboard = {
  rows: [
    {
      benchmark: "terminal-bench-2-1",
      preset: "all-tasks-5-trials",
      agent: "pi",
      agent_version: "0.84.2",
      model: "openai/gpt-oss-20b",
      provider: "together",
      reasoning_effort: "off",
      n_attempts: 5,
      n_trials: 445,
      pass_rate: 0.618,
    },
  ],
};

async function routeGuest(page: Page) {
  await page.route("**/api/v1/leaderboard", (route) =>
    route.fulfill({ json: leaderboard }),
  );
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthorized", message: "sign in is required" } },
    }),
  );
}

async function routeOperator(page: Page) {
  await page.route("**/api/v1/leaderboard", (route) =>
    route.fulfill({ json: leaderboard }),
  );
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        actor: { username: "test-user", role: "operator", transport: "session" },
      },
    }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({
      json: {
        source_revision: "test-revision",
        harbor_revision: "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e",
        write_mode: "enabled",
        ready: true,
        projection: { runs: 1, trials: 0, parent_jobs: 1 },
        capacity: { max_active_parent_jobs: 16 },
      },
    }),
  );
  await page.route("**/api/v1/presets", (route) =>
    route.fulfill({
      json: {
        benchmarks: [
          {
            schema_version: "v1",
            benchmark: "terminal-bench-2-1",
            preset: "one-task-1-trial",
            leaderboard_eligible: false,
          },
        ],
        agents: [
          {
            schema_version: "v1",
            agent: "pi",
            version: "0.84.4",
            reasoning_option: "thinking",
            reasoning_values: ["off", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/jobs", (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: "job-123",
            run_id: "run-0123456789abcdef01234567",
            stage: "running",
            created_at: "2026-09-04T00:00:00.000Z",
            started_at: "2026-09-04T00:00:02.000Z",
            finished_at: null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { created: true, run: { run_id: "run-fedcba9876543210fedcba98" } },
      });
      return;
    }
    await route.fulfill({
      json: {
        runs: [
          {
            record: {
              run_id: "run-0123456789abcdef01234567",
              created_at: "2026-09-04T00:00:00.000Z",
              role: "diagnostic",
              submission: {
                benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
                model: {
                  id: "openai/gpt-oss-20b",
                  provider: "together",
                  reasoning_effort: "off",
                },
                harness: { agent: "pi", version: "0.84.4" },
                cost_ceiling_usd_per_trial: 0.25,
              },
            },
            state: { desired_state: "run" },
            status: "running",
          },
        ],
      },
    });
  });
}

test("shows the public leaderboard without a session", async ({ page }) => {
  await routeGuest(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(page.getByText("61.8%")).toBeVisible();
  await expect(page.getByText("Run control is private")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute(
    "href",
    "/auth/login",
  );
});

test("submits a run from the four-group operator form", async ({ page }) => {
  await routeOperator(page);
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      json: { created: true, run: { run_id: "run-fedcba9876543210fedcba98" } },
    });
  });

  await page.goto("/");
  for (const legend of ["1. Benchmark", "2. Model", "3. Harness", "4. Run limits"])
    await expect(page.getByText(legend, { exact: true })).toBeVisible();
  await page.getByLabel("Reasoning").selectOption("high");
  await page.getByLabel("Maximum USD per trial").fill("0.5");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Submitted run-fedcba9876543210fedcba98",
  );
  expect(submitted).toMatchObject({
    model: { reasoning_effort: "high" },
    cost_ceiling_usd_per_trial: 0.5,
    role: "diagnostic",
  });
});

test("shows runs and sends a pause action", async ({ page }) => {
  await routeOperator(page);
  let paused = false;
  await page.route("**/api/v1/runs/run-0123456789abcdef01234567/pause", (route) => {
    paused = true;
    return route.fulfill({ json: { desired_state: "paused" } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Parent Jobs" })).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => paused).toBe(true);
});
