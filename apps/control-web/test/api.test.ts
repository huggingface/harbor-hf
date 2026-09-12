// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  getLeaderboard,
  getModelProviders,
  getTrial,
  getTrials,
  getReplacements,
  validateReplacements,
  submitReplacements,
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
  it("looks up providers for a selected Hub model", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "Qwen/Qwen3.8-27B",
            providers: ["deepinfra", "featherless-ai"],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getModelProviders("Qwen/Qwen3.8-27B")).resolves.toEqual({
      model: "Qwen/Qwen3.8-27B",
      providers: ["deepinfra", "featherless-ai"],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/model-providers?model=Qwen%2FQwen3.8-27B",
    );
  });

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
        cost_ceiling_usd: 0.25,
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

it("transports native replacement inputs and exact idempotent replay through normal CSRF API", async () => {
  const runId = "run-0123456789abcdef01234567";
  const input = {
    trial_ids: ["00000000-0000-4000-8000-000000000001"],
    cost_ceiling_usd: 4,
  };
  const body = { ...input, fingerprint: "a".repeat(64) };
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ trials: [], fingerprint: body.fingerprint }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
  document.cookie = "hhf_csrf=synthetic-csrf";
  expect(await getTrials(runId)).toEqual([]);
  await getReplacements(runId);
  await validateReplacements(runId, input);
  await submitReplacements(runId, body, "synthetic-idempotency-key");
  await submitReplacements(runId, body, "synthetic-idempotency-key");
  expect(fetchMock.mock.calls).toHaveLength(5);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    `/api/v1/runs/${runId}/replacements`,
    expect.objectContaining({ credentials: "same-origin" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    `/api/v1/runs/${runId}/replacements/validate`,
    expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
  );
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const first = calls[3]?.[1];
  expect(first?.body).toBe(JSON.stringify(body));
  expect(new Headers(first?.headers).get("X-CSRF-Token")).toBe("synthetic-csrf");
  expect(new Headers(first?.headers).get("Idempotency-Key")).toBe(
    "synthetic-idempotency-key",
  );
  expect(calls[4]).toEqual(calls[3]);
});
