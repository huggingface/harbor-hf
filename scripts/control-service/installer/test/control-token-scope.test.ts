import { describe, expect, it } from "vitest";
import {
  type ControlTokenScopeAttestation,
  HuggingFaceControlTokenScope,
} from "../control-token-scope.js";
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
  permissions: [
    "job.write",
    "inference.endpoints.write",
    "inference.endpoints.infer.write",
  ],
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
): Promise<ControlTokenScopeAttestation> {
  return await scope.attest({
    namespace,
    bucketId: "example/control-artifacts",
    accessToken: "control-token-placeholder",
  });
}

describe("control credential scope attestation", () => {
  it.each([
    { type: "user", name: "example" },
    { type: "org", name: "example-org" },
  ])("accepts Jobs-only access for a $type namespace", async (entity) => {
    const { scope } = adapter(
      scopeResponse([bucketScope, { entity, permissions: ["job.write"] }]),
    );
    await expect(attest(scope, entity.name)).resolves.toEqual({ warnings: [] });
  });

  it("accepts the provider-coupled Endpoint permissions", async () => {
    const { scope, requests } = adapter(scopeResponse([userScope, bucketScope]));

    await expect(attest(scope)).resolves.toEqual({ warnings: [] });
    expect(requests).toEqual([
      {
        path: "/api/whoami-v2",
        bearer: "control-token-placeholder",
      },
    ]);
  });

  it("also accepts Endpoint management without the provider-coupled call grant", async () => {
    const { scope } = adapter(
      scopeResponse([
        bucketScope,
        {
          ...userScope,
          permissions: ["job.write", "inference.endpoints.write"],
        },
      ]),
    );

    await expect(attest(scope)).resolves.toEqual({ warnings: [] });
  });

  it("accepts the required organization namespace permissions", async () => {
    const organizationScope = {
      entity: { type: "org", name: "example-org" },
      permissions: [
        "inference.endpoints.infer.write",
        "inference.endpoints.write",
        "job.write",
      ],
    };
    const { scope } = adapter(
      scopeResponse([bucketScope, organizationScope], {}, { name: "service-owner" }),
    );

    await expect(attest(scope, "example-org")).resolves.toEqual({ warnings: [] });
  });

  it("warns about every additional fine-grained grant without rejecting", async () => {
    const { scope } = adapter(
      scopeResponse(
        [
          {
            ...bucketScope,
            permissions: [...bucketScope.permissions, "repo.discussions.write"],
          },
          {
            ...userScope,
            permissions: [...userScope.permissions, "inference.serverless.write"],
          },
          {
            entity: { type: "space", name: "example/control" },
            permissions: ["repo.content.read"],
          },
        ],
        {
          canReadGatedRepos: true,
          global: ["repo.write"],
        },
      ),
    );

    await expect(attest(scope)).resolves.toEqual({
      warnings: [
        "The control credential can read gated repositories.",
        "The control credential grants access to an unrelated scoped resource.",
        "The control credential has additional permissions on the artifact Bucket: repo.discussions.write.",
        "The control credential has additional permissions on the control namespace: inference.serverless.write.",
        "The control credential has global permissions: repo.write.",
      ],
    });
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
      name: "a missing Job permission",
      body: scopeResponse([
        bucketScope,
        {
          ...userScope,
          permissions: ["inference.endpoints.infer.write", "inference.endpoints.write"],
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
      "Hugging Face did not accept the control credential for scope inspection",
    );
  });
});
