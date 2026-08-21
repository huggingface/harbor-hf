import type { HttpAdapter } from "./http.js";

const INFERENCE_PERMISSIONS = new Set([
  "inference.endpoints.infer.write",
  "inference.serverless.write",
]);

export interface InferenceTokenScopeInput {
  accessToken: string;
}

export interface InferenceTokenScopeAdapter {
  attest(input: InferenceTokenScopeInput): Promise<void>;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inference credential scope response is invalid");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("inference credential scope response is invalid");
  }
  return value;
}

export class HuggingFaceInferenceTokenScope implements InferenceTokenScopeAdapter {
  constructor(private readonly http: HttpAdapter) {}

  async attest(input: InferenceTokenScopeInput): Promise<void> {
    const response = await this.http.getJson(
      new URL("https://huggingface.co/api/whoami-v2"),
      {
        bearer: input.accessToken,
        timeoutMs: 30_000,
        maxBytes: 256 * 1024,
      },
    );
    if (response.status !== 200) {
      throw new Error("inference credential scope attestation failed");
    }

    const root = recordValue(response.body);
    const auth = recordValue(root.auth);
    const accessToken = recordValue(auth.accessToken);
    if (accessToken.role !== "fineGrained") {
      throw new Error("inference credential must be fine-grained");
    }
    const fineGrained = recordValue(accessToken.fineGrained);
    if (fineGrained.canReadGatedRepos !== false) {
      throw new Error("inference credential must not read gated repositories");
    }
    if (arrayValue(fineGrained.global).length !== 0) {
      throw new Error("inference credential must not have global permissions");
    }

    const observed = new Set<string>();
    for (const rawScope of arrayValue(fineGrained.scoped)) {
      const scope = recordValue(rawScope);
      const entity = recordValue(scope.entity);
      if (entity.type !== "user") {
        throw new Error("inference credential must not access Hub resources");
      }
      for (const permission of arrayValue(scope.permissions)) {
        if (typeof permission !== "string" || !INFERENCE_PERMISSIONS.has(permission)) {
          throw new Error("inference credential has a forbidden permission");
        }
        observed.add(permission);
      }
    }
    if (
      observed.size !== INFERENCE_PERMISSIONS.size ||
      [...INFERENCE_PERMISSIONS].some((permission) => !observed.has(permission))
    ) {
      throw new Error("inference credential is missing an approved permission");
    }
  }
}
