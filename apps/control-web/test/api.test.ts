// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

describe("browser API errors", () => {
  it("keeps rate-limit timing and safe request IDs", async () => {
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
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          ),
      ),
    );
    const started = Date.now();
    const error = await request("/api/v1/system").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      requestId: "request-safe-id",
    });
    expect((error as ApiError).retryAt).toBeGreaterThanOrEqual(started + 59_000);
  });

  it("classifies network failures without turning them into authentication failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    const error = await request("/api/v1/auth/session").catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 0, code: "network_error", transient: true });
  });
});
