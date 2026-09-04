import { expect, type Page, type Route, test } from "@playwright/test";

const runId = "run-0123456789abcdef01234567";
const trialName = "task-one__trial-one";
const setupId = "workbench-setup-0123456789abcdef01234567";

const system = {
  source_revision: "source-revision",
  harbor_revision: "harbor-revision",
  write_mode: "enabled",
  ready: true,
  projection: { runs: 1, trials: 1, parent_jobs: 1 },
  capacity: { max_active_parent_jobs: 16 },
  workbench: { runner: "hf-jobs", setup_enabled: true },
  resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
};

const presets = {
  benchmarks: [
    {
      schema_version: "v1",
      benchmark: "terminal-bench-2-1",
      preset: "one-task-1-trial",
      leaderboard_eligible: true,
    },
  ],
  agents: [
    {
      schema_version: "v1",
      agent: "pi",
      version: "0.84.4",
      reasoning_option: "reasoning_effort",
      reasoning_values: ["off"],
    },
  ],
};

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
    cost_ceiling_usd_per_trial: 0.25,
  },
  harbor_job_config: { job_name: "job", n_attempts: 1 },
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
  status: "running",
  result: {
    n_total_trials: 1,
    stats: {
      n_completed_trials: 1,
      n_errored_trials: 0,
      n_cancelled_trials: 0,
      n_retries: 0,
      n_pending_trials: 0,
      n_running_trials: 0,
      n_input_tokens: 120,
      n_output_tokens: 40,
      n_cache_tokens: 10,
      cost_usd: 0.12,
      evals: { reward: { metrics: [{ mean: 1 }] } },
    },
  },
};

const trialSummary = {
  run_id: runId,
  trial_name: trialName,
  reward: 1,
  cost_usd: 0.12,
  status: "completed",
};

const trial = {
  ...trialSummary,
  result: {
    task_name: "task-one",
    started_at: "2026-01-01T00:00:01Z",
    finished_at: "2026-01-01T00:00:05Z",
    verifier_environment_mode: "strict",
    verifier_result: { reward: 1 },
    agent_result: { n_input_tokens: 120, n_output_tokens: 40 },
    trajectory: "assistant completed the task",
  },
};

const job = {
  id: "job-parent-one",
  run_id: runId,
  role: "parent",
  stage: "running",
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:01Z",
  finished_at: null,
};

const leaderboard = {
  rows: [
    {
      benchmark: "terminal-bench-2-1",
      preset: "one-task-1-trial",
      agent: "pi",
      agent_version: "0.84.4",
      model: "publisher/model",
      provider: "provider",
      reasoning_effort: "off",
      n_attempts: 1,
      n_trials: 1,
      pass_rate: 1,
      cost_usd: 0.12,
    },
  ],
};

interface MockOptions {
  authenticated?: boolean;
  setupStatus?: "running" | "passed" | "failed";
  runStatus?: "queued" | "running" | "paused";
  runPostError?: boolean;
  onRunPost?(payload: unknown): void;
  onAction?(action: string): void;
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

async function mockControl(page: Page, options: MockOptions = {}) {
  const authenticated = options.authenticated ?? true;
  const currentRun = { ...run, status: options.runStatus ?? run.status };
  let setupStatus = options.setupStatus ?? "passed";
  await page.route("**/auth/login**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "sign in" }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/v1/session")
      return json(
        route,
        authenticated
          ? {
              authenticated: true,
              actor: {
                username: "test-operator",
                role: "operator",
                transport: "development",
              },
            }
          : { authenticated: false, login_url: "/auth/login" },
      );
    if (path === "/api/v1/leaderboard") return json(route, leaderboard);
    if (path === "/api/v1/system") return json(route, system);
    if (path === "/api/v1/presets") return json(route, presets);
    if (path === "/api/v1/jobs") return json(route, { jobs: [job] });
    if (path === "/api/v1/runs" && method === "GET")
      return json(route, { runs: [currentRun] });
    if (path === "/api/v1/runs" && method === "POST") {
      options.onRunPost?.(request.postDataJSON());
      if (options.runPostError)
        return json(
          route,
          { error: { code: "submission_rejected", message: "submission rejected" } },
          500,
        );
      return json(route, { created: true, run: record }, 201);
    }
    if (path === `/api/v1/runs/${runId}`) return json(route, currentRun);
    if (path === `/api/v1/runs/${runId}/trials`)
      return json(route, { trials: [trialSummary] });
    if (path === `/api/v1/runs/${runId}/trials/${trialName}`) return json(route, trial);
    const action = path.match(
      new RegExp(`^/api/v1/runs/${runId}/(pause|resume|cancel)$`),
    );
    if (action) {
      options.onAction?.(action[1] ?? "");
      return json(route, state);
    }
    if (path === "/api/v1/workbench/preview" && method === "POST") {
      const recipe = request.postDataJSON();
      const recipeDigest =
        recipe.name === "fast-agent" ? "a".repeat(64) : "b".repeat(64);
      return json(route, {
        recipe,
        recipe_digest: recipeDigest,
        revision_id: "agent-recipe-0123456789abcdef01234567",
        setup_command: recipe.setup_command,
        run_command: recipe.run_command,
        environment: recipe.environment.map(
          (item: { name: string; source: string; value?: string }) => ({
            ...item,
            value: item.value ?? `<${item.source}>`,
            redacted: item.source === "model_api_key",
          }),
        ),
        harbor_agent: {
          import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
          override_setup_timeout_sec: recipe.setup_timeout_seconds,
          kwargs: { config: { schema_version: "v1" } },
        },
        warnings: [],
      });
    }
    if (path === "/api/v1/workbench/setup-tests" && method === "GET")
      return json(route, { setups: [] });
    if (path === "/api/v1/workbench/setup-tests" && method === "POST")
      return json(
        route,
        {
          setup_test_id: setupId,
          recipe_digest: "a".repeat(64),
          revision_id: "agent-recipe-0123456789abcdef01234567",
          status: setupStatus,
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:00:01Z",
          completed_at: setupStatus === "running" ? null : "2026-01-01T00:00:02Z",
          exit_code: setupStatus === "passed" ? 0 : setupStatus === "failed" ? 1 : null,
          error: setupStatus === "failed" ? "setup failed safely" : null,
          files: [],
        },
        202,
      );
    if (path === `/api/v1/workbench/setup-tests/${setupId}/cancel`) {
      setupStatus = "failed";
      return json(route, {
        setup_test_id: setupId,
        recipe_digest: "a".repeat(64),
        revision_id: "agent-recipe-0123456789abcdef01234567",
        status: "cancelled",
        created_at: "2026-01-01T00:00:00Z",
        started_at: "2026-01-01T00:00:01Z",
        completed_at: "2026-01-01T00:00:02Z",
        exit_code: null,
        error: null,
        files: [],
      });
    }
    if (path === `/api/v1/workbench/setup-tests/${setupId}/logs`)
      return json(route, { stdout: "setup ready\n", stderr: "" });
    if (path === `/api/v1/workbench/setup-tests/${setupId}`)
      return json(route, {
        setup_test_id: setupId,
        recipe_digest: "a".repeat(64),
        revision_id: "agent-recipe-0123456789abcdef01234567",
        status: setupStatus,
        created_at: "2026-01-01T00:00:00Z",
        started_at: "2026-01-01T00:00:01Z",
        completed_at: setupStatus === "running" ? null : "2026-01-01T00:00:02Z",
        exit_code: setupStatus === "passed" ? 0 : setupStatus === "failed" ? 1 : null,
        error: setupStatus === "failed" ? "setup failed safely" : null,
        files: [],
      });
    throw new Error(`Unhandled mock request: ${method} ${path}`);
  });
}

test("shows the public leaderboard and starts sign-in from a private route", async ({
  page,
}) => {
  await mockControl(page, { authenticated: false });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(page.getByText("publisher/model", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/auth/login?return_to=%2F",
  );
  await expect(page.getByRole("link", { name: "Workbench" })).toHaveCount(0);

  await page.goto("/overview");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/auth/login");
  expect(new URL(page.url()).searchParams.get("return_to")).toBe("/overview");
});

test("shows the restored overview on desktop and mobile", async ({
  page,
}, testInfo) => {
  await mockControl(page);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Maximum active parent Jobs")).toBeVisible();
  await expect(page.getByRole("link", { name: "Workbench" }).first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-mobile.png"),
    fullPage: true,
  });
});

test("validates and submits the overview form without losing selected values", async ({
  page,
}) => {
  let submitted: unknown = null;
  await mockControl(page, { onRunPost: (payload) => (submitted = payload) });
  await page.goto("/overview");
  await expect(page.getByRole("button", { name: "Submit run" })).toBeVisible();
  await page.getByLabel("Model").fill("publisher/new-model");
  await page.getByLabel("Provider").fill("provider");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByRole("link", { name: "Open it" })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
  expect(submitted).toMatchObject({
    model: { id: "publisher/new-model", provider: "provider" },
    harness: { agent: "pi", version: "0.84.4" },
  });
  await expect(page.getByLabel("Model")).toHaveValue("publisher/new-model");
});

test("retains overview values after a failed submission", async ({ page }) => {
  await mockControl(page, { runPostError: true });
  await page.goto("/overview");
  await page.getByLabel("Model").fill("publisher/retry-model");
  await page.getByLabel("Provider").fill("retry-provider");
  await page.getByLabel("Cost limit per trial").fill("0.75");
  await page.getByLabel("Result role").selectOption("final");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByRole("alert")).toContainText("submission rejected");
  await expect(page.getByLabel("Model")).toHaveValue("publisher/retry-model");
  await expect(page.getByLabel("Provider")).toHaveValue("retry-provider");
  await expect(page.getByLabel("Cost limit per trial")).toHaveValue("0.75");
  await expect(page.getByLabel("Result role")).toHaveValue("final");
});

test("navigates from runs to complete run and trial evidence", async ({ page }) => {
  await mockControl(page);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await page.locator(`a[href="/runs/${runId}"]`).click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.getByText("Harbor totals")).toBeVisible();
  await expect(page.getByText("job-parent-one")).toBeVisible();
  await page.getByRole("link", { name: trialName }).click();
  await expect(page.getByRole("heading", { name: "Trial detail" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verifier result" })).toBeVisible();
  await expect(
    page.getByText("assistant completed the task", { exact: true }),
  ).toBeVisible();
});

test("targets pause and cancel at the open run", async ({ page }) => {
  const actions: string[] = [];
  await mockControl(page, { onAction: (action) => actions.push(action) });
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => actions).toContain("pause");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => actions).toContain("cancel");
});

test("resumes the open paused run", async ({ page }) => {
  const actions: string[] = [];
  await mockControl(page, {
    runStatus: "paused",
    onAction: (action) => actions.push(action),
  });
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => actions).toContain("resume");
});

test("shows parent Jobs with links to their runs", async ({ page }) => {
  await mockControl(page);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Parent Jobs" })).toBeVisible();
  await expect(page.getByText("job-parent-one")).toBeVisible();
  await expect(page.getByRole("link", { name: runId })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
});

test("completes Workbench configure, setup, and normal Run submission", async ({
  page,
}) => {
  let submitted: unknown = null;
  await mockControl(page, { onRunPost: (payload) => (submitted = payload) });
  await page.goto("/workbench");
  await expect(page.getByRole("heading", { name: "Agent Workbench" })).toBeVisible();
  await expect(page.getByText("Configure → Test → Run")).toBeVisible();
  await expect(page.getByText(/agent-recipe-/).first()).toBeVisible();
  await page
    .getByLabel("Start one disposable CPU setup test for this exact recipe.")
    .check();
  await page.getByRole("button", { name: "Run setup test" }).click();
  await expect(page.getByText("Setup passed")).toBeVisible();
  await expect(page.getByText("setup ready")).toBeVisible();
  await page.getByLabel("Model").last().fill("publisher/workbench-model");
  await page.getByLabel("Provider").last().fill("provider");
  await page
    .getByLabel(
      "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
    )
    .check();
  await page.getByRole("button", { name: "Launch Harbor run" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({
    model: {
      id: "publisher/workbench-model",
      provider: "provider",
      reasoning_effort: "off",
    },
    workbench: { setup_test_id: setupId },
  });
});

test("invalidates Workbench launch approval after a recipe edit", async ({ page }) => {
  await mockControl(page);
  await page.goto("/workbench");
  await page
    .getByLabel("Start one disposable CPU setup test for this exact recipe.")
    .check();
  await page.getByRole("button", { name: "Run setup test" }).click();
  await expect(page.getByText("Setup passed")).toBeVisible();
  await page.getByLabel("Model").last().fill("publisher/workbench-model");
  await page.getByLabel("Provider").last().fill("provider");
  await page
    .getByLabel(
      "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
    )
    .check();
  await expect(page.getByRole("button", { name: "Launch Harbor run" })).toBeEnabled();

  await page.getByLabel("Recipe name").fill("edited-agent");
  await expect(page.getByRole("button", { name: "Launch Harbor run" })).toBeDisabled();
});

test("shows Workbench setup failure without enabling Run launch", async ({ page }) => {
  await mockControl(page, { setupStatus: "failed" });
  await page.goto("/workbench");
  await page
    .getByLabel("Start one disposable CPU setup test for this exact recipe.")
    .check();
  await page.getByRole("button", { name: "Run setup test" }).click();
  await expect(page.getByText("setup failed safely")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch Harbor run" })).toBeDisabled();
});

test("cancels only the active Workbench setup", async ({ page }) => {
  await mockControl(page, { setupStatus: "running" });
  await page.goto("/workbench");
  await page
    .getByLabel("Start one disposable CPU setup test for this exact recipe.")
    .check();
  await page.getByRole("button", { name: "Run setup test" }).click();
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(page.getByText("cancelled")).toBeVisible();
});

test("keeps direct authenticated route refreshes in the restored shell", async ({
  page,
}) => {
  await mockControl(page);
  await page.goto(`/runs/${runId}/trials/${trialName}`);
  await expect(page.getByRole("heading", { name: "Trial detail" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workbench" }).first()).toBeVisible();
});
