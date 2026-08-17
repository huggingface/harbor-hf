const allowedInferencePermissions = new Set([
  "inference.endpoints.infer.write",
  "inference.serverless.write",
]);

interface TokenScopeConfig {
  accessToken: string;
  hubUrl?: string;
  fetch?: typeof fetch;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("inference credential scope response is invalid");
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("inference credential scope response is invalid");
  return value;
}

export async function attestInferenceToken(config: TokenScopeConfig): Promise<void> {
  const request = config.fetch ?? fetch;
  const hubUrl = (config.hubUrl ?? "https://huggingface.co").replace(/\/$/, "");
  const response = await request(`${hubUrl}/api/whoami-v2`, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "User-Agent": "harbor-hf-control/1",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("inference credential scope attestation failed");

  const root = objectValue(await response.json());
  const auth = objectValue(root.auth);
  const accessToken = objectValue(auth.accessToken);
  if (accessToken.role !== "fineGrained")
    throw new Error("inference credential must be fine-grained");
  const fineGrained = objectValue(accessToken.fineGrained);
  if (fineGrained.canReadGatedRepos !== false)
    throw new Error("inference credential must not read gated repositories");
  if (arrayValue(fineGrained.global).length !== 0)
    throw new Error("inference credential must not have global permissions");

  const observed = new Set<string>();
  for (const rawScope of arrayValue(fineGrained.scoped)) {
    const scope = objectValue(rawScope);
    const entity = objectValue(scope.entity);
    if (entity.type !== "user")
      throw new Error("inference credential must not access Hub resources");
    for (const rawPermission of arrayValue(scope.permissions)) {
      if (typeof rawPermission !== "string")
        throw new Error("inference credential permission is invalid");
      if (!allowedInferencePermissions.has(rawPermission))
        throw new Error("inference credential has a forbidden permission");
      observed.add(rawPermission);
    }
  }
  if (
    observed.size !== allowedInferencePermissions.size ||
    [...allowedInferencePermissions].some((permission) => !observed.has(permission))
  )
    throw new Error("inference credential is missing an approved permission");
}
