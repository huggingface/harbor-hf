// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "../../../packages/control-core/src/workbench";
import App from "../src/App";
import { ApiError, type SessionResponse } from "../src/api";
import { loginHref } from "../src/layout";
import { formatExactMoney, formatMoney } from "../src/lib";
import { keys } from "../src/queries";

const reviewedFastAgentPreview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function session(username = "test-user"): SessionResponse {
  return {
    authenticated: true,
    expires_at: "2026-08-18T12:00:00.000Z",
    actor: { username, role: "operator", transport: "development" },
  };
}

function system(writeMode: "disabled" | "enabled" = "enabled") {
  return {
    source_revision: "revision-0123456789abcdef",
    write_mode: writeMode,
    initialization: { ready: true, status: "ready" },
    projection: {
      ready: true,
      rebuilding: false,
      object_count: 4,
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

function launchProfiles() {
  const createdAt = "2026-08-16T00:00:00.000Z";
  const approved = (alias: string, kind: string, spec: Record<string, unknown>) => ({
    source: "built-in",
    promotion_state: "approved",
    alias,
    approved_aliases: [alias],
    created_at: createdAt,
    profile_id: `sha256:${kind}-${alias}`,
    profile_kind: kind,
    name: alias,
    spec,
  });
  return {
    items: [
      approved("control-smoke", "benchmark", { task_ids: ["task-001"] }),
      approved("terminal-bench-2-1-canary", "benchmark", {
        benchmark: "terminal-bench-2-1",
        task_ids: ["task-a", "task-b"],
        source_task_ids: ["task-a", "task-b"],
        trial_indices: [1, 1],
        harbor_job: { datasets: [{ path: "tasks" }] },
      }),
      approved("gpt-oss-20b", "model", {
        model_id: "openai/gpt-oss-20b",
        revision: "6cee5e81ee83917806bbde320786a8fb61efebee",
      }),
      approved("opencode", "harness", {
        agent: "opencode",
        reasoning_effort: "off",
      }),
      approved("fast-agent-0-10-16-command", "harness", {
        ...reviewedFastAgentPreview.harness_profile,
      }),
      approved("tb21-gpt-oss-20b-opencode-providers", "deployment", {
        route: "hf_job",
        models: ["gpt-oss-20b"],
        harnesses: ["opencode"],
        preparation: "required",
        trial_job_template: {
          inference_upstream: "https://router.huggingface.co/v1",
        },
      }),
      approved("tb21-gpt-oss-20b-command-providers", "deployment", {
        route: "hf_job",
        models: ["gpt-oss-20b"],
        harnesses: ["fast-agent-0-10-16-command"],
        preparation: "required",
        inference_provider: "together",
        trial_job_template: {
          inference_upstream: "https://router.huggingface.co/v1",
        },
      }),
      approved("tb21-gpt-oss-20b-opencode-endpoint", "deployment", {
        route: "hf_job",
        models: ["gpt-oss-20b"],
        harnesses: ["opencode"],
        trial_job_template: {
          inference_upstream: "https://endpoint.example.test/v1",
        },
      }),
      approved("tb21-diagnostic-1", "launch_policy", {
        max_infrastructure_attempts: 2,
        reservation_microusd: 5_100_000,
        publication_role: "diagnostic",
      }),
      approved("control-smoke", "model", { revision: "sha256:model" }),
      approved("control-smoke", "harness", { agent: "control-smoke" }),
      approved("hf-cpu-smoke", "deployment", {
        models: ["control-smoke"],
        harnesses: ["control-smoke"],
        hardware: "cpu-basic",
      }),
      approved("control-smoke", "launch_policy", {
        max_infrastructure_attempts: 1,
        reservation_microusd: 0,
        publication_role: "diagnostic",
      }),
    ],
    next_cursor: null,
  };
}

function stubLaunchPage(
  onSubmit?: (value: Record<string, unknown>) => void,
  profiles = launchProfiles(),
) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("auth/session")) return json(session());
      if (path.includes("/system")) return json(system());
      if (path.endsWith("/api/v1/runs") && init?.method === "POST") {
        onSubmit?.(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Promise<Response>(() => undefined);
      }
      if (path.includes("/runs")) return json({ items: [], next_cursor: null });
      if (path.includes("/profiles")) return json(profiles);
      throw new Error(`unexpected request: ${path}`);
    }),
  );
}

function renderApp(path = "/", client?: QueryClient) {
  const queryClient =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client: queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("control web", () => {
  it("builds an OAuth guard for an admin path", () => {
    expect(loginHref("/results")).toBe("/auth/login?return_to=%2Fresults");
  });

  it("previews and verifies a Workbench setup without rendering hostile output", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let hostedSubmission: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/workbench/preview")) {
          return json(compileAgentWorkbenchRecipe(JSON.parse(String(init?.body))));
        }
        if (path.endsWith("/api/v1/workbench/benchmark-configs"))
          return json({
            items: [
              {
                name: "tb21-gpt-oss-20b-canary",
                revision: `sha256:${"1".repeat(64)}`,
                label: "Terminal-Bench 2.1 canary · GPT-OSS 20B",
                description: "Reviewed hosted canary.",
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
          });
        if (path.endsWith("/api/v1/workbench/local-runs/options"))
          return json({
            enabled: true,
            ready: true,
            reason: null,
            benchmark: "terminal-bench-2-1-canary",
            model: "gpt-oss-20b-together",
            task_names: ["adaptive-rejection-sampler", "modernize-scientific-stack"],
            harbor_version: "0.22.0",
            expected_harbor_version: "0.22.0",
          });
        if (path.endsWith("/api/v1/workbench/local-runs") && init?.method !== "POST")
          return json([]);
        if (path.endsWith("/api/v1/workbench/local-runs/preview"))
          return json({
            config: {
              job_name: "local-preview",
              datasets: [
                {
                  task_names: ["adaptive-rejection-sampler"],
                },
              ],
              agents: [
                {
                  import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
                },
              ],
            },
          });
        if (path.endsWith("/api/v1/workbench/local-runs") && init?.method === "POST")
          return json(
            {
              local_run_id: "local-run-one",
              recipe_digest: reviewedFastAgentPreview.recipe_digest,
              status: "succeeded",
              benchmark: "terminal-bench-2-1-canary",
              model: "gpt-oss-20b-together",
              task_names: ["adaptive-rejection-sampler"],
              created_at: "2026-08-27T00:00:03.000Z",
              started_at: "2026-08-27T00:00:03.000Z",
              completed_at: "2026-08-27T00:00:04.000Z",
              exit_code: 0,
              error: null,
              config_path: "/tmp/local-run-one/config.json",
              result_path: "/tmp/local-run-one/result.json",
              command: ["harbor", "run"],
            },
            202,
          );
        if (path.endsWith("/local-run-one/logs"))
          return json({ stdout: "Harbor complete\n", stderr: "" });
        if (path.endsWith("/api/v1/workbench/setup-tests") && init?.method === "POST")
          return json(
            {
              setup_test_id: "setup-test-one",
              recipe_digest: reviewedFastAgentPreview.recipe_digest,
              revision_id: reviewedFastAgentPreview.revision_id,
              status: "passed",
              created_at: "2026-08-27T00:00:00.000Z",
              started_at: "2026-08-27T00:00:01.000Z",
              completed_at: "2026-08-27T00:00:02.000Z",
              exit_code: 0,
              error: null,
              files: [
                {
                  file_id: "workbench-file-one",
                  path: "hostile.txt",
                  root: "workspace",
                  size: 31,
                  text: true,
                },
              ],
            },
            202,
          );
        if (path.endsWith("/setup-test-one/logs"))
          return json({ stdout: "fast-agent-mcp v0.10.16\n", stderr: "" });
        if (path.endsWith("/files/workbench-file-one"))
          return json({
            content: "<script>window.compromised = true</script>",
            truncated: false,
          });
        if (path.endsWith("/api/v1/runs") && init?.method === "POST") {
          hostedSubmission = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json(
            {
              run_id: "run-hosted",
              action_id: "action-hosted",
              status_url: "/api/v1/runs/run-hosted",
              adopted: false,
            },
            202,
          );
        }
        if (path.includes("/profiles")) return json(launchProfiles());
        if (path.includes("/runs")) return json({ items: [], next_cursor: null });
        if (path.includes("/events")) throw new Error("offline");
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const view = renderApp("/workbench");
    expect(
      await screen.findByRole("heading", { name: "Agent Workbench" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Configure → Test → Run" }),
    ).toBeVisible();
    expect(await screen.findByText("Preview ready")).toBeVisible();
    expect(screen.getByRole("button", { name: "FX 0.0.6" })).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Inference API" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Environment variable OPENAI_API_KEY source"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Environment variable MODEL_BASE_URL source"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("adaptive-rejection-sampler")).toBeVisible();
    expect(await screen.findByText(/"job_name": "local-preview"/)).toBeVisible();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Configuration name"));
    await user.type(screen.getByLabelText("Configuration name"), "recovered-draft");
    view.unmount();
    renderApp("/workbench");
    expect(await screen.findByLabelText("Configuration name")).toHaveValue(
      "recovered-draft",
    );
    expect(
      screen.getByRole("checkbox", { name: /launch this exact setup recipe/i }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "FX 0.0.6" }));
    expect(screen.getByLabelText("Configuration name")).toHaveValue("fx");
    expect(
      (screen.getByLabelText("Setup command") as HTMLTextAreaElement).value,
    ).toContain(["https://releases.fx.sh/v", "$", "{fx_version}", "/"].join(""));
    expect(
      await screen.findByText(/FX 0\.0\.6 expects Vercel AI Gateway semantics/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /start local benchmark/i }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Fast-Agent 0.10.16" }));
    expect(screen.getByLabelText("Configuration name")).toHaveValue("fast-agent");
    await user.click(
      screen.getByRole("checkbox", {
        name: /launch this exact setup recipe/i,
      }),
    );
    const launchSetup = screen.getByRole("button", {
      name: /launch setup test/i,
    });
    await waitFor(() => expect(launchSetup).toBeEnabled());
    await user.click(launchSetup);
    expect(await screen.findByText("passed")).toBeVisible();
    expect(screen.getByText(/This does not verify hosted/)).toBeVisible();
    expect(await screen.findByText(/fast-agent-mcp v0.10.16/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /hostile.txt/i }));
    expect(
      await screen.findByText("<script>window.compromised = true</script>"),
    ).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    await user.click(
      screen.getByRole("checkbox", {
        name: /start harbor locally with this exact recipe/i,
      }),
    );
    const startLocal = screen.getByRole("button", {
      name: /start local benchmark/i,
    });
    await waitFor(() => expect(startLocal).toBeEnabled());
    await user.click(startLocal);
    expect(await screen.findByText("succeeded")).toBeVisible();
    expect(await screen.findByText(/Harbor complete/)).toBeVisible();
    await user.click(
      screen.getByRole("checkbox", {
        name: /i confirm this exact tested recipe/i,
      }),
    );
    const startHosted = screen.getByRole("button", {
      name: /start hosted run/i,
    });
    await waitFor(() => expect(startHosted).toBeEnabled());
    await user.click(startHosted);
    await waitFor(() =>
      expect(hostedSubmission).toMatchObject({
        benchmark_config: "tb21-gpt-oss-20b-canary",
        harness: {
          type: "workbench",
          recipe: fastAgentWorkbenchStarter,
          setup_test_id: "setup-test-one",
        },
        ceiling_microusd: 1_000_000,
        confirmed: true,
      }),
    );
  });

  it("tails a running Workbench setup and confirms cancellation", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/workbench/preview")) {
          const recipe = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({
            recipe,
            recipe_digest: "sha256:running-recipe",
            revision_id: "agent-recipe-running",
            setup_command: "install agent",
            run_command: "run agent",
            environment: [],
            harness_profile: { agent: "command-agent" },
            warnings: [],
          });
        }
        if (path.endsWith("/api/v1/workbench/setup-tests") && init?.method === "POST")
          return json(
            {
              setup_test_id: "setup-test-running",
              recipe_digest: "sha256:running-recipe",
              revision_id: "agent-recipe-running",
              status: "running",
              created_at: "2026-08-27T00:00:00.000Z",
              started_at: "2026-08-27T00:00:01.000Z",
              completed_at: null,
              exit_code: null,
              error: null,
              files: [],
            },
            202,
          );
        if (path.endsWith("/setup-test-running/cancel") && init?.method === "POST") {
          cancelled = true;
          expect(JSON.parse(String(init.body))).toEqual({ confirmed: true });
          return json({
            setup_test_id: "setup-test-running",
            recipe_digest: "sha256:running-recipe",
            revision_id: "agent-recipe-running",
            status: "cancelling",
            created_at: "2026-08-27T00:00:00.000Z",
            started_at: "2026-08-27T00:00:01.000Z",
            completed_at: null,
            exit_code: null,
            error: null,
            files: [],
          });
        }
        if (path.endsWith("/setup-test-running/logs"))
          return json({
            stdout: "Downloading agent package 3/10\n",
            stderr: "",
          });
        if (path.includes("/events")) throw new Error("offline");
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderApp("/workbench");
    expect(await screen.findByText("Preview ready")).toBeVisible();
    const user = userEvent.setup();
    const confirmation = screen.getByRole("checkbox", {
      name: /launch this exact setup recipe/i,
    });
    await user.click(confirmation);
    await user.click(screen.getByRole("button", { name: /launch setup test/i }));

    expect(await screen.findByText("Setup submitted")).toBeVisible();
    expect(confirmation).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Live setup output")).toHaveTextContent(
      "Downloading agent package 3/10",
    );
    expect(
      screen.queryByLabelText("Final setup standard output"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancelled).toBe(true);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });

  it("shows only the username and sign-out control in account chrome", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session("visible-user"));
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/capacity")) return json(infrastructureCapacity());
        if (path.includes("/runs")) return json({ items: [], next_cursor: null });
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/overview");
    expect(await screen.findByText("visible-user")).toBeInTheDocument();
    expect(screen.queryByText("opaque-oauth-subject")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Account and session details" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("keeps the overview session during a projection rebuild", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/capacity")) return json(infrastructureCapacity());
        if (path.includes("/runs")) return json({ items: [], next_cursor: null });
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.session, session("cached-user"));
    renderApp("/overview", client);
    expect(await screen.findByText("cached-user")).toBeInTheDocument();

    act(() => {
      const query = client.getQueryCache().find({ queryKey: keys.session });
      if (!query) throw new Error("session query is missing");
      query.setState({
        ...query.state,
        error: new ApiError(
          503,
          "control_not_ready",
          "projection is rebuilding",
          "safe-request-id",
        ),
        status: "error",
        fetchStatus: "idle",
      });
    });

    expect(await screen.findByText("Showing saved data")).toBeInTheDocument();
    expect(screen.getByText("cached-user")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /sign in with hugging face/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument();
    expect(screen.getByText(/safe-request-id/)).toBeInTheDocument();
  });

  it("labels both axes and shows exact spend on chart hover", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system("enabled"));
        if (path.endsWith("/api/v1/capacity")) return json(infrastructureCapacity());
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        if (path.includes("/runs"))
          return json({
            items: [
              {
                run_id: "run-newer",
                status: "completed",
                terminal_tasks: 2,
                successful_tasks: 2,
                total_tasks: 2,
                observed_microusd: 50_000,
                ceiling_microusd: 1_000_000,
                created_at: "2026-08-21T21:00:00.000Z",
              },
              {
                run_id: "run-older",
                status: "completed",
                terminal_tasks: 1,
                successful_tasks: 1,
                total_tasks: 1,
                observed_microusd: 10_123,
                ceiling_microusd: 1_000_000,
                created_at: "2026-08-21T20:00:00.000Z",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/overview");
    expect(
      await screen.findByRole("img", {
        name: /observed run spend in usd, from oldest run to newest/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Observed spend (USD)")).toBeInTheDocument();
    expect(screen.getByText("Runs, oldest to newest")).toBeInTheDocument();
    expect(screen.getByText(formatMoney(50_000))).toBeInTheDocument();
    await user.hover(screen.getByLabelText("run-older observed spend"));
    expect(
      screen.getByText(`Observed spend: ${formatExactMoney(10_123)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Job infrastructure" }),
    ).toBeInTheDocument();
    expect(screen.getByText("112/128")).toBeInTheDocument();
    expect(screen.getByText("Per-run reservations (7)")).toBeInTheDocument();
    expect(screen.getAllByText("16/16 reserved, 0 available")).toHaveLength(7);
    expect(
      screen.getByText(/82 reserved slots do not currently have/i),
    ).toBeInTheDocument();
  });

  it("disables mutation controls when deployment writes are disabled", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system("disabled"));
        if (path.includes("/runs")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs");
    expect(await screen.findByRole("button", { name: "Start a run" })).toBeDisabled();
    expect(screen.getByText("Disabled", { exact: true })).toBeInTheDocument();
  });

  it("labels local execution without enabling hosted writes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system"))
          return json({
            ...system("disabled"),
            source_revision: "development",
          });
        if (path.includes("/runs")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs");
    expect(await screen.findByRole("button", { name: "Start a run" })).toBeDisabled();
    expect(screen.getByText("Execution mode")).toBeInTheDocument();
    expect(screen.getByText("Local", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Disabled", { exact: true })).not.toBeInTheDocument();
  });

  it("requires a separate acknowledgement before run cancellation", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-1"))
          return json({
            run_id: "run-1",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "active",
            publication_status: null,
            total_tasks: 3,
            terminal_tasks: 1,
            successful_tasks: 1,
            pending_actions: 1,
            observed_microusd: 1_000_000,
            reserved_microusd: 2_000_000,
            ceiling_microusd: 3_000_000,
            cleanup_pending: true,
          });
        if (path.includes("/api/v1/runs/run-1/tasks"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /cancel run/i }));
    const confirm = screen.getByRole("button", { name: /confirm cancellation/i });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
  });

  it.each([
    [0, "preparation"],
    [12, "preparation"],
    [0, "execution"],
  ] as const)(
    "uses Job role with %i locked tasks and %s worker",
    async (totalTasks, workerRole) => {
      vi.stubGlobal("EventSource", FakeEventSource);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const path = String(input);
          if (path.includes("auth/session")) return json(session());
          if (path.includes("/system")) return json(system());
          if (path.endsWith("/api/v1/runs/run-prep"))
            return json({
              run_id: "run-prep",
              created_at: "2026-08-18T00:00:00.000Z",
              status: "failed",
              total_tasks: totalTasks,
              terminal_tasks: 0,
              successful_tasks: 0,
              admissible_tasks: 0,
              exhausted_tasks: 0,
              invalid_selected_tasks: 0,
              pending_actions: 0,
              observed_microusd: 0,
              reserved_microusd: 0,
              ceiling_microusd: 1000000,
              cleanup_pending: false,
              publication_status: null,
            });
          if (path.includes("/jobs"))
            return json({
              items: [
                {
                  action_id: "observe-prep",
                  launch_action_id: "launch-prep",
                  worker_role: workerRole,
                  run_id: "run-prep",
                  action_kind: "job.observe",
                  generation: 0,
                  target: "job-prep",
                  outcome: "completed",
                  observed_state: "ERROR",
                  resource_id: "job-prep",
                  inspect_url: "https://huggingface.co/jobs/test/job-prep",
                  created_at: "2026-08-18T00:00:00.000Z",
                  assigned_tasks: 0,
                  cost_microusd: 0,
                },
              ],
              next_cursor: null,
            });
          if (path.includes("/tasks")) return json({ items: [], next_cursor: null });
          throw new Error("unavailable");
        }),
      );
      renderApp("/runs/run-prep");
      await screen.findByRole("columnheader", { name: /Action outcome/ });
      if (workerRole === "execution") {
        expect(
          screen.queryByRole("heading", { name: "Hosted preparation" }),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("link", { name: "Preparation Job logs" }),
        ).not.toBeInTheDocument();
        return;
      }
      expect(
        await screen.findByRole("heading", { name: "Hosted preparation" }),
      ).toBeVisible();
      expect(screen.queryByText(/No logical tasks are locked/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Preparation Job logs" }),
      ).toHaveAttribute("href", "https://huggingface.co/jobs/test/job-prep");
      expect(
        await screen.findByRole("columnheader", { name: /Action outcome/ }),
      ).toBeVisible();
      expect(screen.getAllByText(/ERROR/).length).toBeGreaterThan(0);
      expect(
        screen.getByRole("link", { name: /Open Hugging Face Job/ }),
      ).toHaveAttribute("href", "https://huggingface.co/jobs/test/job-prep");
    },
  );

  it("shows a replacement Job on the existing run instead of a new row", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-1"))
          return json({
            run_id: "run-1",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "completed-invalid",
            publication_status: "published",
            total_tasks: 89,
            terminal_tasks: 89,
            successful_tasks: 13,
            pending_actions: 7,
            observed_microusd: 632_853,
            reserved_microusd: 5_607_849,
            ceiling_microusd: 10_600_000,
            cleanup_pending: false,
            admissible_tasks: 13,
            exhausted_tasks: 0,
            invalid_selected_tasks: 89,
            replacement_assigned_tasks: 75,
            replacement_recorded_tasks: 21,
          });
        if (path.includes("/api/v1/runs/run-1/tasks"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/api/v1/jobs"))
          return json({
            items: [
              {
                action_id: "action-job-retry",
                run_id: "run-1",
                action_kind: "job.observe",
                generation: 1,
                target: "job-retry",
                outcome: "completed",
                observed_state: "RUNNING",
                resource_id: "job-retry",
                inspect_url: "https://huggingface.co/jobs/test/job-retry",
                created_at: "2026-08-22T22:37:55.000Z",
                cost_microusd: 0,
                assigned_tasks: 75,
              },
            ],
            next_cursor: null,
          });
        if (path.includes("/capacity"))
          return json({
            run_active: 1,
            run_limit: 8,
            namespace_active: 1,
            namespace_limit: 8,
            queued: 2,
            cleanup_held: 0,
            limiting_factor: null,
            start_burst: 4,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-1");
    expect(await screen.findByText("Replacement in progress")).toBeInTheDocument();
    expect(screen.getByText("Replacement Jobs on this Run")).toBeInTheDocument();
    expect(
      screen.getByText(/21 of 75 assigned tasks have a replacement receipt/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 physical Job active, 2 queued admissions/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The task list still shows selected seals/),
    ).toBeInTheDocument();
    expect(screen.getByText("21/75 replacement receipts")).toBeInTheDocument();
    expect(await screen.findByText("75 tasks")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Physical HF Jobs" }),
    ).toBeInTheDocument();
  });

  it("does not classify publication work as replacement recovery", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-1"))
          return json({
            run_id: "run-1",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "publishing",
            publication_status: null,
            total_tasks: 1,
            terminal_tasks: 1,
            successful_tasks: 1,
            pending_actions: 1,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 1_000,
            cleanup_pending: true,
            admissible_tasks: 1,
            exhausted_tasks: 0,
            invalid_selected_tasks: 0,
            replacement_assigned_tasks: 0,
            replacement_recorded_tasks: 0,
          });
        if (path.includes("/api/v1/runs/run-1/tasks"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/capacity"))
          return json({
            run_active: 0,
            run_limit: 1,
            namespace_active: 0,
            namespace_limit: 1,
            queued: 0,
            cleanup_held: 0,
            limiting_factor: null,
            start_burst: 1,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderApp("/runs/run-1");
    expect(await screen.findByText("Publishing")).toBeInTheDocument();
    expect(screen.queryByText("Replacement in progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Replacement Jobs on this Run")).not.toBeInTheDocument();
  });

  it("shows each attempt's launch action and projected physical Job", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("auth/session")) return json(session());
      if (path.includes("/system")) return json(system());
      if (path.includes("/api/v1/runs/run-1/tasks/control-smoke-task"))
        return json({
          task: {
            run_id: "run-1",
            task_id: "control-smoke-task",
            input_digest: "sha256:aa",
            terminal_outcome: "complete",
            selected_attempt_id: "attempt-1",
          },
          attempts: [
            {
              attempt_id: "attempt-1",
              action_id: "action-job-1",
              run_id: "run-1",
              task_id: "control-smoke-task",
              outcome: "complete",
              replacement_eligible: false,
              cost_microusd: 0,
              metrics: { reward: 1 },
              created_at: "2026-08-18T00:00:00.000Z",
              physical_job: {
                resource_id: "693994e21a39f67af5a41ad0",
                observed_state: "COMPLETED",
                inspect_url:
                  "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
              },
            },
          ],
        });
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/runs/run-1/tasks/control-smoke-task");
    const link = await screen.findByRole("link", {
      name: /693994e21a39f67af5a41ad0/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
    );
    expect(screen.getByText("job.launch action")).toBeInTheDocument();
    expect(screen.getByText("action-job-1")).toBeInTheDocument();
    expect(screen.getByText("Selected result")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/jobs")),
    ).toBe(false);
  });

  it("does not label an attempt without a projected Job as physical", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/runs/run-1/tasks/cancelled-task"))
          return json({
            task: {
              run_id: "run-1",
              task_id: "cancelled-task",
              input_digest: "sha256:aa",
              terminal_outcome: "cancelled",
              selected_attempt_id: null,
            },
            attempts: [
              {
                attempt_id: "attempt-cancelled",
                action_id: "action-cancelled",
                run_id: "run-1",
                task_id: "cancelled-task",
                outcome: "cancelled",
                replacement_eligible: false,
                cost_microusd: 0,
                metrics: {},
                created_at: "2026-08-18T00:00:00.000Z",
                physical_job: null,
              },
            ],
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-1/tasks/cancelled-task");

    expect(await screen.findByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Source action")).toBeInTheDocument();
    expect(screen.queryByText("Physical trial Job attempt 1")).not.toBeInTheDocument();
    expect(screen.queryByText("job.launch action")).not.toBeInTheDocument();
  });

  it("links Jobs to the Hub inspect page", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/jobs"))
          return json({
            items: [
              {
                action_id: "action-job-1",
                run_id: "run-job-1",
                action_kind: "job.launch",
                generation: 1,
                target: "task-1",
                outcome: "created",
                observed_state: "RUNNING",
                resource_id: "693994e21a39f67af5a41ad0",
                inspect_url:
                  "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
                created_at: "2026-08-18T00:00:00.000Z",
                cost_microusd: 1_000_000,
                assigned_tasks: 1,
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/jobs");
    const link = await screen.findByRole("link", {
      name: /693994e21a39f67af5a41ad0/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText(formatMoney(1_000_000))).toBeInTheDocument();
  });

  it("distinguishes queued launches from suppressed Jobs", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/jobs"))
          return json({
            items: [
              {
                action_id: "action-job-queued",
                run_id: "run-job-1",
                action_kind: "job.launch",
                generation: 1,
                target: "task-1",
                outcome: null,
                observed_state: null,
                resource_id: null,
                inspect_url: null,
                created_at: "2026-08-18T00:00:00.000Z",
                cost_microusd: 0,
                assigned_tasks: 1,
              },
              {
                action_id: "action-job-suppressed",
                run_id: "run-job-1",
                action_kind: "job.launch",
                generation: 1,
                target: "task-2",
                outcome: "completed",
                observed_state: "suppressed-cancelled",
                resource_id: null,
                inspect_url: null,
                created_at: "2026-08-18T00:00:01.000Z",
                cost_microusd: 0,
                assigned_tasks: 1,
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderApp("/jobs");

    expect((await screen.findAllByText("Queued")).length).toBeGreaterThan(0);
    expect(screen.getByText("Not created")).toBeInTheDocument();
    expect(screen.getByText("Suppressed Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });

  it("shows run request errors instead of a false not-found state", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-error"))
          return json(
            {
              error: {
                code: "access_denied",
                message: "access denied",
                request_id: "request-run",
              },
            },
            403,
          );
        if (path.includes("/tasks")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-error");
    expect(await screen.findByText("Forbidden")).toBeInTheDocument();
    expect(screen.queryByText("Run not found")).not.toBeInTheDocument();
  });

  it("keeps collection cursors in the URL and loads later pages", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        requests.push(path);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/runs")) {
          const laterPage = path.includes("cursor=cursor-one");
          return json({
            items: [
              {
                run_id: laterPage ? "run-second" : "run-first",
                status: "active",
                terminal_tasks: 0,
                successful_tasks: 0,
                total_tasks: 1,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T00:00:00Z",
              },
            ],
            next_cursor: laterPage ? null : "cursor-one",
          });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs");
    const user = userEvent.setup();

    expect(await screen.findByText("run-first")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("run-second")).toBeInTheDocument();
    expect(requests.some((path) => path.includes("cursor=cursor-one"))).toBe(true);
  });

  it("labels finished runs with sealed failures separately from complete success", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/runs"))
          return json({
            items: [
              {
                run_id: "run-success",
                status: "completed",
                terminal_tasks: 1,
                successful_tasks: 1,
                total_tasks: 1,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T00:00:00Z",
              },
              {
                run_id: "run-timeout",
                status: "completed",
                terminal_tasks: 2,
                successful_tasks: 1,
                total_tasks: 2,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T01:00:00Z",
              },
              {
                run_id: "run-cancelled",
                status: "cancelled",
                terminal_tasks: 2,
                successful_tasks: 1,
                total_tasks: 2,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T02:00:00Z",
              },
              {
                run_id: "run-cancelling",
                status: "cancelling",
                terminal_tasks: 1,
                successful_tasks: 0,
                total_tasks: 2,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T03:00:00Z",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs");
    expect(await screen.findByText("Completed with failures")).toBeInTheDocument();
    expect(screen.getByText("Completed with failures").className).toContain("amber");
    const cancelledBadge = screen
      .getAllByText("Cancelled")
      .find((element) => element.tagName === "SPAN");
    expect(cancelledBadge?.className).toContain("orange");
    const successBadge = screen
      .getAllByText("Completed", { exact: true })
      .find((element) => element.tagName === "SPAN");
    expect(successBadge?.className).toContain("emerald");
    const cancellingBadge = screen
      .getAllByText("Cancelling")
      .find((element) => element.tagName === "SPAN");
    expect(cancellingBadge?.className).toContain("cyan");
  });

  it("explains the cost ceiling on hover", async () => {
    stubLaunchPage();
    renderApp("/runs");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start a run" }));
    expect(
      screen.getByText(/defaults to twice the estimated reservation/i, {
        hidden: true,
      }),
    ).toBeInTheDocument();
  });

  it("keeps deployment routing internal to the simplified run launcher", async () => {
    stubLaunchPage();
    renderApp("/runs");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start a run" }));

    const benchmark = screen.getByRole("combobox", { name: "Benchmark" });
    await waitFor(() => expect(benchmark).toHaveValue("terminal-bench-2-1-canary"));
    expect(screen.queryByRole("combobox", { name: "Runtime" })).not.toBeInTheDocument();
    expect(screen.queryByText("Inference Providers")).not.toBeInTheDocument();
    expect(screen.queryByText("Inference Endpoints")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Control Smoke · 1 task" }),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Launch policy" }),
      "tb21-diagnostic-1",
    );
    expect(screen.getByText("Locked reasoning")).toBeInTheDocument();
    expect(screen.getByText("Locked harness")).toBeInTheDocument();
  });

  it("allows a temporarily invalid selection to reach a disconnected valid combination", async () => {
    const profiles = launchProfiles();
    profiles.items = profiles.items.filter(
      (profile) => !["model", "harness", "deployment"].includes(profile.profile_kind),
    );
    const createdAt = "2026-08-16T00:00:00.000Z";
    const approved = (alias: string, kind: string, spec: Record<string, unknown>) => ({
      source: "built-in",
      promotion_state: "approved",
      alias,
      approved_aliases: [alias],
      created_at: createdAt,
      profile_id: `sha256:${kind}-${alias}`,
      profile_kind: kind,
      name: alias,
      spec,
    });
    profiles.items.push(
      approved("model-a", "model", {
        model_id: "example/model-a",
        revision: "a".repeat(40),
      }),
      approved("model-b", "model", {
        model_id: "example/model-b",
        revision: "b".repeat(40),
      }),
      approved("harness-a", "harness", { agent: "alpha" }),
      approved("harness-b", "harness", { agent: "beta" }),
      approved("deployment-a", "deployment", {
        inference_provider: "provider-a",
        models: ["model-a"],
        harnesses: ["harness-a"],
      }),
      approved("deployment-b", "deployment", {
        inference_provider: "provider-b",
        models: ["model-b"],
        harnesses: ["harness-b"],
      }),
    );
    stubLaunchPage(undefined, profiles);
    renderApp("/runs");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start a run" }));

    const model = screen.getByRole("combobox", { name: "Model" });
    const harness = screen.getByRole("combobox", { name: "Harness" });
    await waitFor(() => {
      expect(model).toHaveValue("model-a");
      expect(harness).toHaveValue("harness-a");
    });

    await user.selectOptions(model, "model-b");
    expect(model).toHaveValue("model-b");
    expect(harness).toHaveValue("harness-a");
    expect(screen.getByRole("combobox", { name: "Benchmark" })).toBeEmptyDOMElement();

    await user.selectOptions(harness, "harness-b");
    await waitFor(() => {
      expect(model).toHaveValue("model-b");
      expect(harness).toHaveValue("harness-b");
    });
    expect(
      screen.getByRole("combobox", { name: "Benchmark" }).querySelectorAll("option"),
    ).not.toHaveLength(0);
  });

  it("requires confirmation and submits the selected promoted launch policy", async () => {
    let submission: Record<string, unknown> | undefined;
    stubLaunchPage((value) => {
      submission = value;
    });
    renderApp("/runs");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start a run" }));
    const launchPolicy = screen.getByRole("combobox", { name: "Launch policy" });
    expect(launchPolicy).toHaveValue("");
    await user.selectOptions(launchPolicy, "control-smoke");
    expect(launchPolicy).toHaveValue("control-smoke");
    const create = screen.getByRole("button", { name: "Start run" });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(create).toBeEnabled();
    await user.selectOptions(launchPolicy, "tb21-diagnostic-1");
    expect(create).toBeDisabled();
    await user.selectOptions(launchPolicy, "control-smoke");
    await user.click(screen.getByRole("checkbox"));
    await user.click(create);
    await waitFor(() => expect(submission).toBeDefined());
    expect(submission?.launch_policy).toBe("control-smoke");
  });

  it("shows the full run name instead of a truncated run id", async () => {
    const runName = "run-gpt-oss-20b-opencode-off-providers-a1b2c3d4e5f6";
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/runs"))
          return json({
            items: [
              {
                run_id: runName,
                status: "queued",
                terminal_tasks: 0,
                successful_tasks: 0,
                total_tasks: 89,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T00:00:00Z",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs");
    const table = await screen.findByRole("table");
    expect(table).toHaveClass("table-fixed");
    expect(table.parentElement).toHaveClass("max-h-[70vh]", "overflow-auto");
    expect(await screen.findByRole("link", { name: runName })).toHaveAttribute(
      "href",
      `/runs/${runName}`,
    );
    expect(screen.queryByText(/run-gpt-oss-20…/)).not.toBeInTheDocument();
  });

  it("keeps run completed distinct from a timed-out task", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-mixed/capacity"))
          return json({
            configured: true,
            profile_id: "sha256:capacity",
            namespace_limit: 8,
            namespace_active: 3,
            run_limit: 4,
            run_active: 2,
            hardware_limit: null,
            hardware_active: 0,
            start_tokens: 1,
            start_burst: 2,
            queued: 1,
            cleanup_held: 0,
            limiting_factor: "namespace_job_capacity",
            not_before: null,
          });
        if (path.endsWith("/api/v1/runs/run-mixed"))
          return json({
            run_id: "run-mixed",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "completed",
            publication_status: "published",
            total_tasks: 2,
            terminal_tasks: 2,
            successful_tasks: 1,
            pending_actions: 0,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 0,
            cleanup_pending: false,
            cancellation_requested: false,
          });
        if (path.includes("/api/v1/runs/run-mixed/tasks"))
          return json({
            items: [
              {
                run_id: "run-mixed",
                task_id: "timeout-task",
                input_digest: "sha256:aa",
                terminal_outcome: "benchmark_timeout",
                selected_attempt_id: "attempt-timeout",
              },
              {
                run_id: "run-mixed",
                task_id: "complete-task",
                input_digest: "sha256:bb",
                terminal_outcome: "complete",
                selected_attempt_id: "attempt-complete",
              },
            ],
            next_cursor: null,
          });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-mixed");
    expect(await screen.findByText("Completed with failures")).toBeInTheDocument();
    expect(
      screen.getByText("Published. 1 sealed task did not succeed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry infrastructure failures" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Scored success").className).toContain("emerald");
    expect(screen.getByText("Timed out").className).toContain("amber");
    expect(screen.getByText("Job capacity")).toBeInTheDocument();
    expect(await screen.findByText("Namespace Job Capacity")).toBeInTheDocument();
    expect(screen.getByText(/3\/8 reserved, 5 available/)).toBeInTheDocument();
    expect(screen.queryByText("Provider requests")).not.toBeInTheDocument();
  });

  it("queues eligible infrastructure retries from a finished run", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const posts: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system("enabled"));
        if (path.endsWith("/api/v1/runs/run-mixed/capacity"))
          return json({
            configured: false,
            profile_id: null,
            namespace_limit: null,
            namespace_active: 0,
            run_limit: 1,
            run_active: 0,
            hardware_limit: null,
            hardware_active: 0,
            start_tokens: null,
            start_burst: null,
            queued: 0,
            cleanup_held: 0,
            limiting_factor: null,
            not_before: null,
          });
        if (path.endsWith("/api/v1/runs/run-mixed/actions")) {
          posts.push({
            path,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          return json(
            {
              run_id: "run-mixed",
              action_id: "action-retry",
              adopted: false,
            },
            202,
          );
        }
        if (path.endsWith("/api/v1/runs/run-mixed"))
          return json({
            run_id: "run-mixed",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "completed",
            publication_status: "published",
            total_tasks: 2,
            terminal_tasks: 2,
            successful_tasks: 1,
            pending_actions: 0,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 0,
            cleanup_pending: false,
            cancellation_requested: false,
          });
        if (path.includes("/api/v1/runs/run-mixed/tasks"))
          return json({
            items: [
              {
                run_id: "run-mixed",
                task_id: "infra-task",
                input_digest: "sha256:aa",
                terminal_outcome: "infrastructure",
                selected_attempt_id: "attempt-infra",
              },
            ],
            next_cursor: null,
          });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-mixed");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Retry infrastructure failures" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm retry" }));
    expect(posts).toEqual([
      {
        path: "/api/v1/runs/run-mixed/actions",
        body: {
          action: "retry_infrastructure",
          task_id: null,
          reason: "retry eligible infrastructure failures",
          confirmed: true,
        },
      },
    ]);
  });

  it("shows cancelled outcomes in orange", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-cancelled/capacity"))
          return json({
            configured: false,
            profile_id: null,
            namespace_limit: null,
            namespace_active: 0,
            run_limit: 1,
            run_active: 0,
            hardware_limit: null,
            hardware_active: 0,
            start_tokens: null,
            start_burst: null,
            queued: 0,
            cleanup_held: 0,
            limiting_factor: "run_cancelled",
            not_before: null,
          });
        if (path.endsWith("/api/v1/runs/run-cancelled"))
          return json({
            run_id: "run-cancelled",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "cancelled",
            publication_status: "published",
            total_tasks: 1,
            terminal_tasks: 1,
            successful_tasks: 0,
            pending_actions: 0,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 0,
            cleanup_pending: false,
            cancellation_requested: true,
          });
        if (path.includes("/api/v1/runs/run-cancelled/tasks"))
          return json({
            items: [
              {
                run_id: "run-cancelled",
                task_id: "cancelled-task",
                input_digest: "sha256:cc",
                terminal_outcome: "cancelled",
                selected_attempt_id: "attempt-cancelled",
              },
            ],
            next_cursor: null,
          });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-cancelled");
    expect(
      await screen.findByText("Published. 1 sealed task cancelled."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Completed with failures")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cancel run/i }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByText("Cancelled")
        .some((element) => element.className.includes("orange")),
    ).toBe(true);
  });

  it("labels provider and agent failures in words", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/runs/run-failed"))
          return json({
            run_id: "run-failed",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "completed",
            publication_status: "published",
            total_tasks: 2,
            terminal_tasks: 2,
            successful_tasks: 0,
            pending_actions: 0,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 0,
            cleanup_pending: false,
          });
        if (path.includes("/api/v1/runs/run-failed/tasks"))
          return json({
            items: [
              {
                run_id: "run-failed",
                task_id: "policy-task",
                input_digest: "sha256:aa",
                terminal_outcome: "policy",
                selected_attempt_id: "attempt-policy",
              },
              {
                run_id: "run-failed",
                task_id: "agent-task",
                input_digest: "sha256:bb",
                terminal_outcome: "agent",
                selected_attempt_id: "attempt-agent",
              },
            ],
            next_cursor: null,
          });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/runs/run-failed");
    expect(await screen.findByText("Completed with failures")).toBeInTheDocument();
    expect(screen.getByText("Provider rejected the request")).toBeInTheDocument();
    expect(screen.getByText("Agent ended without a score")).toBeInTheDocument();
    expect(screen.queryByText(/^Policy$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Agent$/)).not.toBeInTheDocument();
  });

  it("keeps publication identity and Bucket outputs on the result detail, not the list", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/results"))
          return json({
            items: [
              {
                publication_id: "publication-one",
                run_id: "run-gpt-oss-20b-opencode-off-providers-a1b2c3d4e5f6",
                status: "published",
                catalog_digest: "sha256:catalog",
                published_at: "2026-08-21T00:00:00.000Z",
                benchmark: "control-smoke",
                model: "control-smoke",
                harness: "control-smoke",
                agent: "control-smoke",
                publication_role: "diagnostic",
                task_count: 2,
                scored_task_count: 2,
                primary_metric: { name: "mean_reward", value: 0.5, unit: "score" },
                pass_rate: 0.5,
                inference_cost_microusd: 55_929,
                outputs_prefix: "results/schema=v1/publications/publication-one",
                outputs_url:
                  "https://huggingface.co/buckets/example-org/artifacts/tree/results/schema%3Dv1/publications/publication-one",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/results");
    const table = await screen.findByRole("table");
    expect(table).toHaveClass("table-fixed");
    expect(table.parentElement).not.toHaveClass("overflow-x-auto");
    expect(
      await screen.findByRole("columnheader", { name: /run/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /control-smoke/i })).toHaveAttribute(
      "href",
      "/results/publication-one",
    );
    expect(
      screen.queryByRole("columnheader", { name: /publication/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /bucket outputs/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /scored tasks/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /open hugging face bucket outputs/i }),
    ).not.toBeInTheDocument();
  });

  it("shows pass rate, token cost, and a Bucket outputs link on a published result", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/results/publication-one"))
          return json({
            publication_id: "publication-one",
            run_id: "run-one",
            status: "published",
            catalog_digest: "sha256:catalog",
            published_at: "2026-08-21T00:00:00.000Z",
            benchmark: "control-smoke",
            model: "control-smoke",
            harness: "control-smoke",
            inference_provider: "hf-cpu-smoke",
            run_outcome: "mixed",
            quality: "degraded",
            publication_role: "diagnostic",
            task_count: 2,
            scored_task_count: 2,
            strict_pass_count: 1,
            primary_metric: { name: "mean_reward", value: 0.5, unit: "score" },
            result_path: "results/schema=v1/publications/publication-one/receipt.json",
            benchmark_revision: null,
            model_revision: null,
            harness_revision: null,
            agent: "control-smoke",
            source_revision: "revision-test",
            catalog_source_digest: "sha256:source",
            profile_ids: {},
            pass_count: 1,
            pass_rate: 0.5,
            pass_rate_ci95: { low: 0.095, high: 0.905 },
            input_tokens: 192_573,
            output_tokens: 28_999,
            inference_cost_microusd: 55_929,
            mean_task_cost_microusd: 27_964.5,
            task_cost_ci95: { low: 14_000, high: 41_000 },
            observed_cost_microusd: 56_526,
            outputs_prefix: "results/schema=v1/publications/publication-one",
            outputs_url:
              "https://huggingface.co/buckets/example-org/artifacts/tree/results/schema%3Dv1/publications/publication-one",
            hf_uri:
              "hf://buckets/example-org/artifacts/results/schema=v1/publications/publication-one",
            tasks: [
              {
                task_id: "task-a",
                outcome: "complete",
                reward: 1,
                cost_microusd: 21_000,
                input_tokens: 1000,
                output_tokens: 40,
              },
              {
                task_id: "task-b",
                outcome: "benchmark_timeout",
                reward: 0,
                cost_microusd: 34_929,
                input_tokens: 191_573,
                output_tokens: 28_959,
              },
            ],
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/results/publication-one");
    expect(await screen.findByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText(/95% CI 9.5%–90.5%/)).toBeInTheDocument();
    expect(screen.getByText(formatMoney(55_929))).toBeInTheDocument();
    const bucketLink = screen.getByRole("link", {
      name: /open hugging face bucket outputs/i,
    });
    expect(bucketLink).toHaveAttribute(
      "href",
      "https://huggingface.co/buckets/example-org/artifacts/tree/results/schema%3Dv1/publications/publication-one",
    );
    expect(screen.getByText("task-a")).toBeInTheDocument();
    expect(screen.getByText("Timed out")).toBeInTheDocument();
  });

  it("shows official snapshot rows and the cost-score plot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/api/v1/leaderboard"))
          return json({
            snapshot: {
              record_id: "leaderboard-snapshot-one",
              created_at: "2026-08-21T00:00:00.000Z",
              sqlite_digest: "sha256:sqlite",
              source_digest: "sha256:source",
              entry_count: 2,
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
              {
                rank: 2,
                pareto: false,
                configuration_digest: "sha256:weak",
                run_id: "run-weak",
                publication_id: "publication-weak",
                published_at: "2026-08-21T00:00:00.000Z",
                benchmark: "terminal-bench-2-1",
                model: "openai/gpt-oss-20b",
                harness: "pi",
                inference_provider: "together",
                reasoning_effort: "off",
                harbor_version: "0.21.0",
                trial_count: 1,
                task_count: 2,
                scored_task_count: 2,
                primary_metric_name: "mean_reward",
                primary_metric_value: 0.2,
                primary_metric_unit: "score",
                observed_microusd: 90_000,
              },
            ],
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "Leaderboard" }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("openai/gpt-oss-20b")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Pareto")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toHaveTextContent("Admin");
    expect(screen.getByRole("link", { name: /^Leaderboard$/ })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: /^Overview$/ })).toHaveAttribute(
      "href",
      "/overview",
    );
    expect(
      screen.getByRole("img", {
        name: /cost versus score, with the pareto frontier/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows the public leaderboard without a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session"))
          return json({ authenticated: false, login_url: "/auth/login" }, 401);
        if (path.includes("/api/v1/leaderboard"))
          return json({ snapshot: null, items: [] });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "Leaderboard" }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toHaveTextContent("Admin");
    for (const [label, path] of [
      ["Overview", "/overview"],
      ["Runs", "/runs"],
      ["Jobs", "/jobs"],
      ["Endpoints", "/endpoints"],
      ["Results", "/results"],
      ["Profiles", "/profiles"],
      ["Audit", "/audit"],
    ])
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        loginHref(path),
      );
    expect(screen.queryByText(/admin views require/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /sign in with hugging face/i }),
    ).not.toBeInTheDocument();
  });
});
