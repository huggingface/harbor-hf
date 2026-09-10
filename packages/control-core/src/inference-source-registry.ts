import {
  canonicalJson,
  sha256,
  validateInferenceSourceRegistry,
  validateInferenceRegistrationRequest,
  validateInferenceStatusRequest,
  validateInferenceReviewRequest,
  validateInferenceApprovalRequest,
  validateInferenceReview,
  type InferenceSourceRegistryV1,
  type InferenceBindingManifestV1,
  type InferenceReviewV1,
  type InferenceBindingsV1,
} from "@harbor-hf/contracts";
import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import {
  InferenceBindings,
  inferenceRecipeDigest,
  workbenchCredentialRef,
} from "./inference-bindings.js";
import {
  compileAgentWorkbenchRecipe,
  isReservedWorkbenchEnvironment,
} from "./workbench.js";
import type { ObjectStore } from "./store.js";

export const INFERENCE_SOURCE_REGISTRY_KEY = "control/inference-bindings.json";
const MAX_BYTES = 1024 * 1024;
type Registry = InferenceSourceRegistryV1;
type Entry = Registry["entries"][number];
type Grant = InferenceBindingManifestV1["bindings"][number]["uses"][number];
export class InferenceRegistryError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503 = 503) {
    super(
      status === 409
        ? "Inference registry changed; reload and review again"
        : status === 503
          ? "Inference registry unavailable; refetch before retrying"
          : "Inference binding request denied",
    );
  }
}
export function prohibitedInferenceName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    (isReservedWorkbenchEnvironment(upper) && !upper.startsWith("INFERENCE_SECRET_")) ||
    /^(?:HF_|HUGGING_FACE_|HUGGINGFACE_|HARBOR_|OAUTH_|OPENID_|INFERENCE_API_KEY_|AWS_|AZURE_|GOOGLE_|GCP_|DATABASE_|REDIS_|SSH_|CI_|GITHUB_|LD_|DYLD_|NODE_|PYTHON)/.test(
      upper,
    ) ||
    /(?:^|_)(?:TOKEN|OAUTH|OPENID|CONTROL|AUTH|SESSION|COOKIE|PASSWORD|PRIVATE|SIGNING|CREDENTIALS?|AUTHORITY|ACCESS|ENCRYPTION|SERVICE|CLIENT)(?:_|$)/.test(
      upper,
    )
  );
}
function active(entry: Entry): boolean {
  const last = entry.history.filter((event) => event.kind === "status").at(-1);
  return last?.kind === "status" ? last.enabled : true;
}
function grants(entry: Entry): Grant[] {
  // Disable permanently retires earlier approvals. Re-enable is not re-approval.
  const cutoff =
    entry.history.filter((event) => event.kind === "status" && !event.enabled).at(-1)
      ?.revision ?? 0;
  const unique = new Map<string, Grant>();
  for (const event of entry.history)
    if (event.kind === "approve" && event.revision > cutoff)
      unique.set(sha256(canonicalJson(event.grant)), event.grant);
  return [...unique.values()];
}
function policy(value: Registry): InferenceBindings {
  return new InferenceBindings({
    schema_version: "v1",
    bindings: value.entries.map((entry) => ({
      ref: entry.ref,
      source_env: entry.source_env,
      label: entry.label,
      enabled: active(entry),
      uses: grants(entry),
    })),
  });
}
function validate(value: unknown): Registry {
  const registry = validateInferenceSourceRegistry(value);
  const refs = new Set<string>(),
    names = new Set<string>();
  const events: Entry["registration"][] = [];
  for (const entry of registry.entries) {
    if (
      refs.has(entry.ref) ||
      names.has(entry.source_env) ||
      prohibitedInferenceName(entry.source_env) ||
      containsCredentialMaterial(entry.source_env) ||
      containsCredentialMaterial(entry.label)
    )
      throw new Error();
    refs.add(entry.ref);
    names.add(entry.source_env);
    events.push(entry.registration);
    let revision = entry.registration.revision;
    for (const event of entry.history) {
      if (event.revision <= revision || event.actor !== entry.registration.actor)
        throw new Error();
      if (
        event.kind === "approve" &&
        (canonicalJson(event.grant.operator_subjects) !==
          canonicalJson([entry.registration.actor]) ||
          event.grant.destination_env.some(
            (name) =>
              prohibitedInferenceName(name) || isReservedWorkbenchEnvironment(name),
          ))
      )
        throw new Error();
      if (event.kind === "approve") {
        new InferenceBindings({
          schema_version: "v1",
          bindings: registry.entries.map((identity) => ({
            ref: identity.ref,
            source_env: identity.source_env,
            label: identity.label,
            enabled: true,
            uses: identity.ref === entry.ref ? [event.grant] : [],
          })),
        });
        if (containsCredentialMaterial(event.grant.allowed_models)) throw new Error();
      }
      revision = event.revision;
      events.push(event);
    }
  }
  events.sort((a, b) => a.revision - b.revision);
  if (
    events.length !== registry.revision ||
    events.some(
      (event, index) =>
        event.revision !== index + 1 || (index > 0 && event.at < events[index - 1]!.at),
    )
  )
    throw new Error();
  const compiled = policy(registry);
  for (const event of events) {
    if (containsCredentialMaterial(event.reason)) throw new Error();
    compiled.assertPublicStrings(event.reason);
  }
  return registry;
}

/** Exclusive single-runtime authority, never a cache of grants.
 * Queue/revision/readback checks are not distributed CAS; overlapping controllers
 * are unsupported. Stop the old write authority before starting its replacement.
 * Adapters provide time and unpredictable identifiers; no filesystem or environment access.
 * A failed write never permits delivery until a subsequent fresh, validated read.
 */
export class InferenceRegistry {
  private lastRead: Registry | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly reviews = new Map<
    string,
    { actor: string; response: InferenceReviewV1 }
  >();
  constructor(
    private readonly store: ObjectStore,
    readonly image: string,
    private readonly present: (name: string) => boolean,
    private readonly now: () => Date,
    private readonly nonce: () => string,
  ) {}

  sequence<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async read(): Promise<Registry> {
    try {
      let bytes: Uint8Array;
      try {
        bytes = await this.store.read(INFERENCE_SOURCE_REGISTRY_KEY, { fresh: true });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          !this.lastRead?.revision
        )
          return { schema_version: "v1", revision: 0, entries: [] };
        throw error;
      }
      if (bytes.byteLength > MAX_BYTES) throw new Error();
      const registry = validate(JSON.parse(new TextDecoder().decode(bytes)));
      if (this.lastRead) {
        if (registry.revision < this.lastRead.revision) throw new Error();
        // Existing identity and audit prefixes can only be appended, never rewritten.
        for (const prior of this.lastRead.entries) {
          const entry = registry.entries.find((entry) => entry.ref === prior.ref);
          if (
            !entry ||
            canonicalJson({
              ...entry,
              history: entry.history.slice(0, prior.history.length),
            }) !== canonicalJson(prior)
          )
            throw new Error();
        }
      }
      this.lastRead = structuredClone(registry);
      return registry;
    } catch {
      throw new InferenceRegistryError();
    }
  }
  async policy(): Promise<InferenceBindings> {
    return policy(await this.read());
  }
  private audit(registry: Registry, actor: string, reason: string) {
    if (containsCredentialMaterial(reason)) throw new InferenceRegistryError(400);
    policy(registry).assertPublicStrings(reason);
    return {
      revision: registry.revision + 1,
      actor,
      at: this.now().toISOString(),
      reason,
    };
  }
  private owned(registry: Registry, ref: string, actor: string): Entry {
    const entry = registry.entries.find((entry) => entry.ref === ref);
    if (!entry || entry.registration.actor !== actor)
      throw new InferenceRegistryError(403);
    return entry;
  }
  private expected(registry: Registry, revision: number) {
    if (registry.revision !== revision) throw new InferenceRegistryError(409);
  }
  private async write(registry: Registry): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(canonicalJson(validate(registry)));
      if (bytes.byteLength > MAX_BYTES) throw new Error();
      await this.store.put(INFERENCE_SOURCE_REGISTRY_KEY, bytes);
      const confirmed = await this.read();
      if (canonicalJson(confirmed) !== canonicalJson(registry)) throw new Error();
    } catch {
      throw new InferenceRegistryError();
    }
  }
  private presence(source: string): "configured" | "missing" {
    try {
      return this.present(source) ? "configured" : "missing";
    } catch {
      throw new InferenceRegistryError();
    }
  }
  private display(registry: Registry, actor: string): InferenceBindingsV1 {
    return {
      schema_version: "v1",
      revision: registry.revision,
      bindings: registry.entries
        .filter((entry) => entry.registration.actor === actor)
        .map((entry) => ({
          ref: entry.ref,
          label: entry.label,
          source_env: entry.source_env,
          enabled: active(entry),
          status: !active(entry) ? "disabled" : this.presence(entry.source_env),
          grants: grants(entry),
        })),
    };
  }
  discovery(actor: string): Promise<InferenceBindingsV1> {
    return this.sequence(async () => this.display(await this.read(), actor));
  }
  register(body: unknown, actor: string): Promise<InferenceBindingsV1> {
    const input = validateInferenceRegistrationRequest(body);
    return this.sequence(async () => {
      const registry = await this.read();
      this.expected(registry, input.expected_revision);
      if (
        prohibitedInferenceName(input.source_env) ||
        containsCredentialMaterial(input.source_env) ||
        containsCredentialMaterial(input.label) ||
        registry.entries.some((entry) => entry.source_env === input.source_env)
      )
        throw new InferenceRegistryError(400);
      const ref = `INFERENCE_API_KEY_${sha256(this.nonce()).slice(0, 40).toUpperCase()}`;
      registry.entries.push({
        ref,
        source_env: input.source_env,
        label: input.label,
        registration: this.audit(registry, actor, input.reason),
        history: [],
      });
      registry.revision++;
      await this.write(registry);
      return this.display(registry, actor);
    });
  }
  status(ref: string, body: unknown, actor: string): Promise<InferenceBindingsV1> {
    const input = validateInferenceStatusRequest(body);
    return this.sequence(async () => {
      const registry = await this.read();
      this.expected(registry, input.expected_revision);
      this.owned(registry, ref, actor).history.push({
        ...this.audit(registry, actor, input.reason),
        kind: "status",
        enabled: input.enabled,
      });
      registry.revision++;
      await this.write(registry);
      return this.display(registry, actor);
    });
  }
  review(ref: string, body: unknown, actor: string): Promise<InferenceReviewV1> {
    const input = validateInferenceReviewRequest(body);
    return this.sequence(async () => {
      const registry = await this.read();
      this.expected(registry, input.expected_revision);
      const entry = this.owned(registry, ref, actor);
      if (containsCredentialMaterial(input.model_name))
        throw new InferenceRegistryError(400);
      const preview = compileAgentWorkbenchRecipe(input.recipe);
      if (!active(entry) || workbenchCredentialRef(preview.recipe) !== ref)
        throw new InferenceRegistryError(400);
      const destinations = preview.recipe.environment
        .filter((row) => row.source === "model_api_key")
        .map((row) => row.name)
        .sort();
      if (
        destinations.some(
          (name) =>
            prohibitedInferenceName(name) || isReservedWorkbenchEnvironment(name),
        ) ||
        preview.recipe.environment.some((row) => row.source === "model_base_url") !==
          (input.base_url !== null)
      )
        throw new InferenceRegistryError(400);
      const grant: Grant = {
        operator_subjects: [actor],
        worker_image: this.image,
        agent_import_path: preview.harbor_agent.import_path,
        recipe_digest: inferenceRecipeDigest(preview.harbor_agent),
        destination_env: destinations,
        route_api: preview.recipe.route_api,
        base_url: input.base_url,
        allowed_hosts: input.allowed_hosts,
        allowed_models: [input.model_name],
      };
      const check = policy(registry);
      check.assertPublicStrings(preview.recipe.name);
      check.assertPublicStrings(
        { ...preview.harbor_agent, model_name: input.model_name },
        destinations,
      );
      new InferenceBindings({
        schema_version: "v1",
        bindings: [
          {
            ref,
            source_env: entry.source_env,
            label: entry.label,
            enabled: true,
            uses: [grant],
          },
        ],
      }).compile(preview.recipe, actor, this.image, input.model_name, () => true);
      const response = validateInferenceReview({
        schema_version: "v1",
        revision: registry.revision,
        review_id: sha256(this.nonce()),
        expires_at: new Date(this.now().getTime() + 15 * 60 * 1000).toISOString(),
        ref,
        source_env: entry.source_env,
        label: entry.label,
        presence: this.presence(entry.source_env),
        recipe: preview.recipe,
        grant,
      });
      for (const [id, review] of this.reviews)
        if (Date.parse(review.response.expires_at) <= this.now().getTime())
          this.reviews.delete(id);
      if (this.reviews.size >= 256) throw new InferenceRegistryError();
      this.reviews.set(response.review_id, {
        actor,
        response: structuredClone(response),
      });
      return response;
    });
  }
  approve(ref: string, body: unknown, actor: string): Promise<InferenceBindingsV1> {
    const input = validateInferenceApprovalRequest(body);
    return this.sequence(async () => {
      const registry = await this.read();
      this.expected(registry, input.expected_revision);
      const entry = this.owned(registry, ref, actor),
        review = this.reviews.get(input.review_id);
      if (
        !active(entry) ||
        !review ||
        review.actor !== actor ||
        review.response.ref !== ref ||
        review.response.revision !== registry.revision ||
        Date.parse(review.response.expires_at) <= this.now().getTime()
      )
        throw new InferenceRegistryError(409);
      entry.history.push({
        ...this.audit(registry, actor, input.reason),
        kind: "approve",
        grant: review.response.grant,
      });
      registry.revision++;
      this.reviews.delete(input.review_id);
      await this.write(registry);
      return this.display(registry, actor);
    });
  }
}
