import { readFileSync } from "node:fs";
import type { BenchmarkPresetV1 } from "@harbor-hf/contracts";
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

const canaryPreset: BenchmarkPresetV1 = JSON.parse(
  readFileSync(
    new URL(
      "../../../presets/benchmarks/terminal-bench-2-1-three-tasks-3-trials.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const presets = {
  benchmarks: [
    {
      schema_version: "v1",
      benchmark: "terminal-bench-2-1",
      preset: "one-task-1-trial",
      leaderboard_eligible: true,
      job: {
        datasets: [{ repo: "https://example.test/tasks.git@revision", path: "tasks" }],
        n_attempts: 1,
        n_concurrent_trials: 1,
        environment: {
          type: "hf-sandbox",
          kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
        },
      },
    },
    canaryPreset,
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
    if (path === "/api/v1/hardware")
      return json(route, [
        {
          name: "cpu-basic",
          prettyName: "CPU Basic",
          cpu: "2 vCPU",
          ram: "16 GB",
          ephemeralStorage: "50 GB",
          accelerator: null,
          unitCostUSD: 0.000167,
          unitLabel: "minute",
        },
        {
          name: "cpu-upgrade",
          prettyName: "CPU Upgrade",
          cpu: "8 vCPU",
          ram: "32 GB",
          ephemeralStorage: "50 GB",
          accelerator: null,
          unitCostUSD: 0.0005,
          unitLabel: "minute",
        },
        {
          name: "a100-large",
          prettyName: "A100",
          cpu: "12 vCPU",
          ram: "142 GB",
          ephemeralStorage: "1000 GB",
          accelerator: { quantity: "1", model: "A100", vram: "80 GB" },
          unitCostUSD: 0.04,
          unitLabel: "minute",
        },
      ]);
    if (path === "/api/v1/model-providers")
      return json(route, {
        model: url.searchParams.get("model"),
        providers: ["provider", "retry-provider"],
      });
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
    if (path === `/api/v1/runs/${runId}/progress`)
      return json(route, {
        observed_at: new Date().toISOString(),
        jobs_observed_at: null,
        lock: null,
        trials: [],
        jobs: [],
      });
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

  await page.goto(`/runs/${runId}`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/auth/login");
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(`/runs/${runId}`);
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
  const model = page.getByRole("textbox", { name: "Model", exact: true });
  await model.fill("publisher/new-model");
  await model.blur();
  await page
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("provider");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByRole("link", { name: "Open it" })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
  expect(submitted).toMatchObject({
    model: { id: "publisher/new-model", provider: "provider" },
    harness: { agent: "pi", version: "0.84.4" },
  });
  await expect(model).toHaveValue("publisher/new-model");
});

test("retains overview values after a failed submission", async ({ page }) => {
  await mockControl(page, { runPostError: true });
  await page.goto("/overview");
  const model = page.getByRole("textbox", { name: "Model", exact: true });
  const provider = page.getByRole("combobox", {
    name: "Provider",
    exact: true,
  });
  await model.fill("publisher/retry-model");
  await model.blur();
  await provider.selectOption("retry-provider");
  await page.getByLabel("Cost limit per trial").fill("0.75");
  await page.getByLabel("Result role").selectOption("final");
  await page.getByRole("button", { name: "Submit run" }).click();
  await expect(page.getByRole("alert")).toContainText("submission rejected");
  await expect(model).toHaveValue("publisher/retry-model");
  await expect(provider).toHaveValue("retry-provider");
  await expect(page.getByLabel("Cost limit per trial")).toHaveValue("0.75");
  await expect(page.getByLabel("Result role")).toHaveValue("final");
});

test("navigates from runs to complete run and trial evidence", async ({ page }) => {
  await mockControl(page);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await page.locator(`a[href="/runs/${runId}"]`).click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Harbor totals", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("job-parent-one")).toBeVisible();
  await page.getByRole("link", { name: trialName, exact: true }).click();
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
  await page
    .getByLabel("Recorded model", { exact: true })
    .fill("publisher/workbench-model");
  await page
    .getByLabel("Harness model string", { exact: true })
    .fill("hf.publisher/runtime-model:together");
  await page.getByLabel("Recorded provider (optional)").fill("provider");
  await page.getByLabel("Concurrent trials").fill("12");
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
    n_concurrent_trials: 12,
    workbench: {
      setup_test_id: setupId,
      harbor_agent: { model_name: "hf.publisher/runtime-model:together" },
    },
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
  await page
    .getByLabel("Recorded model", { exact: true })
    .fill("publisher/workbench-model");
  await page
    .getByLabel("Harness model string", { exact: true })
    .fill("hf.publisher/runtime-model:together");
  await page.getByLabel("Recorded provider (optional)").fill("provider");
  await page
    .getByLabel(
      "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
    )
    .check();
  await expect(page.getByRole("button", { name: "Launch Harbor run" })).toBeEnabled();

  await page.getByLabel("Recipe name").fill("edited-agent");
  await expect(page.getByRole("button", { name: "Launch Harbor run" })).toBeDisabled();
});

test("model edits reset launch consent without rewriting the harness string", async ({
  page,
}) => {
  await mockControl(page);
  await page.goto("/workbench");
  await page
    .getByLabel("Start one disposable CPU setup test for this exact recipe.")
    .check();
  await page.getByRole("button", { name: "Run setup test" }).click();
  await expect(page.getByText("Setup passed")).toBeVisible();
  const harness = page.getByLabel("Harness model string", { exact: true });
  await harness.fill("hf.publisher/runtime-model:together");
  const consent = page.getByLabel(
    "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
  );
  for (const [label, value] of [
    ["Recorded model", "publisher/recorded-model"],
    ["Concurrent trials", "16"],
    ["Recorded provider (optional)", "together"],
    ["Harness model string", "hf.publisher/another-model:together"],
  ]) {
    await consent.check();
    await page.getByLabel(label, { exact: true }).fill(value);
    await expect(consent).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Launch Harbor run" }),
    ).toBeDisabled();
  }
  await expect(page.getByLabel("Recorded model", { exact: true })).toHaveValue(
    "publisher/recorded-model",
  );
  await page.getByLabel("Recorded provider (optional)").fill("");
  await expect(harness).toHaveValue("hf.publisher/another-model:together");
  await page.reload();
  await expect(page.getByLabel("Concurrent trials")).toHaveValue("16");
  await expect(harness).toHaveValue("hf.publisher/another-model:together");
  await expect(consent).not.toBeChecked();
  await expect(page.getByText("Setup passed")).not.toBeVisible();
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

test("edits and validates native launch configuration on desktop and mobile", async ({
  page,
}, testInfo) => {
  await mockControl(page);
  page.on("dialog", (dialog) => dialog.accept());
  const implementation = "harbor_hf_agents.pi.agent:PiAgent";
  await page.route("**/api/v1/agents", (route) =>
    json(route, {
      harbor_revision: "a".repeat(40),
      agents: [
        {
          label: "pi",
          config: {
            import_path: implementation,
            model_name: "huggingface/",
            kwargs: { version: "0.84.4" },
          },
          options_schema: {
            properties: {
              version: { type: "string", title: "Version" },
              thinking: { type: "string", enum: ["off", "high"] },
            },
          },
        },
      ],
      job_schema: { properties: { n_attempts: { type: "integer", default: 1 } } },
    }),
  );
  await page.route("**/api/v1/runs/validate", (route) =>
    json(route, {
      harbor_revision: "a".repeat(40),
      tasks: 1,
      agents: 1,
      trials: 1,
      warnings: [],
      not_performed: ["Model inference"],
      effective_config: route.request().postDataJSON(),
      fingerprint: "checked",
      credentials_available: true,
    }),
  );
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/runs/config", (route) => {
    submitted = route.request().postDataJSON();
    return json(route, { run: record }, 201);
  });
  await page.goto("/runs/new");
  await expect(
    page.getByRole("heading", { name: "New Job", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Benchmark preset").selectOption("0");
  await page.getByRole("button", { name: "Add agent", exact: true }).click();
  await page.getByLabel("Agent implementation").selectOption(implementation);
  await page.getByLabel("HF model", { exact: true }).fill("publisher/model");
  await page
    .getByRole("combobox", { name: "HF provider", exact: true })
    .selectOption("provider");
  await page.getByText("Agent configuration", { exact: true }).click();
  await page.getByRole("textbox", { name: "Version", exact: true }).fill("0.84.3");
  await page
    .getByRole("combobox", { name: "Sandbox flavor", exact: true })
    .selectOption("a100-large");
  await expect(page.getByText(/80 GB/)).toBeVisible();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("1 resolved tasks · 1 agents · 1 trials")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("launch-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Launch", exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("launch-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Copy draft link", exact: true }).click();
  const sharedUrl = await page.getByLabel("Draft link", { exact: true }).inputValue();
  expect(new URL(sharedUrl).searchParams.has("draft")).toBe(true);
  await page.evaluate(() => localStorage.clear());
  await page.goto(sharedUrl);
  await expect(page.getByLabel("HF model", { exact: true })).toHaveValue(
    "publisher/model",
  );
  await expect(
    page.getByRole("button", { name: "Launch", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("1 resolved tasks · 1 agents · 1 trials")).toBeVisible();
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(`/runs/${runId}`);
  expect(submitted).toMatchObject({
    agents: [
      {
        import_path: implementation,
        model_name: "huggingface/publisher/model:provider",
        kwargs: { version: "0.84.3" },
      },
    ],
    environment: { kwargs: { flavor: "a100-large" } },
  });
});

test("preserves safe draft links through sign-in and rejects credential-bearing links", async ({
  page,
}) => {
  await mockControl(page, { authenticated: false });
  const draft = { agents: [], n_attempts: 2, extra_instructions: ["Unicode ü + text"] };
  await page.goto(
    `/runs/new?draft=${encodeURIComponent(JSON.stringify(draft))}&cost_ceiling_usd_per_trial=2.5`,
  );
  await expect(page).toHaveURL(/\/auth\/login\?/);
  const returnTo = new URL(page.url()).searchParams.get("return_to");
  const restored = new URL(returnTo ?? "", "https://example.test");
  expect(restored.pathname).toBe("/runs/new");
  expect(JSON.parse(restored.searchParams.get("draft") ?? "")).toEqual(draft);
  expect(restored.searchParams.get("cost_ceiling_usd_per_trial")).toBe("2.5");
  const unsafe = { agents: [{ env: { HF_TOKEN: "test-only" } }] };
  await page.goto(`/runs/new?draft=${encodeURIComponent(JSON.stringify(unsafe))}`);
  await expect(page.getByRole("alert")).toHaveText(
    "Invalid launch draft link. No draft was loaded.",
  );
  expect(new URL(page.url()).pathname).toBe("/runs/new");
});

test("binding name typing retains focus and reload preserves pending edits", async ({
  page,
}) => {
  await mockControl(page);
  await page.goto("/workbench");
  const name = page.getByLabel("Binding 2 name", { exact: true });
  await name.fill("");
  await name.pressSequentially("CUSTOM_KEY", { delay: 15 });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("CUSTOM_KEY");
  await name.press("Home");
  await name.press("ArrowRight");
  await name.pressSequentially("_", { delay: 15 });
  await expect(name).toHaveValue("C_USTOM_KEY");
  await expect(name).toBeFocused();
  expect(await name.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(
    2,
  );
  // Reload before the debounce expires: pagehide must flush the latest edit.
  await page.reload();
  await expect(page.getByLabel("Binding 2 name", { exact: true })).toHaveValue(
    "C_USTOM_KEY",
  );
});

for (const width of [1440, 390]) {
  test(`native waffle preserves repeated trials and hover at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.clock.install();
    await page.setViewportSize({ width, height: 900 });
    await mockControl(page);
    const timestamp = new Date().toISOString();
    const task = { name: "task-one", digest: `sha256:${"d".repeat(64)}` };
    await page.route("**/api/v1/runs/*/progress", (route) =>
      json(route, {
        observed_at: timestamp,
        jobs_observed_at: timestamp,
        lock: { trials: Array.from({ length: 60 }, () => ({ task })) },
        trials: [
          {
            trial_name: "trial-a",
            config: { trial_name: "trial-a" },
            lock: { task },
            result: { finished_at: timestamp },
            reward: 0,
            cost_usd: 0.1,
          },
          {
            trial_name: "trial-b",
            config: { trial_name: "trial-b" },
            lock: { task },
            result: null,
            reward: null,
            cost_usd: null,
          },
        ],
        jobs: [
          { ...job, created_at: timestamp, started_at: timestamp },
          { ...job, id: "child-waiting", role: "trial", stage: "queued" },
        ],
      }),
    );
    await page.goto(`/runs/${runId}`);
    const waffle = page.getByRole("region", { name: "Trial progress waffle" });
    await expect(waffle.getByRole("rowheader")).toHaveCount(60);
    await expect(waffle.getByRole("cell")).toHaveCount(60);
    const zero = page.getByRole("link", { name: `trial-a in ${runId}: Zero reward` });
    const bounds = await zero.boundingBox();
    expect(bounds?.width).toBe(18);
    expect(bounds?.height).toBe(18);
    await zero.focus();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).not.toContainText("not an attempt ordinal");
    await expect(tooltip).toHaveText(
      "Task: task-one\nRepeat slot: 1\nState: Zero reward\nReward: 0.000\nAgent time: −\nReported cost (USD): $0.10",
    );
    await expect(tooltip).not.toContainText("Artifact observation");
    await page.screenshot({
      path: testInfo.outputPath(`compact-tooltip-${width}.png`),
    });
    const tip = await tooltip.boundingBox();
    expect(tip?.y).toBeGreaterThanOrEqual(0);
    expect((tip?.y ?? 0) + (tip?.height ?? 0)).toBeLessThanOrEqual(900);
    await expect(
      page.getByRole("button", {
        name: `trial-b in ${runId}: Unfinished`,
      }),
    ).toBeVisible();
    await zero.blur();
    const unfinished = page.getByRole("button", {
      name: `trial-b in ${runId}: Unfinished`,
      exact: true,
    });
    await unfinished.focus();
    await expect(tooltip).toHaveText(
      "Task: task-one\nRepeat slot: 2\nState: Unfinished\nReward: -\nAgent time: −",
    );
    await unfinished.blur();
    await page.screenshot({ path: testInfo.outputPath("native-waffle.png") });
    await page.getByText("HF Jobs and Harbor totals (separate observations)").click();
    await expect(
      page.getByText("trial · child-waiting · queued (waiting at HF)").first(),
    ).toBeVisible();
    await page.route("**/api/v1/runs/*/progress", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    const beforeFailure = await waffle.boundingBox();
    await page.clock.fastForward(125_000);
    expect(await waffle.boundingBox()).toEqual(beforeFailure);
    await expect(
      waffle.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(waffle.getByText(/● Stale/)).toBeVisible();
    const unknown = page.getByRole("button", {
      name: `trial-b in ${runId}: Unknown / interrupted`,
      exact: true,
    });
    await unknown.focus();
    await expect(tooltip).toHaveText(
      "Stale — refresh failed\nTask: task-one\nRepeat slot: 2\nState: Unknown / interrupted\nReward: -\nAgent time: −",
    );
    await expect(tooltip).not.toContainText("Artifact observation");

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
}

for (const launchPath of ["overview", "workbench"] as const) {
  test(`nine-trial actual preset launches from ${launchPath} and keeps native waffle identities`, async ({
    page,
  }) => {
    let submitted: unknown = null;
    await mockControl(page, { onRunPost: (payload) => (submitted = payload) });
    await page.goto(`/${launchPath}`);
    if (launchPath === "workbench") {
      await page
        .getByLabel("Start one disposable CPU setup test for this exact recipe.")
        .check();
      await page.getByRole("button", { name: "Run setup test" }).click();
      await expect(page.getByText("Setup passed")).toBeVisible();
    }
    const selector = page.getByRole("combobox", { name: "Benchmark preset" });
    await selector.selectOption({ label: "terminal-bench-2-1 · three-tasks-3-trials" });
    await expect(
      page.getByRole("spinbutton", { name: "Concurrent trials", exact: true }),
    ).toHaveValue("3");
    if (launchPath === "workbench") {
      await page
        .getByLabel("Recorded model", { exact: true })
        .fill("publisher/canary-model");
      await page
        .getByLabel("Harness model string", { exact: true })
        .fill("hf.publisher/canary-model:provider");
      await page.getByLabel("Recorded provider (optional)").fill("provider");
    } else {
      await page
        .getByRole("textbox", { name: "Model", exact: true })
        .fill("publisher/canary-model");
      await page.getByRole("textbox", { name: "Model", exact: true }).blur();
      await page
        .getByRole("combobox", { name: "Provider", exact: true })
        .selectOption("provider");
    }
    if (launchPath === "workbench") {
      await page
        .getByLabel(
          "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
        )
        .check();
      await page.getByRole("button", { name: "Launch Harbor run" }).click();
    } else {
      await page.getByRole("button", { name: "Submit run" }).click();
    }
    await expect.poll(() => submitted).not.toBeNull();
    expect(submitted).toMatchObject({
      benchmark: { name: canaryPreset.benchmark, preset: canaryPreset.preset },
      n_concurrent_trials: 3,
      ...(launchPath === "workbench" ? { workbench: { setup_test_id: setupId } } : {}),
    });
    expect(canaryPreset.leaderboard_eligible).toBe(false);
    const timestamp = new Date().toISOString();
    const tasks = canaryPreset.job.datasets[0]?.task_names ?? [];
    expect(tasks).toEqual([
      "code-from-image",
      "log-summary-date-ranges",
      "openssl-selfsigned-cert",
    ]);
    expect(canaryPreset.job.n_attempts).toBe(3);
    const observations = tasks.flatMap((name, index) =>
      Array.from({ length: canaryPreset.job.n_attempts }, (_, repetition) => {
        const task = { name, digest: `sha256:${String(index + 1).repeat(64)}` };
        const trial_name = `${name}__native-${repetition}`;
        return {
          trial_name,
          config: { trial_name },
          lock: { task },
          result: repetition === 0 ? { finished_at: timestamp } : null,
          reward: repetition === 0 ? 1 : null,
          cost_usd: repetition === 0 ? 0.01 : null,
        };
      }),
    );
    await page.route(`**/api/v1/runs/${runId}`, (route) =>
      json(route, {
        ...run,
        record: {
          ...record,
          role: "diagnostic",
          submission: {
            ...record.submission,
            benchmark: {
              name: canaryPreset.benchmark,
              preset: canaryPreset.preset,
            },
          },
          harbor_job_config: { ...record.harbor_job_config, ...canaryPreset.job },
        },
        result: {
          ...run.result,
          updated_at: timestamp,
          n_total_trials: 9,
          stats: {
            ...run.result.stats,
            n_completed_trials: 3,
            n_running_trials: 2,
            n_pending_trials: 4,
          },
        },
      }),
    );
    await page.route("**/api/v1/runs/*/progress", (route) =>
      json(route, {
        observed_at: timestamp,
        jobs_observed_at: timestamp,
        lock: { trials: observations.map((trial) => trial.lock) },
        trials: observations,
        jobs: [{ ...job, created_at: timestamp, started_at: timestamp }],
      }),
    );
    await page.goto(`/runs/${runId}`);
    const waffle = page.getByRole("region", { name: "Trial progress waffle" });
    await expect(waffle.getByRole("rowheader")).toHaveCount(3);
    await expect(
      waffle.getByText("3 tasks × 3 repeat slots · 9 planned"),
    ).toBeVisible();
    for (const task of tasks) {
      await expect(
        waffle.getByRole("columnheader", { name: new RegExp(task) }),
      ).toHaveCount(1);
    }
    for (const row of await waffle.locator("tbody tr").all()) {
      await expect(row.getByRole("cell")).toHaveCount(3);
    }
    for (const trial of observations) {
      const cell = trial.result
        ? page.getByRole("link", {
            name: `${trial.trial_name} in ${runId}: Completed`,
            exact: true,
          })
        : page.getByRole("button", {
            name: `${trial.trial_name} in ${runId}: Unfinished`,
            exact: true,
          });
      await expect(cell).toHaveCount(1);
      if (trial.result)
        await expect(cell).toHaveAttribute(
          "href",
          `/runs/${runId}/trials/${trial.trial_name}`,
        );
    }
    await page
      .getByRole("button", {
        name: `${observations[1]?.trial_name} in ${runId}: Unfinished`,
        exact: true,
      })
      .focus();
    await expect(page.getByRole("tooltip")).not.toContainText("not an attempt ordinal");
    await page.getByText("HF Jobs and Harbor totals (separate observations)").click();
    await expect(page.getByRole("button", { name: /Unfinished/ })).toHaveCount(6);
    await expect(page.getByRole("button", { name: /In progress/ })).toHaveCount(0);
    // Six unfinished observations are not substituted for Harbor's native running count.
    await expect(
      page.getByText(
        "Harbor: n_pending_trials: 4 · n_running_trials: 2 · n_completed_trials: 3",
      ),
    ).toBeVisible();
  });
}

test("native waffle polls preserve positions and pending slots within one run", async ({
  page,
}) => {
  await mockControl(page);
  await page.clock.install();
  const timestamp = new Date().toISOString();
  const task = { name: "task-one", digest: `sha256:${"d".repeat(64)}` };
  let names = ["trial-z"];
  await page.route("**/api/v1/runs/*/progress", (route) =>
    json(route, {
      observed_at: timestamp,
      jobs_observed_at: null,
      jobs: [],
      lock: { trials: Array.from({ length: 3 }, () => ({ task })) },
      trials: names.map((trial_name) => ({
        trial_name,
        config: { trial_name },
        lock: { task },
        result: { finished_at: timestamp },
        reward: 1,
        cost_usd: null,
      })),
    }),
  );
  await page.goto(`/runs/${runId}`);
  const row = page
    .getByRole("region", { name: "Trial progress waffle" })
    .locator("tbody");
  const original = page.getByRole("link", { name: `trial-z in ${runId}: Completed` });
  await expect(original).toBeVisible();
  await expect(row.getByRole("button", { name: /No mapped observation/ })).toHaveCount(
    2,
  );
  await original.focus();
  names = ["trial-a", "trial-z"];
  await page.clock.runFor(15_001);
  await expect(row.locator("td").nth(1)).toContainText("✓");
  await expect(original).toBeFocused();
  await expect(row.locator("td").nth(0).getByRole("link")).toHaveAccessibleName(
    `trial-z in ${runId}: Completed`,
  );
  await expect(row.locator("td").nth(1).getByRole("link")).toHaveAccessibleName(
    `trial-a in ${runId}: Completed`,
  );
  names = ["trial-a"];
  await page.clock.runFor(15_001);
  await expect(original).toHaveCount(0);
  await expect(row.locator("td").nth(0).getByRole("button")).toHaveAccessibleName(
    /No mapped observation/,
  );
  await expect(row.locator("td").nth(1).getByRole("link")).toHaveAccessibleName(
    `trial-a in ${runId}: Completed`,
  );
  await expect(row.getByRole("button", { name: /No mapped observation/ })).toHaveCount(
    2,
  );
});

test("nine lock entries stay nine squares through partial and replacement observations", async ({
  page,
}) => {
  await mockControl(page);
  await page.clock.install();
  const timestamp = new Date().toISOString();
  const task = { name: "task-one", digest: `sha256:${"d".repeat(64)}` };
  let locked = false;
  let nativeLock = false;
  let names = ["trial-partial"];
  await page.route("**/api/v1/runs/*/progress", (route) =>
    json(route, {
      observed_at: timestamp,
      jobs_observed_at: null,
      jobs: [],
      lock: locked ? { trials: Array.from({ length: 9 }, () => ({ task })) } : null,
      trials: names.map((trial_name) => ({
        trial_name,
        config: { trial_name },
        lock: nativeLock ? { task } : null,
        result: null,
        reward: null,
        cost_usd: null,
      })),
    }),
  );
  await page.goto(`/runs/${runId}`);
  const row = page
    .getByRole("region", { name: "Trial progress waffle" })
    .locator("tbody");
  await expect(page.getByText(/Planned total unknown \(no job lock\)/)).toBeVisible();
  await expect(row.locator("td")).toHaveCount(1);
  locked = true;
  await page.clock.runFor(15_001);
  await expect(row.locator("td")).toHaveCount(9);
  await expect(
    page.getByText(/9 planned squares · 1 separate observations/),
  ).toBeVisible();
  nativeLock = true;
  await page.clock.runFor(15_001);
  await expect(
    page.getByText(/9 planned squares · 0 separate observations/),
  ).toBeVisible();
  names = Array.from({ length: 9 }, (_, i) => `old-${i}`);
  await page.clock.runFor(15_001);
  await expect(row.getByRole("button", { name: /Unfinished/ })).toHaveCount(9);
  const original = row.getByRole("button", { name: /^old-0 / });
  await original.focus();
  names = [];
  await page.clock.runFor(15_001);
  await expect(row.getByRole("button", { name: /No mapped observation/ })).toHaveCount(
    9,
  );
  names = Array.from({ length: 9 }, (_, i) => `replacement-${i}`);
  await page.clock.runFor(15_001);
  await expect(row.locator("td")).toHaveCount(9);
  await expect(row.getByRole("button", { name: /^replacement-/ })).toHaveCount(9);
  await expect(row.getByRole("button", { name: /^replacement-0 / })).not.toBeFocused();
  await page.reload();
  await expect(row.locator("td")).toHaveCount(9);
  await expect(
    page.getByText(/9 planned squares · 0 separate observations/),
  ).toBeVisible();
});

test("completed run diagnostics refresh automatically and drill into native evidence", async ({
  page,
}) => {
  await mockControl(page);
  await page.clock.install();
  let completed = false;
  const snapshot = () => ({
    ...run,
    status: completed ? "finished" : "running",
    result: {
      ...run.result,
      finished_at: completed ? "2026-01-01T00:01:00Z" : null,
      stats: {
        ...run.result.stats,
        n_errored_trials: completed ? 1 : 0,
        evals: {
          reward: {
            metrics: [{ mean: 1 }],
            exception_stats: completed ? { RuntimeError: [trialName] } : {},
          },
        },
      },
    },
  });
  await page.route("**/api/v1/runs", (route) => json(route, { runs: [snapshot()] }));
  await page.route(`**/api/v1/runs/${runId}`, (route) => json(route, snapshot()));
  await page.route(`**/api/v1/runs/${runId}/trials/${trialName}`, (route) =>
    json(route, {
      ...trial,
      result: {
        ...trial.result,
        exception_info: {
          exception_type: "RuntimeError",
          exception_message: "synthetic setup exception",
          exception_traceback: "synthetic native traceback",
        },
      },
    }),
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.method() !== "GET")
      writes.push(request.method());
  });
  await page.goto("/runs");
  await expect(page.getByText("No recorded exceptions", { exact: true })).toBeVisible();
  completed = true;
  await page.clock.runFor(10_100);
  const diagnostic = page.getByRole("link", {
    name: /Harbor-reported exceptions.*1 affected trial/,
  });
  await expect(diagnostic).toBeVisible();
  await diagnostic.click();
  const panel = page.getByRole("region", { name: "Harbor-reported exceptions" });
  await expect(panel.getByText("RuntimeError", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Infrastructure classification.*unknown/)).toBeVisible();
  const configuration = page.getByLabel("Configured agents");
  await expect(configuration.getByText("Not recorded in native kwargs")).toBeVisible();
  await expect(configuration.getByText(/not verified provider requests/)).toBeVisible();
  await panel.getByRole("link", { name: trialName, exact: true }).click();
  await expect(
    page.getByText("synthetic native traceback", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("historical waffle native exception tooltip and badge link to traceback", async ({
  page,
}) => {
  await mockControl(page);
  await page.route("**/api/v1/runs", (route) =>
    json(route, { runs: [{ ...run, status: "finished" }] }),
  );
  await page.route("**/api/v1/runs/*/progress", (route) =>
    json(route, {
      observed_at: new Date().toISOString(),
      jobs_observed_at: null,
      jobs: [],
      lock: null,
      trials: [
        {
          trial_name: trialName,
          config: null,
          lock: null,
          reward: 0,
          cost_usd: null,
          result: {
            task_name: "task-one",
            finished_at: "2026-01-01T00:01:00Z",
            exception_info: { exception_type: "RuntimeError" },
          },
        },
        {
          trial_name: "trial-unknown",
          config: null,
          lock: null,
          reward: 0,
          cost_usd: null,
          result: { task_name: "task-two", finished_at: "2026-01-01T00:01:00Z" },
        },
      ],
    }),
  );
  await page.route("**/api/v1/runs/*/trials/*", (route) =>
    json(route, {
      ...trial,
      reward: 0,
      result: {
        ...trial.result,
        exception_info: {
          exception_type: "RuntimeError",
          exception_message: "synthetic exception",
          exception_traceback: "synthetic waffle native traceback",
        },
      },
    }),
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.method() !== "GET")
      writes.push(request.method());
  });
  await page.goto(`/runs/${runId}`);
  const square = page.getByRole("link", { name: `${trialName} in ${runId}: Errored` });
  const unknown = page.getByRole("link", {
    name: `trial-unknown in ${runId}: Zero reward`,
  });
  await unknown.focus();
  await expect(page.getByRole("tooltip")).not.toContainText(
    "Native exception evidence: unknown / unavailable",
  );
  await square.focus();
  await expect(page.getByRole("tooltip")).toContainText("Exception: RuntimeError");
  await expect(page.getByRole("tooltip")).toContainText("Reward: 0");
  await expect(page.getByRole("tooltip")).not.toContainText(
    "Infrastructure classification: unknown",
  );
  await page.getByText(/Planned total unknown \(no job lock\)/).click();
  const evidence = page.getByRole("list", { name: "Native trial exception evidence" });
  await expect(evidence).toContainText("Native exception: RuntimeError");
  await expect(evidence).toContainText(
    "Native exception evidence: unknown / unavailable",
  );
  await evidence.getByRole("link", { name: trialName, exact: true }).click();
  await expect(
    page.getByText("synthetic waffle native traceback", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("Runs stays a list with original counts and only opening detail requests progress", async ({
  page,
}) => {
  await mockControl(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/progress")) requests.push(request.url());
  });
  await page.goto("/runs?view=waffle");
  await expect(page.getByText("1 / 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Diagnostics" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Trial progress waffle" })).toHaveCount(
    0,
  );
  expect(requests).toEqual([]);
  await page.getByRole("link", { name: /publisher\/model/ }).click();
  const waffle = page.getByRole("region", { name: "Trial progress waffle" });
  await expect(waffle).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  const summary = await page.getByText("Inference cost", { exact: true }).boundingBox();
  const contents = await waffle.boundingBox();
  const identity = await page
    .getByRole("heading", { name: "Run identity" })
    .boundingBox();
  expect(contents?.y).toBeGreaterThan((summary?.y ?? 0) + (summary?.height ?? 0));
  expect(identity?.y).toBeGreaterThan((contents?.y ?? 0) + (contents?.height ?? 0));
  await expect(page.getByRole("link", { name: trialName, exact: true })).toBeVisible();
});

for (const width of [1600, 1440, 390]) {
  test(`matrix 89 columns by five slots at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockControl(page);
    const timestamp = new Date().toISOString();
    const tasks = Array.from({ length: 89 }, (_, index) => ({
      name: `synthetic-task-${String(index).padStart(2, "0")}`,
      digest: `sha256:${"d".repeat(64)}`,
    }));
    const nativeTrials = tasks.flatMap((task, taskIndex) =>
      Array.from({ length: 5 }, (_, slot) => {
        const index = taskIndex * 5 + slot;
        const exception = index < 15 ? "ApiOverloadedError" : null;
        return {
          trial_name: `${task.name}__repeat-${slot + 1}`,
          config: null,
          lock: { task },
          reward: exception ? null : index % 2 ? 1 : 0,
          cost_usd: 0.12,
          result: {
            task_name: task.name,
            finished_at: timestamp,
            exception_info: exception ? { exception_type: exception } : null,
            verifier_result: exception
              ? null
              : { rewards: { reward: index % 2 ? 1 : 0 } },
          },
        };
      }),
    );
    const realistic = {
      ...run,
      status: "finished",
      record: {
        ...record,
        harbor_job_config: { ...record.harbor_job_config, n_attempts: 5 },
      },
      result: {
        ...summaryResult,
        n_total_trials: 445,
        stats: {
          ...summaryResult.stats,
          n_completed_trials: 445,
          n_errored_trials: 15,
          evals: {
            synthetic: {
              ...summaryResult.stats.evals.synthetic,
              n_errors: 15,
              exception_stats: {
                ApiOverloadedError: nativeTrials.slice(0, 15).map((t) => t.trial_name),
              },
            },
          },
        },
      },
    };
    await page.route(`**/api/v1/runs/${runId}`, (route) => json(route, realistic));
    await page.route("**/api/v1/runs/*/progress", (route) =>
      json(route, {
        observed_at: timestamp,
        jobs_observed_at: timestamp,
        jobs: [],
        trials: nativeTrials,
        lock: {
          trials: tasks.flatMap((task) => Array.from({ length: 5 }, () => ({ task }))),
        },
      }),
    );
    await page.goto(`/runs/${runId}`);
    await expect(page.getByLabel("Input tokens: 20484123", { exact: true })).toHaveText(
      "20.484M",
    );
    if (width === 1600) {
      const cards = page.getByRole("region", { name: "Run summary" });
      expect(
        await cards.evaluate((el) =>
          Math.max(
            ...[...el.children].map((card) => card.getBoundingClientRect().height),
          ),
        ),
      ).toBeLessThanOrEqual(130);
    }
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-summary-${width}.png`),
    });
    const matrix = page.getByRole("region", { name: "Trial progress waffle" });
    await expect(matrix.getByRole("columnheader")).toHaveCount(90);
    await expect(matrix.getByRole("rowheader")).toHaveCount(5);
    await expect(matrix.getByRole("cell")).toHaveCount(445);
    for (const row of await matrix.locator("tbody tr").all())
      await expect(row.locator("td")).toHaveCount(89);
    await matrix.scrollIntoViewIfNeeded();
    const first = matrix
      .locator("tbody tr")
      .first()
      .locator("td")
      .first()
      .locator("a, button");
    const box = await first.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(12);
    expect(box?.width).toBeLessThanOrEqual(18);
    expect(box?.height).toBe(box?.width);
    // Resize the same 89-column matrix: fit when the 12px minimum is feasible.
    for (const desktopWidth of [1600, 1920, 2400, 1440, 390]) {
      await page.setViewportSize({ width: desktopWidth, height: 1000 });
      const size = await first.boundingBox();
      expect(size?.width).toBeGreaterThanOrEqual(12);
      expect(size?.width).toBeLessThanOrEqual(18);
      expect(size?.height).toBe(size?.width);
      expect((await matrix.locator("tbody tr").first().boundingBox())?.height).toBe(
        size?.height,
      );
      if (desktopWidth === 1600) expect(size?.width).toBeLessThan(14);
      const dimensions = await matrix.locator("table").evaluate((table) => {
        const scroller = table.parentElement;
        if (!scroller) throw new Error("Missing matrix scroller");
        return { client: scroller.clientWidth, scroll: scroller.scrollWidth };
      });
      if (desktopWidth >= 1600) {
        expect(dimensions.scroll).toBe(dimensions.client);
        expect(size?.width).toBeGreaterThan(12);
      } else if (desktopWidth === 390) {
        expect(size?.width).toBe(12);
        expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
      }
    }
    await page.setViewportSize({ width, height: 1000 });
    expect(await matrix.locator("thead button").count()).toBe(0);
    expect(
      await matrix.locator("thead").evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(1);
    expect(
      await matrix.locator("table").evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThan(1300);
    await first.hover();
    await expect(page.getByRole("tooltip")).toContainText("synthetic-task-00");
    await page.mouse.move(0, 0);
    await expect(matrix.getByText("15 affected trials", { exact: true })).toBeVisible();
    await expect(matrix.getByRole("link", { name: /: Errored$/ })).toHaveCount(15);
    await expect(matrix.getByRole("link", { name: /: Zero reward$/ })).not.toHaveCount(
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-matrix-${width}.png`),
    });
    await page
      .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
      .click();
    await fillScenario(page);
    await page
      .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
      .locator("..")
      .screenshot({
        path: testInfo.outputPath(`synthetic-pricing-${width}.png`),
      });
    const last = matrix
      .locator("tbody tr")
      .first()
      .locator("td")
      .last()
      .locator("a, button");
    await page.mouse.move(0, 0);
    await last.focus();
    await expect(page.getByRole("tooltip")).toContainText("synthetic-task-88");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

const summaryResult = {
  n_total_trials: 89,
  stats: {
    n_completed_trials: 89,
    n_errored_trials: 0,
    n_input_tokens: 20_484_123,
    n_output_tokens: 0,
    n_cache_tokens: 1_000_000,
    cost_usd: 12.34,
    evals: {
      synthetic: {
        metrics: [{ mean: 0.5168539325842697 }],
        reward_stats: { reward: {} },
        exception_stats: {},
      },
    },
  },
};

async function summaryFixture(page: Page, result: unknown = summaryResult) {
  await mockControl(page);
  const value = { ...run, status: "finished", result };
  await page.route("**/api/v1/runs", (route) => json(route, { runs: [value] }));
  await page.route(`**/api/v1/runs/${runId}`, (route) => json(route, value));
}

async function fillScenario(page: Page) {
  for (const [label, value] of [
    ["Standard input", "2"],
    ["Standard output", "8"],
    ["Standard cached", "0.5"],
    ["Long-context input", "4"],
    ["Long-context output", "16"],
    ["Long-context cached", "1"],
  ])
    await page.getByLabel(`${label} (USD/M)`, { exact: true }).fill(value);
}

test("summary exact tooltip, million tokens and complete progress", async ({
  page,
}) => {
  await summaryFixture(page);
  await page.goto(`/runs/${runId}`);
  const score = page.getByLabel("Score: 0.5168539325842697", {
    exact: true,
  });
  await expect(score).toHaveText("0.517");
  await score.locator("xpath=ancestor::span[@tabindex='0'][1]").focus();
  await expect(page.getByRole("tooltip")).toHaveText("Score: 0.5168539325842697");
  await expect(page.getByLabel("Input tokens: 20484123", { exact: true })).toHaveText(
    "20.484M",
  );
  await expect(page.getByLabel("Output tokens: 0", { exact: true })).toHaveText(
    "0.000M",
  );
  await score.locator("xpath=ancestor::span[@tabindex='0'][1]").blur();
  for (const exact of [
    "Input tokens: 20484123",
    "Output tokens: 0",
    "Reported cost (USD): 12.34",
  ]) {
    const value = page.getByLabel(exact, { exact: true });
    await value.hover();
    await expect(page.getByRole("tooltip")).toHaveText(exact);
  }
  await expect(page.getByText("89 / 89", { exact: true })).toBeVisible();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await expect(
    page
      .getByText("Infra-related trials: 0 · unclassified: 0", { exact: true })
      .first(),
  ).toBeVisible();
});

test("missing summaries do not masquerade as zeros", async ({ page }) => {
  await summaryFixture(page, null);
  await page.goto(`/runs/${runId}`);
  for (const label of ["Score", "Input tokens", "Output tokens"])
    await expect(page.getByLabel(`${label}: unavailable`, { exact: true })).toHaveText(
      "-",
    );
  await expect(
    page
      .getByText("Infra-related trials: - · unclassified: -", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("100%", { exact: true })).toHaveCount(0);
});

test("pricing is cache-inclusive, hypothetical, retained and GET-only", async ({
  page,
}) => {
  const pricingResult = {
    ...summaryResult,
    stats: { ...summaryResult.stats, n_output_tokens: 250_000 },
  };
  await summaryFixture(page, pricingResult);
  let reads = 0;
  await page.route(`**/api/v1/runs/${runId}`, (route) => {
    reads++;
    return json(route, { ...run, result: pricingResult });
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.method() !== "GET")
      writes.push(request.method());
  });
  await page.goto(`/runs/${runId}`);
  await page
    .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
    .click();
  const standard = page
    .locator("dd")
    .filter({ has: page.locator('output[aria-label^="Standard scenario"]') });
  await expect(standard).toHaveText("-");
  await fillScenario(page);
  await expect(standard.locator("output")).toHaveAttribute(
    "title",
    "Standard scenario USD: 41.468246",
  );
  const long = page.locator('output[aria-label^="Long-context scenario"]');
  await expect(long).toHaveAttribute("title", "Long-context scenario USD: 82.936492");
  await expect(
    page.getByLabel("Reported cost (USD): 12.34", {
      exact: true,
    }),
  ).toHaveText("$12.34");
  const threshold = page.getByLabel(/Long context when request input exceeds/);
  for (const value of ["1", "999999999"]) {
    await threshold.fill(value);
    await expect(standard.locator("output")).toHaveAttribute(
      "title",
      "Standard scenario USD: 41.468246",
    );
    await expect(long).toHaveAttribute("title", "Long-context scenario USD: 82.936492");
    await expect(
      page.locator('output[aria-label^="Actual tier-adjusted USD"]'),
    ).toHaveText("-");
  }
  const before = reads;
  await expect.poll(() => reads, { timeout: 15000 }).toBeGreaterThan(before);
  await expect(page.getByLabel("Standard input (USD/M)", { exact: true })).toHaveValue(
    "2",
  );
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator(`a[href="/runs/${runId}"]`).first().click();
  await page
    .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
    .click();
  await expect(page.getByLabel("Standard input (USD/M)", { exact: true })).toHaveValue(
    "2",
  );
  await expect(threshold).toHaveValue("999999999");
  for (const value of ["-1", "1000001"]) {
    await page.getByLabel("Standard input (USD/M)", { exact: true }).fill(value);
    await expect(
      page.getByLabel("Standard input (USD/M)", { exact: true }),
    ).toHaveAttribute("aria-invalid", "true");
    await expect(standard).toHaveText("-");
  }
  await page.getByLabel("Standard input (USD/M)", { exact: true }).fill("");
  await expect(standard).toHaveText("-");
  for (const label of ["Standard input", "Standard output", "Standard cached"])
    await page.getByLabel(`${label} (USD/M)`, { exact: true }).fill("0");
  await expect(standard).toHaveText("$0.0000");
  expect(writes).toEqual([]);
});

test("list sorts raw scores and tokens rather than rounded labels", async ({
  page,
}, testInfo) => {
  await mockControl(page);
  const rows = [
    ["synthetic-low", 0.51681, 20_484_101],
    ["synthetic-high", 0.51689, 20_484_199],
    ["synthetic-zero", 0, 0],
    ["synthetic-missing", null, null],
  ].map(([id, score, tokens]) => ({
    ...run,
    status: "finished",
    record: {
      ...record,
      run_id: id,
      harbor_job_config: {
        ...record.harbor_job_config,
        agents: [{ name: "pi", model_name: id }],
      },
      submission: { ...record.submission, model: { ...record.submission.model, id } },
    },
    result: {
      stats: {
        n_input_tokens: tokens,
        evals: { synthetic: { metrics: [{ mean: score }] } },
      },
    },
  }));
  await page.route("**/api/v1/runs", (route) => json(route, { runs: rows }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/runs");
  const names = () =>
    page
      .locator('tbody a[href^="/runs/synthetic-"]:not([href*="#"])')
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute("href")?.replace("/runs/", "")),
      );
  for (const column of ["Score", "Input incl. cache (M)"]) {
    const header = page.getByRole("columnheader", { name: column, exact: true });
    await header.getByRole("button").click();
    const first = await names();
    await header.getByRole("button").click();
    const second = await names();
    expect(first.indexOf("synthetic-low") < first.indexOf("synthetic-high")).not.toBe(
      second.indexOf("synthetic-low") < second.indexOf("synthetic-high"),
    );
  }
  await expect(page.getByLabel("Score: 0", { exact: true })).toHaveText("0.000");
  await expect(page.getByLabel("Score: unavailable", { exact: true })).toHaveText("-");
  await expect(page.getByLabel("Input tokens: 0", { exact: true })).toHaveText(
    "0.000M",
  );
  await expect(
    page.getByLabel("Input tokens: unavailable", { exact: true }),
  ).toHaveText("-");
  await page.screenshot({
    path: testInfo.outputPath("synthetic-list-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("synthetic-list-mobile.png"),
    fullPage: true,
  });
});

for (const cache of [0, null]) {
  test(`pricing preserves zero versus missing native usage (${cache})`, async ({
    page,
  }) => {
    await summaryFixture(page, {
      stats: {
        n_input_tokens: 0,
        n_output_tokens: 0,
        n_cache_tokens: cache,
        cost_usd: 0,
      },
    });
    await page.goto(`/runs/${runId}`);
    await page
      .getByText("Pricing scenarios · editable USD / million tokens", { exact: true })
      .click();
    await fillScenario(page);
    await expect(page.locator('output[aria-label^="Standard scenario"]')).toHaveText(
      cache === null ? "-" : "$0.0000",
    );
    await expect(
      page.locator('output[aria-label^="Long-context scenario"]'),
    ).toHaveText(cache === null ? "-" : "$0.0000");
    await expect(page.getByLabel("Reported cost (USD): 0", { exact: true })).toHaveText(
      "$0.0000",
    );
  });
}

for (const width of [1440, 390]) {
  test(`stable measured timing during delayed background polling at ${width}px`, async ({
    page,
  }) => {
    await mockControl(page);
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const phase = {
      started_at: "2026-09-09T00:00:00Z",
      finished_at: "2026-09-09T00:01:26Z",
    };
    const value = {
      ...run,
      status: "running",
      agent_timing: {
        duration_ms: 750000,
        complete_trials: 4,
        partial_trials: 1,
        unavailable_trials: 2,
      },
      result: {
        ...summaryResult,
        stats: {
          ...summaryResult.stats,
          n_errored_trials: 1,
          evals: {
            synthetic: { n_errors: 1, exception_stats: { RuntimeError: [trialName] } },
          },
        },
      },
    };
    let progressReads = 0;
    let release: (() => void) | undefined;
    await page.route("**/api/v1/runs", (route) => json(route, { runs: [value] }));
    await page.route(`**/api/v1/runs/${runId}`, (route) => json(route, value));
    await page.route("**/api/v1/runs/*/progress", async (route) => {
      progressReads++;
      if (progressReads > 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const task = { name: "task-one", digest: "sha256:synthetic" };
      await json(route, {
        observed_at: new Date().toISOString(),
        jobs_observed_at: null,
        jobs: [],
        lock: { trials: [{ task }] },
        trials: [
          {
            trial_name: trialName,
            lock: { task },
            config: null,
            reward: 1,
            cost_usd: null,
            result: {
              finished_at: phase.finished_at,
              agent_execution: phase,
              exception_info: null,
            },
          },
        ],
      });
    });
    await page.goto("/runs");
    await expect(page.getByText("Running · Agent Σ 12m30s (partial)")).toBeVisible();
    await page.clock.runFor(15001);
    expect(progressReads).toBe(0);
    const affected = page.getByText("1 affected trial", { exact: true }).first();
    await expect(affected).toHaveClass(/text-red-400/);
    await page.goto(`/runs/${runId}`);
    const matrix = page.getByRole("region", { name: "Trial progress waffle" });
    const square = matrix.getByRole("link", {
      name: `${trialName} in ${runId}: Completed`,
    });
    await expect(square).toBeVisible();
    await square.focus();
    await expect(page.getByRole("tooltip")).toContainText("Agent time: 1m26s");
    const text = await page.getByRole("tooltip").innerText();
    expect(text.split("\n").filter((line) => line.startsWith("Agent time:"))).toEqual([
      "Agent time: 1m26s",
    ]);
    const before = await matrix.boundingBox();
    const squareBefore = await square.boundingBox();
    await page.clock.runFor(15001);
    await expect.poll(() => progressReads).toBe(2);
    expect(release).toBeDefined();
    await expect(page.getByText("Refreshing…", { exact: true })).toHaveCount(0);
    expect(await matrix.boundingBox()).toEqual(before);
    expect(await square.boundingBox()).toEqual(squareBefore);
    await expect(square).toBeFocused();
    release?.();
    await expect(
      page.getByText("4 complete · 1 partial · 2 unavailable"),
    ).toBeVisible();
  });
}

for (const coarse of [false, true]) {
  test(`compact 3x3 markers, freshness and cards with coarse pointer ${coarse}`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: coarse ? 390 : 1600, height: 1000 },
      hasTouch: coarse,
    });
    const page = await context.newPage();
    await page.clock.install();
    await summaryFixture(page);
    const tasks = ["synthetic-a", "synthetic-b", "synthetic-c"].map((name) => ({
      name,
      digest: "sha256:synthetic",
    }));
    const observed = new Date().toISOString();
    await page.route("**/api/v1/runs/*/progress", (route) =>
      json(route, {
        observed_at: observed,
        jobs_observed_at: observed,
        jobs: [],
        lock: {
          trials: tasks.flatMap((task) => Array.from({ length: 3 }, () => ({ task }))),
        },
        trials: [
          {
            trial_name: "synthetic-unfinished",
            config: {},
            lock: { task: tasks[0] },
            result: null,
            reward: null,
            cost_usd: null,
          },
        ],
      }),
    );
    await page.goto(`/runs/${runId}`);
    const matrix = page.getByRole("region", { name: "Trial progress waffle" });
    await expect(matrix.getByRole("cell")).toHaveCount(9);
    const unfinished = matrix.getByRole("button", {
      name: /synthetic-unfinished.*Unfinished/,
    });
    const pending = matrix
      .getByRole("button", { name: /No mapped observation/ })
      .first();
    expect((await unfinished.boundingBox())?.width).toBe(coarse ? 24 : 18);
    expect((await unfinished.locator("[aria-hidden]").boundingBox())?.width).toBe(11);
    expect((await pending.locator("[aria-hidden]").boundingBox())?.width).toBe(4);
    await expect(unfinished).not.toContainText("?");
    await expect(pending).not.toContainText("?");
    await unfinished.focus();
    await expect(unfinished).toBeFocused();
    expect(await unfinished.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
      "2px",
    );
    await expect(page.getByRole("tooltip")).toContainText("State: Unfinished");
    await unfinished.blur();
    const cards = page.getByRole("region", { name: "Run summary" });
    expect(
      await cards.evaluate((el) =>
        [...el.children].every((card) => card.scrollWidth <= card.clientWidth),
      ),
    ).toBe(true);
    if (!coarse) {
      expect((await matrix.locator("table").boundingBox())?.width).toBeLessThan(100);
    }
    if (!coarse)
      expect(
        await cards.evaluate(
          (el) =>
            new Set([...el.children].map((card) => card.getBoundingClientRect().y))
              .size,
        ),
      ).toBe(1);
    await expect(cards.getByText("cache hit", { exact: true })).toBeVisible();
    await expect(cards).toContainText("4.9%");
    await matrix.scrollIntoViewIfNeeded();
    const before = await matrix.boundingBox();
    const slot = page.getByRole("group", { name: "Observation freshness" });
    const slotBefore = await slot.boundingBox();
    await page.clock.runFor(65001);
    await expect(matrix.getByText("● Stale")).toBeVisible();
    expect(await matrix.boundingBox()).toEqual(before);
    expect(await slot.boundingBox()).toEqual(slotBefore);
    const uncertain = matrix.getByRole("button", {
      name: /synthetic-unfinished.*Unknown/,
    });
    await expect(uncertain).not.toContainText("?");
    await page.route("**/api/v1/runs/*/progress", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    await page.clock.runFor(60001);
    await expect(
      matrix.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    expect(await matrix.boundingBox()).toEqual(before);
    expect(await slot.boundingBox()).toEqual(slotBefore);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-compact-stale-${coarse}.png`),
    });
    await context.close();
  });
}
