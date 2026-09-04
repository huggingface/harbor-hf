import { expect, test } from "@playwright/test";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "../../../packages/control-core/src/workbench";

const reviewedFastAgentPreview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);

const session = {
  authenticated: true,
  expires_at: "2026-08-18T12:00:00.000Z",
  actor: { username: "test-user", role: "operator", transport: "session" },
};

function system(writeMode: "disabled" | "enabled" = "enabled") {
  return {
    source_revision: "test-revision-0123456789abcdef",
    write_mode: writeMode,
    initialization: { ready: true, status: "ready" },
    projection: {
      ready: true,
      rebuilding: false,
      object_count: 12,
      last_rebuild_at: "2026-08-18T00:00:00.000Z",
      last_sync_at: "2026-08-18T00:01:00.000Z",
      event_cursor: null,
      integrity_error: null,
    },
    resource_contract: { spaces: 1, buckets: 1, operator_secrets: 2 },
  };
}

function infrastructureCapacity() {
  return {
    alias: "current",
    configured: true,
    profile_id: "sha256:capacity",
    max_active_jobs: 128,
    active_jobs: 112,
    available_jobs: 16,
    queued_jobs: 64,
    observed_running_jobs: 26,
    observed_scheduling_jobs: 4,
    reserved_without_active_observation: 82,
    start_tokens: 128,
    start_burst: 128,
    start_refill_tokens: 128,
    start_refill_period_seconds: 10,
    runs: Array.from({ length: 7 }, (_, index) => ({
      run_id: `run-${index + 1}`,
      max_active_jobs: 16,
      active_jobs: 16,
      available_jobs: 0,
    })),
    hardware: [
      {
        hardware: "cpu-basic",
        max_active_jobs: 128,
        active_jobs: 112,
        available_jobs: 16,
      },
    ],
  };
}

test("starts OAuth directly from every guest admin link", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { authenticated: false, login_url: "/auth/login" },
    }),
  );
  await page.route("**/api/v1/leaderboard", (route) =>
    route.fulfill({ json: { snapshot: null, items: [] } }),
  );
  let loginUrl = "";
  await page.route("**/auth/login**", (route) => {
    loginUrl = route.request().url();
    return route.fulfill({ status: 204 });
  });

  await page.goto("/");
  await expect(page.getByText(/admin views require/i)).toHaveCount(0);
  await page.getByRole("link", { name: "Overview" }).click();
  await expect.poll(() => loginUrl).toContain("/auth/login?return_to=%2Foverview");
});

test("shows the operational overview on desktop and mobile", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/runs", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/endpoints", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/capacity", (route) =>
    route.fulfill({ json: infrastructureCapacity() }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("All observed endpoints safe")).toBeVisible();
  await expect(page.getByText("test-revision-0123456789abcdef")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Job infrastructure" })).toBeVisible();
  await expect(page.getByText("112/128", { exact: true })).toBeVisible();
  await expect(page.getByText("16", { exact: true })).toBeVisible();
  await expect(page.getByText("Per-run reservations (7)")).toBeVisible();
  await expect(page.getByText("16/16 reserved, 0 available")).toHaveCount(7);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("tests a Workbench recipe and submits a hosted Run", async ({
  page,
}, testInfo) => {
  let hostedSubmission: Record<string, unknown> | null = null;
  const saved = {
    schema_version: "v1",
    revision: reviewedFastAgentPreview.recipe_digest,
    recipe: fastAgentWorkbenchStarter,
  };
  let savedItems: (typeof saved)[] = [];
  await page.route("**/api/v1/workbench/configurations", (route) => {
    if (route.request().method() === "POST") {
      savedItems = [saved];
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: { items: savedItems } });
  });
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.route("**/api/v1/profiles**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            profile_id: "sha256:model",
            profile_kind: "model",
            name: "gpt-oss-20b",
            source: "built-in",
            promotion_state: "approved",
            alias: "gpt-oss-20b",
            approved_aliases: ["gpt-oss-20b", "gpt-oss-20b-together"],
            spec: {
              model_id: "openai/gpt-oss-20b",
              revision: "6cee5e81ee83917806bbde320786a8fb61efebee",
            },
            created_at: "2026-08-27T00:00:00.000Z",
          },
          {
            profile_id: "sha256:harness",
            profile_kind: "harness",
            name: "fast-agent-0-10-16-command",
            source: "built-in",
            promotion_state: "approved",
            alias: "fast-agent-0-10-16-command",
            approved_aliases: ["fast-agent-0-10-16-command"],
            spec: reviewedFastAgentPreview.harness_profile,
            created_at: "2026-08-27T00:00:00.000Z",
          },
          {
            profile_id: "sha256:deployment",
            profile_kind: "deployment",
            name: "tb21-gpt-oss-command-providers",
            source: "built-in",
            promotion_state: "approved",
            alias: "tb21-gpt-oss-command-providers",
            approved_aliases: ["tb21-gpt-oss-command-providers"],
            spec: {
              models: ["gpt-oss-20b"],
              harnesses: ["fast-agent-0-10-16-command"],
              inference_provider: "together",
            },
            created_at: "2026-08-27T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/api/v1/runs", (route) => {
    if (route.request().method() === "POST") {
      hostedSubmission = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: {
          run_id: "run-workbench-hosted",
          action_id: "action-workbench-hosted",
          status_url: "/api/v1/runs/run-workbench-hosted",
          adopted: false,
        },
      });
    }
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.route("**/api/v1/workbench/preview", async (route) => {
    const recipe = route.request().postDataJSON();
    return route.fulfill({ json: compileAgentWorkbenchRecipe(recipe) });
  });
  await page.route("**/api/v1/workbench/benchmark-configs", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            name: "tb21-gpt-oss-20b-canary",
            revision: `sha256:${"1".repeat(64)}`,
            label: "Terminal-Bench 2.1 canary · GPT-OSS 20B",
            description: "Reviewed hosted canary.",
            size: "small",
            benchmark: "terminal-bench-2-1-canary",
            model: "gpt-oss-20b-together",
            deployment: "tb21-gpt-oss-20b-fast-agent-command-providers",
            launch_policy: "diagnostic-single-attempt",
            default_ceiling_microusd: 1_000_000,
            max_ceiling_microusd: 1_000_000,
            task_count: 2,
            publication_role: "diagnostic",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/workbench/local-runs/options", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        ready: false,
        reason: "Local Harbor execution is disabled in browser E2E.",
        benchmark: "terminal-bench-2-1-canary",
        model: "gpt-oss-20b-together",
        task_names: [],
        harbor_version: null,
        expected_harbor_version: "0.22.0",
      },
    }),
  );
  await page.route("**/api/v1/workbench/local-runs", (route) =>
    route.fulfill({ json: [] }),
  );
  const setupFixture = {
    setup_test_id: "setup-test-workbench",
    recipe_digest: reviewedFastAgentPreview.recipe_digest,
    revision_id: reviewedFastAgentPreview.revision_id,
    status: "passed",
    created_at: "2026-08-27T12:00:00.000Z",
    started_at: "2026-08-27T12:00:01.000Z",
    completed_at: "2026-08-27T12:00:02.000Z",
    exit_code: 0,
    error: null,
    files: [
      {
        file_id: "file-instruction",
        path: "instruction.txt",
        root: "workspace",
        size: 31,
        text: true,
      },
    ],
  };
  let setupPassed = false;
  await page.route("**/api/v1/workbench/setup-tests", (route) => {
    if (route.request().method() === "POST") {
      setupPassed = true;
      return route.fulfill({ status: 202, json: setupFixture });
    }
    return route.fulfill({ json: setupPassed ? [setupFixture] : [] });
  });
  await page.route("**/api/v1/workbench/setup-tests/*/logs", (route) =>
    route.fulfill({
      json: {
        stdout: "fast-agent-mcp v0.10.16\n",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
      },
    }),
  );
  await page.route("**/api/v1/workbench/setup-tests/*/files/*", (route) =>
    route.fulfill({
      json: {
        file_id: "file-instruction",
        path: "instruction.txt",
        content: "<script>window.compromised=true</script>",
        truncated: false,
      },
    }),
  );

  await page.goto("/workbench");
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved fast-agent" }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("combobox", { name: "Load configuration" })
    .selectOption(saved.revision);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Loaded fast-agent" }),
  ).toBeVisible();

  await expect(page.getByRole("heading", { name: "Agent Workbench" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Configure → Test → Save" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The model route, direct inference URL, and credential binding come from the selected hosted deployment or local deployment profile. They are not recipe settings.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Preview ready")).toBeVisible();
  await expect(
    page.getByLabel("Environment variable OPENAI_API_KEY source"),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Environment variable MODEL_BASE_URL source"),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Select a saved version in New Run" }).click();
  await page
    .getByLabel("Benchmark", { exact: true })
    .selectOption("terminal-bench-2-1-canary");
  await page
    .getByLabel("Harness", { exact: true })
    .selectOption(`saved:${saved.revision}`);
  await page.getByLabel("Model", { exact: true }).fill("openai/gpt-oss-20b");
  await page
    .getByLabel("Reviewed configuration", { exact: true })
    .selectOption(`sha256:${"1".repeat(64)}`);
  await expect(
    page.getByText(/This saved version needs a passed setup test/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "Configure, test, or save a harness in Workbench" })
    .click();
  await page.getByRole("checkbox", { name: /launch this exact setup recipe/i }).check();
  await page.getByRole("button", { name: "Launch setup test" }).click();
  await expect(page.getByText("fast-agent-mcp v0.10.16")).toBeVisible();
  await expect(page.getByText("passed", { exact: true })).toBeVisible();
  await expect(page.getByText(/This does not verify hosted preparation/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /workspace\/instruction\.txt/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /workspace\/instruction\.txt/ }).click();
  await expect(page.getByLabel("Contents of instruction.txt")).toContainText(
    "<script>window.compromised=true</script>",
  );
  expect(
    await page.evaluate(
      () => (window as Window & { compromised?: boolean }).compromised,
    ),
  ).toBeUndefined();
  await page.screenshot({
    path: testInfo.outputPath("agent-workbench-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  for (const label of ["Configuration name"]) {
    const bounds = await page.getByLabel(label, { exact: true }).boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    path: testInfo.outputPath("agent-workbench-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Select a saved version in New Run" }).click();
  await page
    .getByLabel("Benchmark", { exact: true })
    .selectOption("terminal-bench-2-1-canary");
  await page
    .getByLabel("Harness", { exact: true })
    .selectOption(`saved:${saved.revision}`);
  await page.getByLabel("Model", { exact: true }).fill("unknown/model");
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Model", { exact: true }).fill("openai/gpt-oss-20b");
  await page
    .getByLabel("Reviewed configuration", { exact: true })
    .selectOption(`sha256:${"1".repeat(64)}`);
  await page
    .getByRole("checkbox", { name: /i confirm this exact harness version/i })
    .check();
  await page.getByLabel("Cost ceiling, USD", { exact: true }).fill("0.50");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("Cost ceiling, USD", { exact: true }).fill("1");
  await page.getByRole("checkbox").check();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("new-run-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("new-run-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect
    .poll(() => hostedSubmission)
    .toMatchObject({
      benchmark_config: "tb21-gpt-oss-20b-canary",
      harness: {
        type: "workbench",
        recipe: fastAgentWorkbenchStarter,
        setup_test_id: "setup-test-workbench",
      },
      ceiling_microusd: 1_000_000,
      confirmed: true,
    });
  await expect(page).toHaveURL(/\/runs\/run-workbench-hosted$/);
});

test("tails and cancels a running Workbench setup", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.route("**/api/v1/workbench/preview", async (route) => {
    const recipe = route.request().postDataJSON();
    return route.fulfill({
      json: {
        recipe,
        recipe_digest: "sha256:workbench-running",
        revision_id: "recipe-revision-running",
        setup_command: "install agent",
        run_command: "run agent",
        environment: [],
        harness_profile: { agent: "command-agent" },
        warnings: [],
      },
    });
  });
  await page.route("**/api/v1/workbench/local-runs/options", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        ready: false,
        reason: "Local Harbor execution is disabled in browser E2E.",
        benchmark: "terminal-bench-2-1-canary",
        model: "gpt-oss-20b-together",
        task_names: [],
        harbor_version: null,
        expected_harbor_version: "0.22.0",
      },
    }),
  );
  await page.route("**/api/v1/workbench/local-runs", (route) =>
    route.fulfill({ json: [] }),
  );
  let cancellationRequested = false;
  const setup = (status: "running" | "cancelling" | "cancelled") => ({
    setup_test_id: "setup-test-running",
    recipe_digest: "sha256:workbench-running",
    revision_id: "recipe-revision-running",
    status,
    created_at: "2026-08-27T12:00:00.000Z",
    started_at: "2026-08-27T12:00:01.000Z",
    completed_at: status === "cancelled" ? "2026-08-27T12:00:02.000Z" : null,
    exit_code: status === "cancelled" ? 137 : null,
    error: null,
    files: [],
  });
  await page.route("**/api/v1/workbench/setup-tests", (route) =>
    route.fulfill({ status: 202, json: setup("running") }),
  );
  await page.route("**/api/v1/workbench/setup-tests/setup-test-running", (route) =>
    route.fulfill({
      json: setup(cancellationRequested ? "cancelled" : "running"),
    }),
  );
  await page.route("**/api/v1/workbench/setup-tests/setup-test-running/logs", (route) =>
    route.fulfill({
      json: {
        stdout: "Downloading agent package 3/10\n",
        stderr: "",
      },
    }),
  );
  await page.route(
    "**/api/v1/workbench/setup-tests/setup-test-running/cancel",
    (route) => {
      cancellationRequested = true;
      return route.fulfill({ json: setup("cancelling") });
    },
  );

  await page.goto("/workbench");
  await expect(page.getByText("Preview ready")).toBeVisible();
  await page.getByRole("checkbox", { name: /launch this exact setup recipe/i }).check();
  await page.getByRole("button", { name: "Launch setup test" }).click();
  await expect(page.getByText("Setup submitted")).toBeVisible();
  await expect(page.getByLabel("Live setup output")).toContainText(
    "Downloading agent package 3/10",
  );
  await expect(page.getByLabel("Final setup standard output")).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Live setup output")).toHaveCount(0);
  await expect(page.getByLabel("Final setup standard output")).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", {
      name: /launch this exact setup recipe/i,
    }),
  ).toBeVisible();
});

test("disables run launch and omits account details", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({ json: system("disabled") }),
  );
  await page.route("**/api/v1/runs", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/runs");
  await expect(page.getByRole("button", { name: "Start a run" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Account and session details" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("requires confirmation before starting a run", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({ json: system("enabled") }),
  );
  await page.route("**/api/v1/runs", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/profiles**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            profile_id: "sha256:benchmark",
            profile_kind: "benchmark",
            name: "terminal-bench-2-1-diagnostic-1",
            source: "built-in",
            promotion_state: "approved",
            alias: "terminal-bench-2-1-diagnostic-1",
            approved_aliases: ["terminal-bench-2-1-diagnostic-1"],
            spec: {
              benchmark: "terminal-bench-2-1",
              task_ids: ["task-a"],
              trial_indices: [1],
            },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:model",
            profile_kind: "model",
            name: "gpt-oss-20b",
            source: "built-in",
            promotion_state: "approved",
            alias: "gpt-oss-20b",
            approved_aliases: ["gpt-oss-20b"],
            spec: { model_id: "openai/gpt-oss-20b", revision: "abc" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:harness",
            profile_kind: "harness",
            name: "opencode",
            source: "built-in",
            promotion_state: "approved",
            alias: "opencode",
            approved_aliases: ["opencode"],
            spec: { agent: "opencode", reasoning_effort: "off" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:deployment",
            profile_kind: "deployment",
            name: "tb21-gpt-oss-20b-opencode-providers",
            source: "built-in",
            promotion_state: "approved",
            alias: "tb21-gpt-oss-20b-opencode-providers",
            approved_aliases: ["tb21-gpt-oss-20b-opencode-providers"],
            spec: {
              models: ["gpt-oss-20b"],
              harnesses: ["opencode"],
              trial_job_template: {
                inference_upstream: "https://router.huggingface.co/v1",
              },
            },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:policy",
            profile_kind: "launch_policy",
            name: "tb21-diagnostic-1",
            source: "built-in",
            promotion_state: "approved",
            alias: "tb21-diagnostic-1",
            approved_aliases: ["tb21-diagnostic-1"],
            spec: { reservation_microusd: 1000, publication_role: "diagnostic" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.route("**/api/v1/workbench/configurations", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/v1/workbench/benchmark-configs", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            name: "reviewed",
            revision: "sha256:reviewed",
            benchmark: "terminal-bench-2-1-diagnostic-1",
            model: "gpt-oss-20b",
            deployment: "tb21-gpt-oss-20b-opencode-providers",
            launch_policy: "tb21-diagnostic-1",
            label: "Reviewed diagnostic",
            description: "Reviewed fixture",
            size: "small",
            task_count: 1,
            publication_role: "diagnostic",
            default_ceiling_microusd: 1000000,
            max_ceiling_microusd: 2000000,
          },
        ],
      },
    }),
  );
  await page.goto("/runs");
  await page.getByRole("button", { name: "Start a run" }).click();
  const create = page.getByRole("button", { name: "Start run", exact: true });
  await expect(create).toBeDisabled();
  await page
    .getByLabel("Benchmark", { exact: true })
    .selectOption("terminal-bench-2-1-diagnostic-1");
  await page.getByLabel("Harness", { exact: true }).selectOption("builtin:opencode");
  await page.getByLabel("Model", { exact: true }).fill("openai/gpt-oss-20b");
  await page
    .getByLabel("Reviewed configuration", { exact: true })
    .selectOption("sha256:reviewed");
  await page.getByRole("checkbox").check();
  await expect(create).toBeEnabled();
  await page.getByLabel("Model", { exact: true }).fill("unreviewed/model");
  await expect(create).toBeDisabled();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("Model", { exact: true }).fill("openai/gpt-oss-20b");
  await page
    .getByLabel("Reviewed configuration", { exact: true })
    .selectOption("sha256:reviewed");
  await page.getByRole("checkbox").check();
  let builtinSubmission: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs", (route) => {
    builtinSubmission = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      json: {
        run_id: "run-builtin",
        action_id: "action-builtin",
        status_url: "/api/v1/runs/run-builtin",
        adopted: false,
      },
    });
  });
  await create.click();
  await expect
    .poll(() => builtinSubmission)
    .toEqual({
      benchmark: "terminal-bench-2-1-diagnostic-1",
      model: "gpt-oss-20b",
      harness: "opencode",
      deployment: "tb21-gpt-oss-20b-opencode-providers",
      launch_policy: "tb21-diagnostic-1",
      ceiling_microusd: 1000000,
      confirmed: true,
    });
  await expect(page).toHaveURL(/\/runs\/run-builtin$/);
});

test("shows run failures as errors rather than missing data", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  const forbidden = {
    status: 403,
    json: {
      error: {
        code: "access_denied",
        message: "access denied",
        request_id: "browser-request-id",
      },
    },
  };
  await page.route("**/api/v1/runs/run-error", (route) => route.fulfill(forbidden));
  await page.route("**/api/v1/runs/run-error/capacity", (route) =>
    route.fulfill(forbidden),
  );
  await page.route("**/api/v1/runs/run-error/tasks**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/runs/run-error");
  await expect(page.getByText("Forbidden")).toBeVisible();
  await expect(page.getByText(/browser-request-id/)).toBeVisible();
  await expect(page.getByText("Run not found")).toHaveCount(0);
});

test("shows the official leaderboard table and cost-score plot", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/leaderboard", (route) =>
    route.fulfill({
      json: {
        snapshot: {
          record_id: "leaderboard-snapshot-one",
          created_at: "2026-08-21T00:00:00.000Z",
          sqlite_digest: "sha256:sqlite",
          source_digest: "sha256:source",
          entry_count: 1,
        },
        items: [
          {
            rank: 1,
            pareto: true,
            configuration_digest: "sha256:strong",
            run_id: "run-strong",
            publication_id: "publication-strong",
            published_at: "2026-08-21T00:00:00.000Z",
            benchmark: "terminal-bench-2-1",
            model: "openai/gpt-oss-20b",
            harness: "opencode",
            inference_provider: "together",
            reasoning_effort: "off",
            harbor_version: "0.21.0",
            trial_count: 1,
            task_count: 2,
            scored_task_count: 2,
            primary_metric_name: "mean_reward",
            primary_metric_value: 0.9,
            primary_metric_unit: "score",
            observed_microusd: 40_000,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "openai/gpt-oss-20b", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText(
    "Admin",
  );
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "href",
    "/overview",
  );
  await expect(
    page.getByRole("img", { name: /cost versus score, with the pareto frontier/i }),
  ).toBeVisible();
});

test("shows complete run Jobs with sticky, filterable table headers", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({ json: system("enabled") }),
  );
  await page.route("**/api/v1/runs/run-table", (route) =>
    route.fulfill({
      json: {
        run_id: "run-table",
        created_at: "2026-08-24T00:00:00.000Z",
        status: "active",
        ceiling_microusd: 1_000_000,
        reserved_microusd: 500_000,
        observed_microusd: 100_000,
        total_tasks: 30,
        terminal_tasks: 2,
        admissible_tasks: 1,
        invalid_selected_tasks: 0,
        exhausted_tasks: 1,
        successful_tasks: 1,
        pending_actions: 8,
        replacement_assigned_tasks: 0,
        replacement_recorded_tasks: 0,
        publication_status: null,
        cleanup_pending: false,
        cancellation_requested: false,
        paused: false,
      },
    }),
  );
  await page.route("**/api/v1/runs/run-table/capacity", (route) =>
    route.fulfill({
      json: {
        run_active: 4,
        run_limit: 16,
        namespace_active: 4,
        namespace_limit: 128,
        hardware_active: 4,
        hardware_limit: 128,
        start_tokens: 120,
        start_burst: 128,
        queued: 0,
        cleanup_held: 0,
        limiting_factor: null,
      },
    }),
  );
  let taskRequests = 0;
  await page.route("**/api/v1/runs/run-table/tasks**", (route) => {
    taskRequests += 1;
    return route.fulfill({
      json: {
        items: Array.from({ length: 125 }, (_, index) => ({
          run_id: "run-table",
          task_id: `task-${String(index + 1).padStart(3, "0")}`,
          terminal_outcome:
            index === 0 ? "complete" : index === 1 ? "infrastructure" : null,
          selected_attempt_id: index < 2 ? `attempt-${index + 1}` : null,
          input_digest: `sha256:${String(index).padStart(64, "0")}`,
        })),
        next_cursor: null,
      },
    });
  });
  let jobRequests = 0;
  await page.route("**/api/v1/jobs**", (route) => {
    jobRequests += 1;
    const jobs = [
      {
        action_id: "action-job-1",
        run_id: "run-table",
        action_kind: "job.observe",
        generation: 2,
        target: "job-one",
        outcome: "completed",
        observed_state: "RUNNING",
        resource_id: "job-one",
        created_at: "2026-08-24T00:03:00.000Z",
        inspect_url: "https://huggingface.co/jobs/job-one",
        cost_microusd: 1_000,
        assigned_tasks: 20,
      },
      {
        action_id: "action-job-2",
        run_id: "run-table",
        action_kind: "job.observe",
        generation: 3,
        target: "job-two",
        outcome: "completed",
        observed_state: "ERROR",
        resource_id: "job-two",
        created_at: "2026-08-24T00:02:00.000Z",
        inspect_url: "https://huggingface.co/jobs/job-two",
        cost_microusd: 2_000,
        assigned_tasks: 10,
      },
    ];
    return route.fulfill({
      json: { items: jobs, next_cursor: null },
    });
  });
  await page.route("**/api/v1/events", (route) => route.abort());

  await page.goto("/runs/run-table");
  await expect(page.getByText("task-125")).toBeAttached();
  await expect(page.getByRole("navigation", { name: "Collection pages" })).toHaveCount(
    0,
  );
  expect(taskRequests).toBe(1);
  expect(jobRequests).toBe(1);
  await expect(page.getByRole("heading", { name: "Physical HF Jobs" })).toBeVisible();
  await expect(page.getByText("2 Jobs recorded, 1 active.")).toBeVisible();
  await page.getByLabel("Filter observed state").fill("error");
  await expect(page.getByText("1 of 2 rows")).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Observed" }).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("tooltip")).toContainText("Latest Hub stage");

  const header = page.locator("thead").nth(1);
  await header.scrollIntoViewIfNeeded();
  await expect(header).toHaveCSS("position", "sticky");
  await header
    .locator("..")
    .locator("..")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  await expect(header).toBeInViewport();
});

test("submits hosted results with a limited account and separate admin approval", async ({
  page,
}, testInfo) => {
  let role = "submitter";
  let submitted = false;
  let approved = false;
  const digest = `sha256:${"a".repeat(64)}`;
  const candidate = {
    run_id: "run-owned",
    publication_id: "publication-owned",
    catalog_digest: digest,
    public_row: {
      configuration_digest: digest,
      run_id: "run-owned",
      publication_id: "publication-owned",
      published_at: "2026-09-04T10:00:00Z",
      benchmark: "example-benchmark",
      model: "example-model",
      harness: "example-harness",
      inference_provider: "example-provider",
      reasoning_effort: "default",
      harbor_version: "pinned",
      trial_count: 1,
      task_count: 2,
      scored_task_count: 2,
      primary_metric_name: "accuracy",
      primary_metric_value: 0.5,
      primary_metric_unit: "fraction",
      observed_microusd: 1000,
    },
  };
  const summary = () => ({
    id: "submission-owned",
    run_id: candidate.run_id,
    publication_id: candidate.publication_id,
    catalog_digest: digest,
    created_at: "2026-09-04T10:00:00Z",
    status: approved ? "approved" : "pending",
  });
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/(system|events|runs)/.test(request.url()) && role === "submitter")
      privateRequests.push(request.url());
  });
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ...session, actor: { ...session.actor, role } } }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/events**", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/v1/leaderboard/candidates", (route) =>
    route.fulfill({ json: { items: [candidate] } }),
  );
  await page.route("**/api/v1/leaderboard/submissions", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        run_id: "run-owned",
        catalog_digest: digest,
        confirmed: true,
      });
      submitted = true;
      return route.fulfill({ json: summary() });
    }
    return route.fulfill({ json: { items: submitted ? [summary()] : [] } });
  });
  await page.route(
    "**/api/v1/leaderboard/submissions/submission-owned/review",
    (route) => {
      expect(role).toBe("operator");
      expect(route.request().postDataJSON()).toEqual({
        decision: "approved",
        confirmed: true,
        public_metadata_confirmed: true,
      });
      approved = true;
      return route.fulfill({ json: { id: "submission-owned", status: "approved" } });
    },
  );
  await page.goto("/submissions");
  await expect(
    page.getByRole("heading", { name: "Submit your results" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Workbench" })).toHaveCount(0);
  await page.getByLabel("Hosted result").selectOption(digest);
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  await page.getByLabel(/I consent to sharing/).check();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Nothing has been published" }),
  ).toBeVisible();
  expect(approved).toBe(false);
  expect(privateRequests).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("submissions-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.getByLabel("Hosted result").boundingBox();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await expect
    .poll(async () => {
      const nav = await page.locator("aside").boundingBox();
      return (nav?.x ?? 0) + (nav?.width ?? 0);
    })
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("submissions-mobile.png"),
    fullPage: true,
  });
  role = "operator";
  await page.reload();
  await expect(page.getByRole("button", { name: "Approve & publish" })).toBeDisabled();
  await page.getByLabel(/I reviewed every field/).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Approve & publish" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
});
