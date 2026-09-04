import type { HttpAdapter } from "./http.js";

const BUCKET_PERMISSIONS = new Set(["repo.content.read", "repo.write"]);
// Endpoint management is optional: Jobs-only installs must not require it.
const REQUIRED_NAMESPACE_PERMISSIONS = new Set(["job.write"]);
const ALLOWED_NAMESPACE_PERMISSIONS = new Set([
  ...REQUIRED_NAMESPACE_PERMISSIONS,
  "inference.endpoints.write",
  "inference.endpoints.infer.write",
]);

export interface ControlTokenScopeAttestation {
  warnings: string[];
}

export interface ControlTokenScopeInput {
  namespace: string;
  bucketId: string;
  accessToken: string;
}

export interface ControlTokenScopeAdapter {
  attest(input: ControlTokenScopeInput): Promise<ControlTokenScopeAttestation>;
}

export class ControlTokenScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlTokenScopeError";
  }
}

function invalidResponse(): never {
  throw new ControlTokenScopeError(
    "Hugging Face returned an invalid control-token scope response",
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse();
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  return value;
}

function permissions(value: unknown): string[] {
  return arrayValue(value).map((permission) => {
    if (typeof permission !== "string" || !/^[a-z0-9][a-z0-9._:-]*$/.test(permission)) {
      invalidResponse();
    }
    return permission;
  });
}

function organizationNames(root: Record<string, unknown>): Set<string> {
  const raw = root.orgs ?? root.organizations ?? [];
  return new Set(
    arrayValue(raw).map((item) => {
      if (typeof item === "string") return item;
      const organization = recordValue(item);
      if (typeof organization.name !== "string" || !organization.name) {
        invalidResponse();
      }
      return organization.name;
    }),
  );
}

function warningList(values: ReadonlySet<string>): string {
  return [...values].sort().join(", ");
}

export class HuggingFaceControlTokenScope implements ControlTokenScopeAdapter {
  constructor(private readonly http: HttpAdapter) {}

  async attest(input: ControlTokenScopeInput): Promise<ControlTokenScopeAttestation> {
    const response = await this.http.getJson(
      new URL("https://huggingface.co/api/whoami-v2"),
      {
        bearer: input.accessToken,
        timeoutMs: 30_000,
        maxBytes: 256 * 1024,
      },
    );
    if (response.status !== 200) {
      throw new ControlTokenScopeError(
        "Hugging Face did not accept the control credential for scope inspection",
      );
    }

    const root = recordValue(response.body);
    const owner = root.name ?? root.username;
    if (typeof owner !== "string" || !owner) {
      invalidResponse();
    }
    const namespaceType =
      owner === input.namespace
        ? "user"
        : organizationNames(root).has(input.namespace)
          ? "org"
          : null;
    if (!namespaceType) {
      throw new ControlTokenScopeError(
        "the control credential owner cannot manage the selected namespace",
      );
    }

    const auth = recordValue(root.auth);
    const accessToken = recordValue(auth.accessToken);
    if (accessToken.role !== "fineGrained") {
      throw new ControlTokenScopeError("the control credential is not fine-grained");
    }
    const fineGrained = recordValue(accessToken.fineGrained);
    if (typeof fineGrained.canReadGatedRepos !== "boolean") {
      invalidResponse();
    }
    const warnings = new Set<string>();
    if (fineGrained.canReadGatedRepos) {
      warnings.add("The control credential can read gated repositories.");
    }
    const globalPermissions = new Set(permissions(fineGrained.global));
    if (globalPermissions.size > 0) {
      warnings.add(
        `The control credential has global permissions: ${warningList(globalPermissions)}.`,
      );
    }

    const required = new Map<string, ReadonlySet<string>>([
      [`bucket:${input.bucketId}`, BUCKET_PERMISSIONS],
      [`${namespaceType}:${input.namespace}`, REQUIRED_NAMESPACE_PERMISSIONS],
    ]);
    const allowed = new Map<string, ReadonlySet<string>>([
      [`bucket:${input.bucketId}`, BUCKET_PERMISSIONS],
      [`${namespaceType}:${input.namespace}`, ALLOWED_NAMESPACE_PERMISSIONS],
    ]);
    const observed = new Map<string, Set<string>>();
    const additionalBucketPermissions = new Set<string>();
    const additionalNamespacePermissions = new Set<string>();
    let unrelatedScope = false;
    for (const rawScope of arrayValue(fineGrained.scoped)) {
      const scope = recordValue(rawScope);
      const entity = recordValue(scope.entity);
      if (
        typeof entity.type !== "string" ||
        typeof entity.name !== "string" ||
        !entity.type ||
        !entity.name
      ) {
        invalidResponse();
      }
      const key = `${entity.type}:${entity.name}`;
      const allowedPermissions = allowed.get(key);
      const granted = permissions(scope.permissions);
      if (!allowedPermissions) {
        unrelatedScope = true;
        continue;
      }
      const requiredPermissions = observed.get(key) ?? new Set<string>();
      for (const permission of granted) {
        if (allowedPermissions.has(permission)) {
          requiredPermissions.add(permission);
        } else if (entity.type === "bucket") {
          additionalBucketPermissions.add(permission);
        } else {
          additionalNamespacePermissions.add(permission);
        }
      }
      observed.set(key, requiredPermissions);
    }
    const missing = [...required].flatMap(([key, requiredPermissions]) => {
      const granted = observed.get(key) ?? new Set<string>();
      return [...requiredPermissions].filter((permission) => !granted.has(permission));
    });
    if (missing.length > 0) {
      throw new ControlTokenScopeError(
        `the control credential is missing required permissions: ${missing.sort().join(", ")}`,
      );
    }
    if (unrelatedScope) {
      warnings.add(
        "The control credential grants access to an unrelated scoped resource.",
      );
    }
    if (additionalBucketPermissions.size > 0) {
      warnings.add(
        `The control credential has additional permissions on the artifact Bucket: ${warningList(additionalBucketPermissions)}.`,
      );
    }
    if (additionalNamespacePermissions.size > 0) {
      warnings.add(
        `The control credential has additional permissions on the control namespace: ${warningList(additionalNamespacePermissions)}.`,
      );
    }
    return { warnings: [...warnings].sort() };
  }
}
