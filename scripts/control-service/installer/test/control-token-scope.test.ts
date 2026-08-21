import { describe, expect, it } from "vitest";
import { HuggingFaceControlTokenScope } from "../control-token-scope.js";
import type { HttpAdapter } from "../http.js";

function scopeResponse(
  scoped: unknown[],
  overrides: Record<string, unknown> = {},
  identity: Record<string, unknown> = {},
): unknown {
  return {
    name: "example",
    orgs: [{ name: "example-org" }],
    ...identity,
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

const bucketScope = {
  entity: { type: "bucket", name: "example/control-artifacts" },
  permissions: ["repo.write", "repo.content.read"],
};

const userScope = {
  entity: { type: "user", name: "example" },
  permissions: ["job.write", "inference.endpoints.write"],
};

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
  return { scope: new HuggingFaceControlTokenScope(http), requests };
}

async function attest(
  scope: HuggingFaceControlTokenScope,
  namespace = "example",
): Promise<void> {
  await scope.attest({
    namespace,
    bucketId: "example/control-artifacts",
    accessToken: "control-token-placeholder",
  });
}

describe("control credential scope attestation", () => {
  it("accepts only the exact user namespace and Bucket permissions", async () => {
    const { scope, requests } = adapter(scopeResponse([userScope, bucketScope]));

    await expect(attest(scope)).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        path: "/api/whoami-v2",
        bearer: "control-token-placeholder",
      },
    ]);
  });

  it("accepts the exact organization namespace", async () => {
    const organizationScope = {
      entity: { type: "org", name: "example-org" },
      permissions: ["inference.endpoints.write", "job.write"],
    };
    const { scope } = adapter(
      scopeResponse([bucketScope, organizationScope], {}, { name: "service-owner" }),
    );

    await expect(attest(scope, "example-org")).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "a broad token role",
      body: {
        name: "example",
        auth: { accessToken: { role: "write" } },
      },
    },
    {
      name: "global permissions",
      body: scopeResponse([bucketScope, userScope], { global: ["repo.write"] }),
    },
    {
      name: "gated repository access",
      body: scopeResponse([bucketScope, userScope], { canReadGatedRepos: true }),
    },
    {
      name: "an extra Bucket",
      body: scopeResponse([
        bucketScope,
        userScope,
        {
          entity: { type: "bucket", name: "example/other" },
          permissions: ["repo.content.read"],
        },
      ]),
    },
    {
      name: "an inference permission",
      body: scopeResponse([
        bucketScope,
        {
          ...userScope,
          permissions: [...userScope.permissions, "inference.serverless.write"],
        },
      ]),
    },
    {
      name: "a missing Job permission",
      body: scopeResponse([
        bucketScope,
        {
          ...userScope,
          permissions: ["inference.endpoints.write"],
        },
      ]),
    },
    {
      name: "a missing Endpoint permission",
      body: scopeResponse([
        bucketScope,
        {
          ...userScope,
          permissions: ["job.write"],
        },
      ]),
    },
    {
      name: "a read-only Bucket",
      body: scopeResponse([
        {
          ...bucketScope,
          permissions: ["repo.content.read"],
        },
        userScope,
      ]),
    },
    {
      name: "a write-only Bucket",
      body: scopeResponse([
        {
          ...bucketScope,
          permissions: ["repo.write"],
        },
        userScope,
      ]),
    },
    {
      name: "an additional Space grant",
      body: scopeResponse([
        bucketScope,
        userScope,
        {
          entity: { type: "space", name: "example/control" },
          permissions: ["repo.content.read"],
        },
      ]),
    },
    {
      name: "the wrong Bucket",
      body: scopeResponse([
        { ...bucketScope, entity: { type: "bucket", name: "example/other" } },
        userScope,
      ]),
    },
    {
      name: "an unrelated namespace",
      body: scopeResponse(
        [
          bucketScope,
          {
            ...userScope,
            entity: { type: "org", name: "example-org" },
          },
        ],
        {},
        { name: "other", orgs: [] },
      ),
    },
  ])("rejects $name", async ({ body }) => {
    const { scope } = adapter(body);
    await expect(attest(scope)).rejects.toThrow(/control credential/);
  });

  it("rejects provider failures without including the credential", async () => {
    const { scope } = adapter({ private: "provider detail" }, 401);
    await expect(attest(scope)).rejects.toThrow(
      "control credential scope attestation failed",
    );
  });
});
