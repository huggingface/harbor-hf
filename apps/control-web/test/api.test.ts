// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  getLeaderboard,
  getTrial,
  getWorkbenchFile,
  submitRun,
  type WorkbenchRecipe,
} from "../src/api";

const recipe: WorkbenchRecipe = {
  schema_version: "v1",
  name: "example-agent",
  setup_command: "printf ready",
  run_command: "run-agent",
  route_api: "chat-completions",
  setup_timeout_seconds: 60,
  environment: [
    { name: "MODEL_BASE_URL", source: "model_base_url" },
    { name: "MODEL_API_KEY", source: "model_api_key" },
  ],
  outputs: { results_path: "/logs/agent/results.json", trajectory_path: null },
};

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
  document.cookie = "hhf_csrf=; Max-Age=0";
  vi.unstubAllGlobals();
});

describe("browser API transport", () => {
  it("keeps safe error details returned by the service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "rate_limit_exceeded",
                message: "request rate limit exceeded",
                request_id: "request-safe-id",
                retry_at: "2026-01-01T00:01:00Z",
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const error = await api("/api/v1/system").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "request-safe-id",
      retryAt: "2026-01-01T00:01:00Z",
    });
  });

  it("classifies network and non-JSON failures safely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(api("/api/v1/session")).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no details", { status: 503 })),
    );
    await expect(api("/api/v1/system")).rejects.toMatchObject({
      status: 503,
      code: "request_failed",
    });
  });

  it("adds CSRF and idempotency headers to a Workbench run", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
    document.cookie = "hhf_csrf=csrf-value";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ created: true, run: { run_id: "run-test" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitRun(
      {
        benchmark: { name: "benchmark", preset: "one-task" },
        model: { id: "publisher/model", provider: "provider", reasoning_effort: "off" },
        cost_ceiling_usd_per_trial: 0.25,
        role: "diagnostic",
        workbench: { recipe, setup_test_id: "setup/one" },
      },
      "stable-key",
    );

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(path).toBe("/api/v1/runs");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("Idempotency-Key")).toBe("stable-key");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
    expect(JSON.parse(String(init.body)).workbench.setup_test_id).toBe("setup/one");
  });

  it("unwraps lists and safely encodes detail paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rows: [{ model: "model-a" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ trial_name: "trial/name" }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: "ok", truncated: false }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getLeaderboard()).toHaveLength(1);
    await getTrial("run/value", "trial/name");
    await getWorkbenchFile("setup/value", "file/value");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/runs/run%2Fvalue/trials/trial%2Fname",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/v1/workbench/setup-tests/setup%2Fvalue/files/file%2Fvalue",
    );
  });
});
