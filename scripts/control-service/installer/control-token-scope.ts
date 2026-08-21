import type { HttpAdapter } from "./http.js";

const BUCKET_PERMISSIONS = new Set(["repo.content.read", "repo.write"]);
const NAMESPACE_PERMISSIONS = new Set(["inference.endpoints.write", "job.write"]);

export interface ControlTokenScopeInput {
  namespace: string;
  bucketId: string;
  accessToken: string;
}

export interface ControlTokenScopeAdapter {
  attest(input: ControlTokenScopeInput): Promise<void>;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control credential scope response is invalid");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("control credential scope response is invalid");
  }
  return value;
}

function organizationNames(root: Record<string, unknown>): Set<string> {
  const raw = root.orgs ?? root.organizations ?? [];
  return new Set(
    arrayValue(raw).map((item) => {
      if (typeof item === "string") return item;
      const organization = recordValue(item);
      if (typeof organization.name !== "string" || !organization.name) {
        throw new Error("control credential organization is invalid");
      }
      return organization.name;
    }),
  );
}

function exactPermissions(
  observed: Map<string, Set<string>>,
  key: string,
  expected: ReadonlySet<string>,
): boolean {
  const permissions = observed.get(key);
  return (
    permissions !== undefined &&
    permissions.size === expected.size &&
    [...expected].every((permission) => permissions.has(permission))
  );
}

export class HuggingFaceControlTokenScope implements ControlTokenScopeAdapter {
  constructor(private readonly http: HttpAdapter) {}

  async attest(input: ControlTokenScopeInput): Promise<void> {
    const response = await this.http.getJson(
      new URL("https://huggingface.co/api/whoami-v2"),
      {
        bearer: input.accessToken,
        timeoutMs: 30_000,
        maxBytes: 256 * 1024,
      },
    );
    if (response.status !== 200) {
      throw new Error("control credential scope attestation failed");
    }

    const root = recordValue(response.body);
    const owner = root.name ?? root.username;
    if (typeof owner !== "string" || !owner) {
      throw new Error("control credential owner is invalid");
    }
    const namespaceType =
      owner === input.namespace
        ? "user"
        : organizationNames(root).has(input.namespace)
          ? "org"
          : null;
    if (!namespaceType) {
      throw new Error("control credential namespace is invalid");
    }

    const auth = recordValue(root.auth);
    const accessToken = recordValue(auth.accessToken);
    if (accessToken.role !== "fineGrained") {
      throw new Error("control credential must be fine-grained");
    }
    const fineGrained = recordValue(accessToken.fineGrained);
    if (fineGrained.canReadGatedRepos !== false) {
      throw new Error("control credential must not read gated repositories");
    }
    if (arrayValue(fineGrained.global).length !== 0) {
      throw new Error("control credential must not have global permissions");
    }

    const expected = new Map<string, ReadonlySet<string>>([
      [`bucket:${input.bucketId}`, BUCKET_PERMISSIONS],
      [`${namespaceType}:${input.namespace}`, NAMESPACE_PERMISSIONS],
    ]);
    const observed = new Map<string, Set<string>>();
    for (const rawScope of arrayValue(fineGrained.scoped)) {
      const scope = recordValue(rawScope);
      const entity = recordValue(scope.entity);
      if (
        typeof entity.type !== "string" ||
        typeof entity.name !== "string" ||
        !entity.type ||
        !entity.name
      ) {
        throw new Error("control credential scope entity is invalid");
      }
      const key = `${entity.type}:${entity.name}`;
      const allowed = expected.get(key);
      if (!allowed) throw new Error("control credential has a forbidden scope");
      const permissions = observed.get(key) ?? new Set<string>();
      for (const permission of arrayValue(scope.permissions)) {
        if (typeof permission !== "string" || !allowed.has(permission)) {
          throw new Error("control credential has a forbidden permission");
        }
        permissions.add(permission);
      }
      observed.set(key, permissions);
    }
    if (
      observed.size !== expected.size ||
      [...expected].some(
        ([key, permissions]) => !exactPermissions(observed, key, permissions),
      )
    ) {
      throw new Error("control credential is missing an approved permission");
    }
  }
}
