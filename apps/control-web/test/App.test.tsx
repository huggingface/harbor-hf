// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  actOnRun: vi.fn(),
  cancelWorkbenchSetup: vi.fn(),
  getJobs: vi.fn(),
  getLeaderboard: vi.fn(),
  getModelProviders: vi.fn(),
  getPresets: vi.fn(),
  getRun: vi.fn(),
  getRuns: vi.fn(),
  getSession: vi.fn(),
  getSystem: vi.fn(),
  getTrial: vi.fn(),
  getTrials: vi.fn(),
  getTrialProgress: vi.fn(),
  getWorkbenchFile: vi.fn(),
  getWorkbenchLogs: vi.fn(),
  getWorkbenchSetup: vi.fn(),
  listWorkbenchSetups: vi.fn(),
  previewWorkbenchRecipe: vi.fn(),
  signOut: vi.fn(),
  startWorkbenchSetup: vi.fn(),
  submitRun: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...apiMocks,
}));

import App from "../src/App";
import type {
  PresetsResponse,
  RunView,
  SystemResponse,
  TrialDetail,
  WorkbenchPreview,
  WorkbenchRecipe,
  WorkbenchSetup,
} from "../src/api";

const runId = "run-0123456789abcdef01234567";
const recipe: WorkbenchRecipe = {
  schema_version: "v1",
  name: "fast-agent",
  setup_command: "printf ready",
  run_command: "run-agent",
  route_api: "chat-completions",
  setup_timeout_seconds: 60,
  environment: [
    { name: "MODEL_BASE_URL", source: "model_base_url" },
    { name: "OPENAI_API_KEY", source: "model_api_key" },
  ],
  outputs: {
    results_path: "/logs/agent/results.json",
    trajectory_path: "/logs/agent/trajectory.json",
  },
};
const preview: WorkbenchPreview = {
  recipe,
  recipe_digest: "a".repeat(64),
  revision_id: "agent-recipe-0123456789abcdef01234567",
  setup_command: "printf ready",
  run_command: "run-agent",
  environment: [
    {
      name: "MODEL_BASE_URL",
      source: "model_base_url",
      value: "<injected-model-base-url>",
      redacted: false,
    },
    {
      name: "OPENAI_API_KEY",
      source: "model_api_key",
      value: "<injected-model-api-key>",
      redacted: true,
    },
  ],
  harbor_agent: {
    import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
    override_setup_timeout_sec: 60,
    kwargs: { config: { schema_version: "v1" } },
  },
  warnings: [],
};
const setup: WorkbenchSetup = {
  setup_test_id: "workbench-setup-0123456789abcdef01234567",
  recipe_digest: preview.recipe_digest,
  revision_id: preview.revision_id,
  status: "passed",
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:01Z",
  completed_at: "2026-01-01T00:00:02Z",
  exit_code: 0,
  error: null,
  files: [],
};
const system: SystemResponse = {
  source_revision: "source-revision",
  harbor_revision: "harbor-revision",
  write_mode: "enabled",
  ready: true,
  projection: { runs: 1, trials: 1, parent_jobs: 1 },
  capacity: { max_active_parent_jobs: 16 },
  workbench: { runner: "hf-jobs", setup_enabled: true },
  resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
};
const presets: PresetsResponse = {
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
const run: RunView = {
  record: {
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
    harbor_job_config: { job_name: "job" },
  },
  state: {
    schema_version: "v1",
    run_id: runId,
    revision: 1,
    updated_at: "2026-01-01T00:00:02Z",
    desired_state: "run",
    actor: "test-operator",
    parent_jobs: [{ id: "job-parent-one", started_at: "2026-01-01T00:00:01Z" }],
  },
  status: "running",
  result: {
    n_total_trials: 1,
    stats: {
      n_completed_trials: 1,
      n_errored_trials: 0,
      n_cancelled_trials: 0,
      n_retries: 0,
      n_input_tokens: 120,
      n_output_tokens: 40,
      cost_usd: 0.12,
      evals: { reward: { metrics: [{ mean: 1 }] } },
    },
  },
};
const trial: TrialDetail = {
  run_id: runId,
  trial_name: "task-one__trial-one",
  reward: 1,
  cost_usd: 0.12,
  status: "completed",
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

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  apiMocks.getSession.mockResolvedValue({
    authenticated: true,
    actor: { username: "test-operator", role: "operator", transport: "development" },
  });
  apiMocks.getSystem.mockResolvedValue(system);
  apiMocks.getPresets.mockResolvedValue(presets);
  apiMocks.getModelProviders.mockResolvedValue({
    model: "publisher/new-model",
    providers: ["provider"],
  });
  apiMocks.getLeaderboard.mockResolvedValue([
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
  ]);
  apiMocks.getRuns.mockResolvedValue([run]);
  apiMocks.getRun.mockResolvedValue(run);
  apiMocks.getTrialProgress.mockResolvedValue({
    observed_at: new Date().toISOString(),
    jobs_observed_at: null,
    lock: null,
    trials: [],
    jobs: [],
  });
  apiMocks.getTrials.mockResolvedValue([
    {
      run_id: runId,
      trial_name: trial.trial_name,
      reward: trial.reward,
      cost_usd: trial.cost_usd,
      status: trial.status,
    },
  ]);
  apiMocks.getTrial.mockResolvedValue(trial);
  apiMocks.getJobs.mockResolvedValue([
    {
      id: "job-parent-one",
      run_id: runId,
      role: "parent",
      stage: "running",
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:00:01Z",
      finished_at: null,
    },
  ]);
  apiMocks.actOnRun.mockResolvedValue(run.state);
  apiMocks.submitRun.mockResolvedValue({ created: true, run: run.record });
  apiMocks.listWorkbenchSetups.mockResolvedValue([]);
  apiMocks.previewWorkbenchRecipe.mockResolvedValue(preview);
  apiMocks.startWorkbenchSetup.mockResolvedValue(setup);
  apiMocks.getWorkbenchSetup.mockResolvedValue(setup);
  apiMocks.getWorkbenchLogs.mockResolvedValue({ stdout: "setup ready\n", stderr: "" });
  apiMocks.signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("restored control console", () => {
  it("shows the public leaderboard without private navigation", async () => {
    apiMocks.getSession.mockResolvedValue({
      authenticated: false,
      login_url: "/auth/login",
    });
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Leaderboard" })).toBeVisible();
    expect(await screen.findByText("publisher/model")).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth/login?return_to=%2F",
    );
    expect(screen.queryByRole("link", { name: "Workbench" })).not.toBeInTheDocument();
  });

  it("restores authenticated navigation and overview submission", async () => {
    const user = userEvent.setup();
    renderAt("/overview");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
    for (const name of ["Leaderboard", "Overview", "Workbench", "Runs", "Jobs"])
      expect(screen.getAllByRole("link", { name }).length).toBeGreaterThan(0);
    expect(screen.getByText("Maximum active parent Jobs")).toBeVisible();
    const model = await screen.findByLabelText("Model");
    expect(
      screen.getByRole("combobox", { name: /^Benchmark preset/ }),
    ).toHaveTextContent("terminal-bench-2-1 · one-task-1-trial");
    expect(
      screen.getByText("Hardware: CPU Upgrade · 1 attempt · 1 concurrent trial"),
    ).toBeVisible();

    expect(screen.getByLabelText("Provider")).toBeDisabled();
    const concurrentTrials = screen.getByLabelText("Concurrent trials");
    expect(concurrentTrials).toHaveValue(1);
    await user.type(model, "publisher/new-model");
    await user.tab();
    await waitFor(() =>
      expect(apiMocks.getModelProviders).toHaveBeenCalledWith("publisher/new-model"),
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "provider");
    await user.clear(concurrentTrials);
    await user.type(concurrentTrials, "4");
    await user.click(screen.getByRole("button", { name: "Submit run" }));
    await waitFor(() => expect(apiMocks.submitRun).toHaveBeenCalledOnce());
    expect(apiMocks.submitRun.mock.calls[0]?.[0]).toMatchObject({
      benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
      model: { id: "publisher/new-model", provider: "provider" },
      harness: { agent: "pi", version: "0.84.4" },
      n_concurrent_trials: 4,
    });
    expect(await screen.findByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      `/runs/${runId}`,
    );
  });

  it.each(["/runs", "/runs?view=waffle", "/runs?view=list"])(
    "keeps %s a list with counts and no progress requests",
    async (path) => {
      renderAt(path);
      expect(
        await screen.findByRole("columnheader", { name: "Progress" }),
      ).toBeVisible();
      expect(screen.getByText("1 / 1")).toBeVisible();
      expect(
        screen.queryByRole("region", { name: "Trial progress waffle" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Waffle" })).not.toBeInTheDocument();
      expect(apiMocks.getTrialProgress).not.toHaveBeenCalled();
      await userEvent.setup().click(screen.getByRole("link", { name: /^Unavailable/ }));
      const waffle = await screen.findByRole("region", {
        name: "Trial progress waffle",
      });
      expect(apiMocks.getTrialProgress).toHaveBeenCalledWith(runId);
      expect(
        waffle.compareDocumentPosition(screen.getByText("Run identity")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it("shows complete run detail and targets run actions", async () => {
    const user = userEvent.setup();
    renderAt(`/runs/${runId}`);
    expect(await screen.findByRole("heading", { name: "Run detail" })).toBeVisible();
    expect(screen.getByText("Run identity")).toBeVisible();
    expect(screen.getByText("Harbor totals")).toBeVisible();
    expect(screen.getByRole("link", { name: trial.trial_name })).toHaveAttribute(
      "href",
      `/runs/${runId}/trials/${trial.trial_name}`,
    );
    expect(screen.getByText("job-parent-one")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiMocks.actOnRun).toHaveBeenCalledWith(runId, "pause"));
  });

  it("renders trial evidence as text instead of HTML", async () => {
    apiMocks.getTrial.mockResolvedValue({
      ...trial,
      result: { ...trial.result, trajectory: "<script>unsafe()</script>" },
    });
    renderAt(`/runs/${runId}/trials/${trial.trial_name}`);
    expect(await screen.findByRole("heading", { name: "Trial detail" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Verifier result" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Trajectory" })).toBeVisible();
    expect(screen.getByText("<script>unsafe()</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });

  it("runs the Workbench configure, setup, and standard Harbor submission flow", async () => {
    const user = userEvent.setup();
    renderAt("/workbench");
    expect(
      await screen.findByRole("heading", { name: "Agent Workbench" }),
    ).toBeVisible();
    expect(screen.getByText("Configure → Test → Run")).toBeVisible();
    await waitFor(() => expect(apiMocks.previewWorkbenchRecipe).toHaveBeenCalled());

    await user.click(
      screen.getByLabelText(
        "Start one disposable CPU setup test for this exact recipe.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Run setup test" }));
    expect(await screen.findByText("Setup passed")).toBeVisible();
    expect(await screen.findByText("setup ready")).toBeVisible();

    const runCard =
      screen.getByRole("heading", { name: "3. Run with Harbor" }).closest("section") ??
      screen.getByRole("heading", { name: "3. Run with Harbor" }).parentElement
        ?.parentElement;
    expect(runCard).not.toBeNull();
    const scope = within(runCard as HTMLElement);
    await user.type(
      scope.getByLabelText("Recorded model"),
      "publisher/workbench-model",
    );
    expect(scope.getByLabelText("Concurrent trials")).toHaveValue(1);
    await user.clear(scope.getByLabelText("Concurrent trials"));
    await user.type(scope.getByLabelText("Concurrent trials"), "12");
    await user.type(scope.getByLabelText("Recorded provider (optional)"), "together");
    await user.clear(scope.getByLabelText("Recorded provider (optional)"));
    await user.type(
      scope.getByLabelText("Harness model string"),
      "hf.publisher/runtime-model:together",
    );
    await user.click(
      scope.getByLabelText(
        "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
      ),
    );
    await user.click(scope.getByRole("button", { name: "Launch Harbor run" }));
    await waitFor(() => expect(apiMocks.submitRun).toHaveBeenCalledOnce());
    expect(apiMocks.submitRun.mock.calls[0]?.[0]).toMatchObject({
      n_concurrent_trials: 12,
      model: {
        id: "publisher/workbench-model",
        provider: "unspecified",
        reasoning_effort: "off",
      },
      workbench: {
        setup_test_id: setup.setup_test_id,
        harbor_agent: { model_name: "hf.publisher/runtime-model:together" },
      },
    });
  });

  it.each(["/overview", "/workbench"])(
    "uses the same concurrency field and preset defaults at %s",
    async (path) => {
      const user = userEvent.setup();
      const first = presets.benchmarks[0];
      if (!first) throw new Error("missing test preset");
      apiMocks.getPresets.mockResolvedValue({
        ...presets,
        benchmarks: [
          first,
          {
            ...first,
            preset: "all-tasks-1-trial",
            job: { ...first.job, n_concurrent_trials: 8 },
          },
        ],
      });
      renderAt(path);
      const field = await screen.findByLabelText("Concurrent trials");
      expect(field).toHaveValue(1);
      await user.clear(field);
      await user.type(field, "16");
      expect(field).toHaveValue(16);
      await user.selectOptions(
        screen.getByRole("combobox", { name: /^Benchmark preset/ }),
        "terminal-bench-2-1\nall-tasks-1-trial",
      );
      expect(field).toHaveValue(8);
      await user.selectOptions(
        screen.getByRole("combobox", { name: /^Benchmark preset/ }),
        "terminal-bench-2-1\none-task-1-trial",
      );
      expect(field).toHaveValue(1);
    },
  );

  it("keeps binding inputs mounted while renaming, changing source and deleting rows", async () => {
    const user = userEvent.setup();
    renderAt("/workbench");
    const first = await screen.findByLabelText("Binding 1 name");
    const second = screen.getByLabelText("Binding 2 name");
    await user.clear(second);
    await user.type(second, "RENAMED_KEY");
    expect(second).toHaveFocus();
    expect(second).toHaveValue("RENAMED_KEY");
    expect(screen.getByLabelText("Binding 2 name")).toBe(second);
    await user.selectOptions(screen.getByLabelText("Binding 2 source"), "literal");
    expect(screen.getByLabelText("Binding 2 name")).toBe(second);
    await user.clear(first);
    await user.type(first, "RENAMED_KEY");
    // Duplicate/incomplete names must remain independently editable.
    expect(screen.getByLabelText("Binding 1 name")).toBe(first);
    expect(screen.getByLabelText("Binding 2 name")).toBe(second);
    await user.click(
      screen.getAllByRole("button", { name: "Remove binding RENAMED_KEY" })[0],
    );
    expect(screen.getByLabelText("Binding 1 name")).toBe(second);
    await user.click(second);
    await user.keyboard("{End}_MORE");
    expect(second).toHaveFocus();
    expect(second).toHaveValue("RENAMED_KEY_MORE");
  });

  it.each(["pagehide", "visibilitychange"])(
    "flushes pending draft edits on %s",
    async (event) => {
      const user = userEvent.setup();
      renderAt("/workbench");
      const name = await screen.findByLabelText("Recipe name");
      await user.clear(name);
      await user.type(name, "pagehide-draft");
      if (event === "visibilitychange") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event(event));
      } else {
        window.dispatchEvent(new Event(event));
      }
      expect(
        JSON.parse(
          window.localStorage.getItem("harbor-hf.workbench.draft.v1") ?? "null",
        ).recipe.name,
      ).toBe("pagehide-draft");
    },
  );

  it("restores a Workbench draft without restoring approval state", async () => {
    const user = userEvent.setup();
    const view = renderAt("/workbench");
    const name = await screen.findByLabelText("Recipe name");
    await user.clear(name);
    await user.type(name, "recovered-draft");
    view.unmount();

    renderAt("/workbench");
    expect(await screen.findByLabelText("Recipe name")).toHaveValue("recovered-draft");
    expect(
      screen.getByLabelText(
        "Start one disposable CPU setup test for this exact recipe.",
      ),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText(
        "Launch this exact tested recipe and accept the displayed per-trial cost limit.",
      ),
    ).not.toBeChecked();
  });

  it("keeps unknown authenticated routes inside the restored shell", async () => {
    renderAt("/missing");
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to overview" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Workbench" }).length).toBeGreaterThan(
      0,
    );
  });
});
