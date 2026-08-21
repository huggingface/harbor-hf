import { describe, expect, it } from "vitest";
import type { HttpAdapter } from "../http.js";
import { HuggingFaceInferenceTokenScope } from "../inference-token-scope.js";

const inferenceScope = {
  entity: { type: "user", name: "example" },
  permissions: ["inference.endpoints.infer.write", "inference.serverless.write"],
};

function response(scoped: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
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
  };
}

function adapter(body: unknown, status = 200) {
  const requests: Array<{ path: string; bearer?: string }> = [];
  const http: HttpAdapter = {
    async getJson(url, options) {
      requests.push({
        path: url.pathname,
        ...(options.bearer ? { bearer: options.bearer } : {}),
      });
      return { status, body };
    },
  };
  return {
    scope: new HuggingFaceInferenceTokenScope(http),
    requests,
  };
}

async function attest(scope: HuggingFaceInferenceTokenScope): Promise<void> {
  await scope.attest({ accessToken: "inference-token-placeholder" });
}

describe("installer inference credential scope attestation", () => {
  it("accepts only the two approved inference permissions", async () => {
    const { scope, requests } = adapter(response([inferenceScope]));

    await expect(attest(scope)).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        path: "/api/whoami-v2",
        bearer: "inference-token-placeholder",
      },
    ]);
  });

  it.each([
    {
      name: "a broad token role",
      body: { auth: { accessToken: { role: "write" } } },
    },
    {
      name: "global permissions",
      body: response([inferenceScope], { global: ["repo.write"] }),
    },
    {
      name: "gated repository access",
      body: response([inferenceScope], { canReadGatedRepos: true }),
    },
    {
      name: "Hub resource access",
      body: response([
        inferenceScope,
        {
          entity: { type: "bucket", name: "example/artifacts" },
          permissions: ["repo.content.read"],
        },
      ]),
    },
    {
      name: "Job access",
      body: response([
        {
          ...inferenceScope,
          permissions: [...inferenceScope.permissions, "job.write"],
        },
      ]),
    },
    {
      name: "a missing Endpoint permission",
      body: response([
        {
          ...inferenceScope,
          permissions: ["inference.serverless.write"],
        },
      ]),
    },
    {
      name: "a missing serverless permission",
      body: response([
        {
          ...inferenceScope,
          permissions: ["inference.endpoints.infer.write"],
        },
      ]),
    },
  ])("rejects $name", async ({ body }) => {
    const { scope } = adapter(body);
    await expect(attest(scope)).rejects.toThrow(/inference credential/);
  });

  it("rejects provider failures without exposing response details", async () => {
    const { scope } = adapter({ private: "provider detail" }, 401);
    await expect(attest(scope)).rejects.toThrow(
      "inference credential scope attestation failed",
    );
  });
});
