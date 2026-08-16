// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderApp(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("control web", () => {
  it("offers OAuth login when the session is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authenticated: false, login_url: "/auth/login" }, 401)),
    );
    renderApp();
    expect(
      await screen.findByRole("link", { name: /sign in with hugging face/i }),
    ).toHaveAttribute("href", "/auth/login");
  });

  it("requires a separate acknowledgement before campaign cancellation", async () => {
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session"))
          return json({
            authenticated: true,
            actor: { subject: "operator", role: "operator", transport: "development" },
          });
        if (path.endsWith("/api/v1/campaigns/campaign-1"))
          return json({
            campaign_id: "campaign-1",
            status: "active",
            publication_status: null,
            total_tasks: 3,
            terminal_tasks: 1,
            pending_actions: 1,
            observed_microusd: 1000000,
            reserved_microusd: 2000000,
            ceiling_microusd: 3000000,
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
    expect(screen.getByRole("dialog", { name: /cancel campaign/i })).toBeVisible();
    expect(screen.getByText(/2 open logical tasks/i)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: /confirm cancellation/i });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
  });

  it("keeps collection cursors in the URL and loads later pages", async () => {
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session"))
          return json({
            authenticated: true,
            actor: { subject: "operator", role: "operator", transport: "development" },
          });
        if (path.includes("/api/v1/campaigns")) {
          requests.push(path);
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
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("renders operational overview from same-origin APIs", async () => {
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("auth/session"))
          return json({
            authenticated: true,
            actor: { subject: "operator", role: "operator", transport: "development" },
          });
        if (path.includes("/system"))
          return json({
            source_revision: "revision",
            write_mode: "canary",
            projection: { ready: true, object_count: 4 },
            resource_contract: { spaces: 1, buckets: 1, operator_secrets: 1 },
          });
        if (path.includes("/campaigns")) return json({ items: [], next_cursor: null });
        if (path.includes("/endpoints")) return json({ items: [] });
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    renderApp();
    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("All observed endpoints safe")).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });
});
