// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ApiError, type SessionResponse } from "../src/api";
import { formatMoney } from "../src/lib";
import { keys } from "../src/queries";

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

function system(writeMode: "disabled" | "canary" | "enabled" = "canary") {
  return {
    source_revision: "revision-0123456789abcdef",
    write_mode: writeMode,
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
      approved("terminal-bench-2-1-diagnostic-1", "benchmark", {
        benchmark: "terminal-bench-2-1",
        task_ids: ["task-a", "task-b"],
        trial_indices: [1, 1],
      }),
      approved("gpt-oss-20b", "model", {
        model_id: "openai/gpt-oss-20b",
        revision: "6cee5e81ee83917806bbde320786a8fb61efebee",
      }),
      approved("opencode", "harness", {
        agent: "opencode",
        reasoning_effort: "off",
      }),
      approved("tb21-gpt-oss-20b-opencode-providers", "deployment", {
        models: ["gpt-oss-20b"],
        harnesses: ["opencode"],
        sandbox_template: {
          inference_upstream: "https://router.huggingface.co/v1",
        },
      }),
      approved("tb21-diagnostic-1", "launch_policy", {
        max_infrastructure_attempts: 2,
        reservation_microusd: 5_100_000,
        publication_role: "diagnostic",
      }),
      approved("control-smoke", "benchmark", { task_ids: ["task-001"] }),
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

function stubLaunchPage() {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("auth/session")) return json(session());
      if (path.includes("/system")) return json(system());
      if (path.includes("/campaigns")) return json({ items: [], next_cursor: null });
      if (path.includes("/profiles")) return json(launchProfiles());
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("control web", () => {
  it("returns OAuth login to the current path without iframe query credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authenticated: false, login_url: "/auth/login" }, 401)),
    );
    renderApp(`/results?platform_access=${"x".repeat(600)}#private`);
    expect(
      await screen.findByRole("link", { name: /sign in with hugging face/i }),
    ).toHaveAttribute("href", "/auth/login?return_to=%2Fresults");
  });

  it("shows the username and never renders the OAuth subject", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session("visible-user"));
        if (path.includes("/system")) return json(system());
        if (path.includes("/campaigns")) return json({ items: [], next_cursor: null });
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp();
    expect(await screen.findByText("visible-user")).toBeInTheDocument();
    expect(screen.queryByText("opaque-oauth-subject")).not.toBeInTheDocument();

    const detailsButton = screen.getByRole("button", {
      name: "Account and session details",
    });
    const detailsId = detailsButton.getAttribute("aria-describedby");
    const details = detailsId ? document.getElementById(detailsId) : null;
    expect(details).toHaveAttribute("role", "tooltip");
    expect(details).toHaveClass("invisible", "absolute");
    expect(details).toHaveTextContent("Operator role");
    expect(details).toHaveTextContent("Your role grants permission");
    expect(details).toHaveTextContent("Session expires");
  });

  it("keeps the authenticated shell and stale data after a transient session failure", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/system")) return json(system());
        if (path.includes("/campaigns")) return json({ items: [], next_cursor: null });
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.session, session("cached-user"));
    renderApp("/", client);
    expect(await screen.findByText("cached-user")).toBeInTheDocument();

    act(() => {
      const query = client.getQueryCache().find({ queryKey: keys.session });
      if (!query) throw new Error("session query is missing");
      query.setState({
        ...query.state,
        error: new ApiError(
          429,
          "rate_limit_exceeded",
          "request rate limit exceeded",
          "safe-request-id",
          Date.now() + 60_000,
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
    expect(screen.getByText(/safe-request-id/)).toBeInTheDocument();
  });

  it("labels both axes on the overview spend chart", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system("enabled"));
        if (path.includes("/endpoints")) return json({ items: [], next_cursor: null });
        if (path.includes("/campaigns"))
          return json({
            items: [
              {
                campaign_id: "run-newer",
                status: "completed",
                terminal_tasks: 2,
                successful_tasks: 2,
                total_tasks: 2,
                observed_microusd: 50_000,
                ceiling_microusd: 1_000_000,
                created_at: "2026-08-21T21:00:00.000Z",
              },
              {
                campaign_id: "run-older",
                status: "completed",
                terminal_tasks: 1,
                successful_tasks: 1,
                total_tasks: 1,
                observed_microusd: 10_000,
                ceiling_microusd: 1_000_000,
                created_at: "2026-08-21T20:00:00.000Z",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/");
    expect(
      await screen.findByRole("img", {
        name: /observed run spend in usd, from oldest run to newest/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Observed spend (USD)")).toBeInTheDocument();
    expect(screen.getByText("Runs, oldest to newest")).toBeInTheDocument();
    expect(screen.getByText(formatMoney(50_000))).toBeInTheDocument();
  });

  it("disables mutation controls when deployment writes are disabled", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system("disabled"));
        if (path.includes("/campaigns")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns");
    expect(await screen.findByRole("button", { name: "Start a run" })).toBeDisabled();
    expect(screen.getByText(/role grants permission/i)).toBeInTheDocument();
  });

  it("requires a separate acknowledgement before run cancellation", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/campaigns/campaign-1"))
          return json({
            campaign_id: "campaign-1",
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
        if (path.includes("/api/v1/campaigns/campaign-1/tasks"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/api/v1/jobs"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns/campaign-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /cancel run/i }));
    const confirm = screen.getByRole("button", { name: /confirm cancellation/i });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
  });

  it("lists campaign Jobs with Hub inspect links", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/campaigns/campaign-1"))
          return json({
            campaign_id: "campaign-1",
            created_at: "2026-08-18T00:00:00.000Z",
            status: "completed",
            publication_status: "published",
            total_tasks: 1,
            terminal_tasks: 1,
            successful_tasks: 1,
            pending_actions: 0,
            observed_microusd: 0,
            reserved_microusd: 0,
            ceiling_microusd: 0,
            cleanup_pending: false,
          });
        if (path.includes("/api/v1/campaigns/campaign-1/tasks/control-smoke-task"))
          return json({
            task: {
              campaign_id: "campaign-1",
              task_id: "control-smoke-task",
              input_digest: "sha256:aa",
              terminal_outcome: "complete",
              selected_attempt_id: "attempt-1",
            },
            attempts: [
              {
                attempt_id: "attempt-1",
                action_id: "action-job-1",
                campaign_id: "campaign-1",
                task_id: "control-smoke-task",
                outcome: "complete",
                replacement_eligible: false,
                cost_microusd: 0,
                metrics: { reward: 1 },
                created_at: "2026-08-18T00:00:00.000Z",
              },
            ],
          });
        if (path.includes("/api/v1/campaigns/campaign-1/tasks"))
          return json({ items: [], next_cursor: null });
        if (path.includes("/api/v1/jobs?campaign_id=campaign-1"))
          return json({
            items: [
              {
                action_id: "action-job-1",
                campaign_id: "campaign-1",
                action_kind: "job.observe",
                generation: 1,
                target: "693994e21a39f67af5a41ad0",
                outcome: "completed",
                observed_state: "COMPLETED",
                resource_id: "693994e21a39f67af5a41ad0",
                inspect_url:
                  "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
                created_at: "2026-08-18T00:00:00.000Z",
                cost_microusd: 1_000_000,
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns/campaign-1/tasks/control-smoke-task");
    const link = await screen.findByRole("link", {
      name: /693994e21a39f67af5a41ad0/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://huggingface.co/jobs/test/693994e21a39f67af5a41ad0",
    );
    expect(screen.getByRole("heading", { name: "Jobs" })).toBeInTheDocument();
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
                campaign_id: "campaign-job-1",
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

  it("shows campaign request errors instead of a false not-found state", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/campaigns/campaign-error"))
          return json(
            {
              error: {
                code: "access_denied",
                message: "access denied",
                request_id: "request-campaign",
              },
            },
            403,
          );
        if (path.includes("/tasks")) return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns/campaign-error");
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
        if (path.includes("/campaigns")) {
          const laterPage = path.includes("cursor=cursor-one");
          return json({
            items: [
              {
                campaign_id: laterPage ? "campaign-second" : "campaign-first",
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
    renderApp("/campaigns");
    const user = userEvent.setup();

    expect(await screen.findByText("campaign-first")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("campaign-second")).toBeInTheDocument();
    expect(requests.some((path) => path.includes("cursor=cursor-one"))).toBe(true);
  });

  it("labels finished campaigns with sealed failures separately from complete success", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/campaigns"))
          return json({
            items: [
              {
                campaign_id: "campaign-success",
                status: "completed",
                terminal_tasks: 1,
                successful_tasks: 1,
                total_tasks: 1,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T00:00:00Z",
              },
              {
                campaign_id: "campaign-timeout",
                status: "completed",
                terminal_tasks: 2,
                successful_tasks: 1,
                total_tasks: 2,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T01:00:00Z",
              },
              {
                campaign_id: "campaign-cancelled",
                status: "cancelled",
                terminal_tasks: 2,
                successful_tasks: 1,
                total_tasks: 2,
                observed_microusd: 0,
                ceiling_microusd: 0,
                created_at: "2026-08-16T02:00:00Z",
              },
            ],
            next_cursor: null,
          });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns");
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

  it("requires confirmation before starting a run", async () => {
    stubLaunchPage();
    renderApp("/campaigns");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start a run" }));
    const create = screen.getByRole("button", { name: "Start run" });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(create).toBeEnabled();
  });

  it("shows the full run name instead of a truncated campaign id", async () => {
    const runName = "run-gpt-oss-20b-opencode-off-providers-a1b2c3d4e5f6";
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.includes("/campaigns"))
          return json({
            items: [
              {
                campaign_id: runName,
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
    expect(table.parentElement).toHaveClass("overflow-hidden");
    expect(table.parentElement).not.toHaveClass("overflow-x-auto");
    expect(await screen.findByRole("link", { name: runName })).toHaveAttribute(
      "href",
      `/runs/${runName}`,
    );
    expect(screen.queryByText(/run-gpt-oss-20…/)).not.toBeInTheDocument();
  });

  it("keeps campaign completed distinct from a timed-out task", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/campaigns/campaign-mixed/capacity"))
          return json({
            configured: true,
            profile_id: "sha256:capacity",
            namespace_limit: 8,
            namespace_active: 3,
            campaign_limit: 4,
            campaign_active: 2,
            hardware_limit: null,
            hardware_active: 0,
            provider_limit: 4,
            provider_reserved: 2,
            start_tokens: 1,
            start_burst: 2,
            queued: 1,
            cleanup_held: 0,
            limiting_factor: "namespace_sandbox_capacity",
            not_before: null,
          });
        if (path.endsWith("/api/v1/campaigns/campaign-mixed"))
          return json({
            campaign_id: "campaign-mixed",
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
        if (path.includes("/api/v1/campaigns/campaign-mixed/tasks"))
          return json({
            items: [
              {
                campaign_id: "campaign-mixed",
                task_id: "timeout-task",
                input_digest: "sha256:aa",
                terminal_outcome: "benchmark_timeout",
                selected_attempt_id: "attempt-timeout",
              },
              {
                campaign_id: "campaign-mixed",
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
    renderApp("/campaigns/campaign-mixed");
    expect(await screen.findByText("Completed with failures")).toBeInTheDocument();
    expect(
      screen.getByText("Published. 1 sealed task did not succeed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Scored success").className).toContain("emerald");
    expect(screen.getByText("Timed out").className).toContain("amber");
    expect(screen.getByText("Sandbox capacity")).toBeInTheDocument();
    expect(await screen.findByText("Namespace Sandbox Capacity")).toBeInTheDocument();
    expect(screen.getByText("3/8 active")).toBeInTheDocument();
  });

  it("shows cancelled outcomes in orange", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session")) return json(session());
        if (path.includes("/system")) return json(system());
        if (path.endsWith("/api/v1/campaigns/campaign-cancelled/capacity"))
          return json({
            configured: false,
            profile_id: null,
            namespace_limit: null,
            namespace_active: 0,
            campaign_limit: 1,
            campaign_active: 0,
            hardware_limit: null,
            hardware_active: 0,
            provider_limit: 0,
            provider_reserved: 0,
            start_tokens: null,
            start_burst: null,
            queued: 0,
            cleanup_held: 0,
            limiting_factor: "campaign_cancelled",
            not_before: null,
          });
        if (path.endsWith("/api/v1/campaigns/campaign-cancelled"))
          return json({
            campaign_id: "campaign-cancelled",
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
        if (path.includes("/api/v1/campaigns/campaign-cancelled/tasks"))
          return json({
            items: [
              {
                campaign_id: "campaign-cancelled",
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
    renderApp("/campaigns/campaign-cancelled");
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
        if (path.endsWith("/api/v1/campaigns/campaign-failed"))
          return json({
            campaign_id: "campaign-failed",
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
        if (path.includes("/api/v1/campaigns/campaign-failed/tasks"))
          return json({
            items: [
              {
                campaign_id: "campaign-failed",
                task_id: "policy-task",
                input_digest: "sha256:aa",
                terminal_outcome: "policy",
                selected_attempt_id: "attempt-policy",
              },
              {
                campaign_id: "campaign-failed",
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
    renderApp("/campaigns/campaign-failed");
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
                campaign_id: "run-gpt-oss-20b-opencode-off-providers-a1b2c3d4e5f6",
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
            campaign_id: "campaign-one",
            status: "published",
            catalog_digest: "sha256:catalog",
            published_at: "2026-08-21T00:00:00.000Z",
            run_id: null,
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
    expect(await screen.findByText("Benchmark Timeout")).toBeInTheDocument();
  });
});
