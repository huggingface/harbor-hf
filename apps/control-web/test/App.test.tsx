// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
