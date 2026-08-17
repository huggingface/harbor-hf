import { describe, expect, it, vi } from "vitest";
import { attestInferenceToken } from "../src/token-scope.js";

const testToken = ["hf", "not-a-real-inference-credential"].join("_");

function response(scoped: unknown[], overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      auth: {
        accessToken: {
          role: "fineGrained",
          fineGrained: {
            canReadGatedRepos: false,
            global: [],
            scoped,
            ...overrides,
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const inferenceScope = {
  entity: { type: "user", name: "redacted" },
  permissions: ["inference.endpoints.infer.write", "inference.serverless.write"],
};

describe("inference credential scope attestation", () => {
  it("accepts only the two approved inference permissions", async () => {
    const fetchMock = vi.fn(async () => response([inferenceScope]));

    await expect(
      attestInferenceToken({ accessToken: testToken, fetch: fetchMock }),
    ).resolves.toBeUndefined();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${testToken}`);
  });

  it.each([
    {
      name: "repository access",
      scoped: [
        inferenceScope,
        {
          entity: { type: "bucket", name: "redacted" },
          permissions: ["repo.content.read"],
        },
      ],
      overrides: {},
    },
    {
      name: "Job access",
      scoped: [
        {
          entity: { type: "user", name: "redacted" },
          permissions: [...inferenceScope.permissions, "job.write"],
        },
      ],
      overrides: {},
    },
    {
      name: "gated repository access",
      scoped: [inferenceScope],
      overrides: { canReadGatedRepos: true },
    },
    {
      name: "a missing Endpoint permission",
      scoped: [
        {
          entity: { type: "user", name: "redacted" },
          permissions: ["inference.serverless.write"],
        },
      ],
      overrides: {},
    },
  ])("rejects $name", async ({ scoped, overrides }) => {
    await expect(
      attestInferenceToken({
        accessToken: testToken,
        fetch: vi.fn(async () => response(scoped, overrides)),
      }),
    ).rejects.toThrow(/inference credential/);
  });

  it("returns a clean error for an invalid credential", async () => {
    await expect(
      attestInferenceToken({
        accessToken: testToken,
        fetch: vi.fn(async () => new Response("private error", { status: 401 })),
      }),
    ).rejects.toThrow("inference credential scope attestation failed");
  });
});
