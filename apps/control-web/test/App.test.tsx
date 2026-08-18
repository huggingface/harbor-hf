// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ApiError, type SessionResponse } from "../src/api";
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
  it("returns OAuth login to the current same-origin route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authenticated: false, login_url: "/auth/login" }, 401)),
    );
    renderApp("/results?model=test");
    expect(
      await screen.findByRole("link", { name: /sign in with hugging face/i }),
    ).toHaveAttribute("href", "/auth/login?return_to=%2Fresults%3Fmodel%3Dtest");
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
    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByText(/role grants permission/i)).toBeInTheDocument();
  });

  it("requires a separate acknowledgement before campaign cancellation", async () => {
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
            pending_actions: 1,
            observed_microusd: 1_000_000,
            reserved_microusd: 2_000_000,
            ceiling_microusd: 3_000_000,
            cleanup_pending: true,
          });
        if (path.includes("/api/v1/campaigns/campaign-1/tasks"))
          return json({ items: [], next_cursor: null });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp("/campaigns/campaign-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /cancel campaign/i }));
    const confirm = screen.getByRole("button", { name: /confirm cancellation/i });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
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
    expect(screen.queryByText("Campaign not found")).not.toBeInTheDocument();
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
});
