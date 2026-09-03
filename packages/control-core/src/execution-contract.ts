import type {
  CurrentRunLock,
  HarborAgentConfig,
  LegacyResolvedProfile,
  LegacyRunLock,
  ModelProfileSpec,
  ResolvedDeploymentProfile,
  ResolvedExecutionContract,
  ResolvedHarnessProfile,
  ResolvedInferenceContract,
  ResolvedModelProfile,
  ResolvedProfile,
  RunContinuation,
  RunContinuationRepair,
  RunContinuationRepairSuccessor,
  RunLock,
} from "@harbor-hf/contracts";
import { canonicalJson, sha256 } from "@harbor-hf/contracts";
import { ProfileResolutionError } from "./profiles.js";

function resolvedProfile<K extends ResolvedProfile["kind"]>(
  profiles: readonly ResolvedProfile[],
  kind: K,
): Extract<ResolvedProfile, { kind: K }> {
  const profile = profiles.find((candidate) => candidate.kind === kind);
  if (!profile) throw new ProfileResolutionError(`missing resolved ${kind} profile`);
  return profile as Extract<ResolvedProfile, { kind: K }>;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function checkedHarborRoute(
  model: ModelProfileSpec,
  provider: string,
): { harborProvider: "openai"; providerModel: string } {
  const separator = model.harbor_model_name.indexOf("/");
  if (separator < 1 || separator === model.harbor_model_name.length - 1)
    throw new ProfileResolutionError("Harbor model route is malformed");
  const harborProvider = model.harbor_model_name.slice(0, separator);
  if (harborProvider !== "openai")
    throw new ProfileResolutionError(
      `unsupported Harbor model provider prefix: ${harborProvider}`,
    );
  const providerModel = model.harbor_model_name.slice(separator + 1);
  const providerSeparator = providerModel.lastIndexOf(":");
  if (providerSeparator < 1 || providerSeparator === providerModel.length - 1)
    throw new ProfileResolutionError("Harbor model route has no provider suffix");
  if (providerModel.slice(providerSeparator + 1) !== provider)
    throw new ProfileResolutionError(
      "Harbor model provider suffix does not match the deployment provider",
    );
  return { harborProvider, providerModel };
}

function assertCompatibility(
  model: ResolvedModelProfile,
  harness: ResolvedHarnessProfile,
  deployment: ResolvedDeploymentProfile,
): void {
  if (!deployment.spec.models.includes(model.name))
    throw new ProfileResolutionError(
      `deployment does not allow model profile: ${model.name}`,
    );
  if (!deployment.spec.harnesses.includes(harness.name))
    throw new ProfileResolutionError(
      `deployment does not allow harness profile: ${harness.name}`,
    );
  if (deployment.spec.route !== "hf_job")
    throw new ProfileResolutionError("imported deployments cannot be composed");
  const source = deployment.spec.trial_job_template ?? deployment.spec;
  if (!source.inference_upstream) return;
  const api = source.inference_api;
  if (!api) throw new ProfileResolutionError("deployment has no inference API");
  const modelInferenceApis = model.spec.compatibility.inference_apis;
  if (!modelInferenceApis)
    throw new ProfileResolutionError(
      `model provider route has no native inference API declaration: ${model.name}`,
    );
  if (!(modelInferenceApis as readonly string[]).includes(api))
    throw new ProfileResolutionError(
      `model provider route does not support deployment inference API: ${api}`,
    );
  if (!(harness.spec.capabilities.inference_apis as readonly string[]).includes(api))
    throw new ProfileResolutionError(
      `harness does not support deployment inference API: ${api}`,
    );
  if (
    harness.spec.capabilities.requires_reasoning &&
    !model.spec.compatibility.reasoning
  )
    throw new ProfileResolutionError(
      `harness requires reasoning support from model profile: ${model.name}`,
    );
  const formats = harness.spec.capabilities.reasoning_formats;
  if (
    formats?.length &&
    (!model.spec.compatibility.reasoning_format ||
      !formats.includes(model.spec.compatibility.reasoning_format))
  )
    throw new ProfileResolutionError(
      `harness does not support the model reasoning format: ${model.name}`,
    );
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined)
    throw new ProfileResolutionError(`prepared deployment has no ${label}`);
  return value;
}

function requiredString(value: string | undefined, label: string): string {
  if (!value) throw new ProfileResolutionError(`prepared deployment has no ${label}`);
  return value;
}

function resolvedInference(
  model: ResolvedModelProfile,
  deployment: ResolvedDeploymentProfile,
): ResolvedInferenceContract {
  if (deployment.spec.route !== "hf_job")
    throw new ProfileResolutionError("imported deployment has no inference contract");
  const source = deployment.spec.trial_job_template ?? deployment.spec;
  const provider = requiredString(
    deployment.spec.inference_provider,
    "inference provider",
  );
  const route = checkedHarborRoute(model.spec, provider);
  return {
    harbor_provider: route.harborProvider,
    provider,
    upstream: requiredString(source.inference_upstream, "inference upstream"),
    agent_model: model.spec.harbor_model_name,
    provider_model: route.providerModel,
    api: requiredString(source.inference_api, "inference API") as
      | "chat-completions"
      | "responses",
    timeout_seconds: requiredNumber(
      source.inference_timeout_seconds,
      "inference timeout",
    ),
    max_output_tokens: requiredNumber(
      source.inference_max_output_tokens,
      "inference output limit",
    ),
    context_window: requiredNumber(deployment.spec.context_window, "context window"),
    input_price_microusd_per_million_tokens: requiredNumber(
      deployment.spec.input_price_microusd_per_million_tokens,
      "input token price",
    ),
    output_price_microusd_per_million_tokens: requiredNumber(
      deployment.spec.output_price_microusd_per_million_tokens,
      "output token price",
    ),
    cache_read_price_microusd_per_million_tokens: requiredNumber(
      deployment.spec.cache_read_price_microusd_per_million_tokens,
      "cache-read token price",
    ),
    cache_write_price_microusd_per_million_tokens: requiredNumber(
      deployment.spec.cache_write_price_microusd_per_million_tokens,
      "cache-write token price",
    ),
  };
}

function piModelRuntime(
  inference: ResolvedInferenceContract,
  reasoning: boolean,
): Record<string, unknown> {
  const inputPrice = inference.input_price_microusd_per_million_tokens / 1_000_000;
  const outputPrice = inference.output_price_microusd_per_million_tokens / 1_000_000;
  const cacheReadPrice =
    inference.cache_read_price_microusd_per_million_tokens / 1_000_000;
  const cacheWritePrice =
    inference.cache_write_price_microusd_per_million_tokens / 1_000_000;
  return {
    provider: inference.harbor_provider,
    base_url: "$OPENAI_BASE_URL",
    api: "openai-completions",
    model_id: inference.provider_model,
    context_window: inference.context_window,
    max_tokens: inference.max_output_tokens,
    input_price: inputPrice,
    output_price: outputPrice,
    cache_read_price: cacheReadPrice,
    cache_write_price: cacheWritePrice,
    reasoning,
    supports_developer_role: false,
    supports_reasoning_effort: inference.api === "chat-completions" && reasoning,
    max_tokens_field: "max_tokens",
  };
}

function litellmModelInfo(
  inference: ResolvedInferenceContract,
): Record<string, unknown> {
  const perToken = (microusdPerMillionTokens: number): number =>
    microusdPerMillionTokens / 1_000_000_000_000;
  return {
    litellm_provider: inference.harbor_provider,
    mode: "chat",
    max_input_tokens: inference.context_window,
    max_output_tokens: inference.max_output_tokens,
    input_cost_per_token: perToken(inference.input_price_microusd_per_million_tokens),
    output_cost_per_token: perToken(inference.output_price_microusd_per_million_tokens),
    cache_read_input_token_cost: perToken(
      inference.cache_read_price_microusd_per_million_tokens,
    ),
    cache_creation_input_token_cost: perToken(
      inference.cache_write_price_microusd_per_million_tokens,
    ),
  };
}

function composedAgent(
  model: ResolvedModelProfile,
  harness: ResolvedHarnessProfile,
  inference: ResolvedInferenceContract,
): HarborAgentConfig {
  const template = harness.spec.harbor_agent;
  if (!template)
    throw new ProfileResolutionError("prepared harness has no Harbor agent template");
  const kwargs: Record<string, unknown> = clone(template.kwargs);
  const capabilities = harness.spec.capabilities;
  if (capabilities.provider_runtime) {
    kwargs.provider_runtime = {
      api: inference.api,
      timeout_seconds: inference.timeout_seconds,
      max_attempts: capabilities.provider_max_attempts ?? 1,
    };
  }
  if (capabilities.model_registry === "pi") {
    kwargs.model_runtime = piModelRuntime(
      inference,
      model.spec.compatibility.reasoning &&
        (harness.spec.reasoning_effort ?? "off") !== "off",
    );
  }
  if (capabilities.litellm_model_registry) {
    kwargs.litellm_model_registry = {
      [inference.agent_model]: litellmModelInfo(inference),
    };
  }
  if (capabilities.litellm_model_info) {
    kwargs.model_info = litellmModelInfo(inference);
  }
  if (capabilities.reasoning_format_runtime === "dsh") {
    const format = model.spec.compatibility.reasoning_format;
    if (!format)
      throw new ProfileResolutionError(
        "DSH reasoning-format runtime requires a model reasoning format",
      );
    kwargs.thinking_format = format;
  }
  const upstream = new URL(inference.upstream);
  return {
    import_path: template.import_path,
    model_name: inference.agent_model,
    env: {
      ...clone(template.env ?? {}),
      OPENAI_API_KEY: `\${HF_INFERENCE_TOKEN}`,
      OPENAI_BASE_URL: inference.upstream,
      // Avoid TOKEN in this non-secret key: Harbor redacts such env names.
      HARBOR_HF_OUTPUT_LIMIT: String(inference.max_output_tokens),
      HARBOR_HF_PROVIDER_TIMEOUT_SECONDS: String(inference.timeout_seconds),
    },
    extra_allowed_hosts: [
      ...new Set([...(template.extra_allowed_hosts ?? []), upstream.hostname]),
    ],
    ...(Object.keys(kwargs).length > 0 ? { kwargs } : {}),
    ...(template.override_setup_timeout_sec
      ? { override_setup_timeout_sec: template.override_setup_timeout_sec }
      : {}),
  };
}

export function composeExecutionContract(
  profiles: readonly ResolvedProfile[],
): ResolvedExecutionContract {
  const model = resolvedProfile(profiles, "model");
  const harness = resolvedProfile(profiles, "harness");
  const deployment = resolvedProfile(profiles, "deployment");
  assertCompatibility(model, harness, deployment);
  if (deployment.spec.route !== "hf_job")
    throw new ProfileResolutionError("imported deployments cannot be composed");
  const base: ResolvedExecutionContract = {
    contract_version: "v1",
    source_profiles: {
      model: { name: model.name, profile_id: model.profile_id },
      harness: { name: harness.name, profile_id: harness.profile_id },
      deployment: { name: deployment.name, profile_id: deployment.profile_id },
    },
    model: clone(model.spec),
    harness: clone(harness.spec),
    deployment: clone(deployment.spec),
  };
  const source = deployment.spec.trial_job_template ?? deployment.spec;
  const inference = source.inference_upstream
    ? resolvedInference(model, deployment)
    : undefined;
  if (deployment.spec.preparation !== "required")
    return inference ? { ...base, inference } : base;
  if (!inference)
    throw new ProfileResolutionError(
      "prepared deployment has no locked inference contract",
    );
  return {
    ...base,
    harbor_agent: composedAgent(model, harness, inference),
    inference,
  };
}

export function isCurrentRunLock(lock: RunLock): lock is CurrentRunLock {
  return (
    "execution" in lock && (lock as CurrentRunLock).execution.contract_version === "v1"
  );
}

function legacyProfile<K extends "model" | "harness" | "deployment">(
  lock: LegacyRunLock,
  kind: K,
): Extract<LegacyResolvedProfile, { kind: K }> {
  const profile = lock.profiles.find((candidate) => candidate.kind === kind);
  if (!profile)
    throw new ProfileResolutionError(`historical run is missing ${kind} profile`);
  return profile as Extract<LegacyResolvedProfile, { kind: K }>;
}

function requiredLegacyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ProfileResolutionError(`historical run has no ${label}`);
  return value;
}

function assertSameString(previous: unknown, current: unknown, label: string): void {
  if (requiredLegacyString(previous, label) !== current)
    throw new ProfileResolutionError(`continuation changes the locked ${label}`);
}

function assertSameOptionalString(
  previous: unknown,
  current: unknown,
  label: string,
): void {
  if (previous !== undefined) assertSameString(previous, current, label);
}

function assertContinuationCompatibility(
  lock: LegacyRunLock,
  execution: ResolvedExecutionContract,
): void {
  const model = legacyProfile(lock, "model");
  const harness = legacyProfile(lock, "harness");
  const deployment = legacyProfile(lock, "deployment");
  assertSameString(
    execution.source_profiles.model.name,
    model.name,
    "model profile name",
  );
  assertSameString(
    execution.source_profiles.harness.name,
    harness.name,
    "harness profile name",
  );
  assertSameString(
    execution.source_profiles.deployment.name,
    deployment.name,
    "deployment profile name",
  );
  assertSameString(model.spec.model_id, execution.model.model_id, "model ID");
  assertSameString(model.spec.revision, execution.model.revision, "model revision");
  assertSameOptionalString(
    model.spec.harbor_model_name,
    execution.model.harbor_model_name,
    "Harbor model route",
  );
  assertSameString(harness.spec.agent, execution.harness.agent, "harness agent");
  assertSameString(
    harness.spec.revision,
    execution.harness.revision,
    "harness revision",
  );
  assertSameOptionalString(
    harness.spec.reasoning_effort,
    execution.harness.reasoning_effort,
    "harness reasoning effort",
  );
  assertSameString(
    deployment.spec.route,
    execution.deployment.route,
    "deployment route",
  );
  for (const field of [
    "inference_provider",
    "inference_token",
    "preparation",
    "hardware",
    "harbor_version",
    "context_window",
    "input_price_microusd_per_million_tokens",
    "output_price_microusd_per_million_tokens",
    "cache_read_price_microusd_per_million_tokens",
    "cache_write_price_microusd_per_million_tokens",
  ] as const) {
    const previous = deployment.spec[field];
    if (previous !== undefined && previous !== execution.deployment[field])
      throw new ProfileResolutionError(
        `continuation changes the locked deployment ${field}`,
      );
  }
  const previousSource =
    "trial_job_template" in deployment.spec && deployment.spec.trial_job_template
      ? deployment.spec.trial_job_template
      : deployment.spec;
  const currentSource = execution.deployment.trial_job_template ?? execution.deployment;
  const previousValues = previousSource as Record<string, unknown>;
  const currentValues = currentSource as unknown as Record<string, unknown>;
  for (const field of [
    "inference_upstream",
    "inference_api",
    "inference_max_requests",
    "inference_max_concurrency",
    "inference_max_total_concurrency",
    "inference_timeout_seconds",
    "inference_max_output_tokens",
  ] as const) {
    const previous = previousValues[field];
    if (previous !== undefined && previous !== currentValues[field])
      throw new ProfileResolutionError(
        `continuation changes the locked deployment ${field}`,
      );
  }
}

export function assertRunContinuationCompatible(
  lock: RunLock,
  execution: ResolvedExecutionContract,
): void {
  if (isCurrentRunLock(lock))
    throw new ProfileResolutionError("current run locks do not need continuation");
  assertContinuationCompatibility(lock, execution);
}

export function assertRunContinuationRepairCandidate(
  continuation: RunContinuation,
  candidate: ResolvedExecutionContract,
): void {
  assertWorkerRepairCandidate(continuation.execution, candidate, "continuation repair");
}

export function assertRunContinuationRepairSuccessorCandidate(
  continuation: RunContinuation,
  repair: RunContinuationRepair,
  candidate: ResolvedExecutionContract,
): void {
  assertWorkerRepairCandidate(
    repairedExecution(continuation.execution, repair),
    candidate,
    "continuation repair successor",
  );
}

function assertWorkerRepairCandidate(
  source: ResolvedExecutionContract,
  candidate: ResolvedExecutionContract,
  label: string,
): void {
  const expected = clone(source);
  const normalized = clone(candidate);
  if (
    normalized.source_profiles.deployment.name !==
    expected.source_profiles.deployment.name
  )
    throw new ProfileResolutionError(`${label} changes the deployment profile name`);
  normalized.source_profiles.deployment.profile_id =
    expected.source_profiles.deployment.profile_id;
  normalized.deployment.job_image = expected.deployment.job_image;
  if (expected.deployment.worker_revision)
    normalized.deployment.worker_revision = expected.deployment.worker_revision;
  else delete normalized.deployment.worker_revision;
  if (canonicalJson(normalized) !== canonicalJson(expected))
    throw new ProfileResolutionError(
      `${label} changes fields other than the worker image and revision`,
    );
  if (
    candidate.deployment.job_image === expected.deployment.job_image &&
    candidate.deployment.worker_revision === expected.deployment.worker_revision
  )
    throw new ProfileResolutionError(`${label} does not change the worker`);
}

function repairedExecution(
  source: ResolvedExecutionContract,
  repair: Pick<RunContinuationRepair, "job_image" | "worker_revision">,
): ResolvedExecutionContract {
  const execution = clone(source);
  execution.deployment.job_image = repair.job_image;
  execution.deployment.worker_revision = repair.worker_revision;
  return execution;
}

export function resolvedRunExecution(
  lock: RunLock,
  continuation: RunContinuation | null,
  repair: RunContinuationRepair | null = null,
  successor: RunContinuationRepairSuccessor | null = null,
): ResolvedExecutionContract {
  if (isCurrentRunLock(lock)) {
    if (continuation || repair || successor)
      throw new ProfileResolutionError(
        "current run lock has an unexpected continuation attachment or repair",
      );
    return lock.execution;
  }
  if (!continuation)
    throw new ProfileResolutionError(
      "historical run has no execution continuation attachment",
    );
  if (
    continuation.run_id !== lock.run_id ||
    continuation.run_lock_digest !== sha256(canonicalJson(lock))
  )
    throw new ProfileResolutionError(
      "run continuation does not match the historical lock",
    );
  assertContinuationCompatibility(lock, continuation.execution);
  if (!repair) {
    if (successor)
      throw new ProfileResolutionError(
        "run continuation repair successor has no prior repair",
      );
    return continuation.execution;
  }
  if (
    repair.run_id !== lock.run_id ||
    repair.run_lock_digest !== continuation.run_lock_digest ||
    repair.run_continuation_id !== continuation.record_id ||
    repair.run_continuation_digest !== sha256(canonicalJson(continuation))
  )
    throw new ProfileResolutionError(
      "run continuation repair does not match the immutable continuation",
    );
  const repaired = repairedExecution(continuation.execution, repair);
  if (!successor) return repaired;
  if (
    successor.run_id !== lock.run_id ||
    successor.run_lock_digest !== continuation.run_lock_digest ||
    successor.run_continuation_id !== continuation.record_id ||
    successor.run_continuation_digest !== sha256(canonicalJson(continuation)) ||
    successor.run_continuation_repair_id !== repair.record_id ||
    successor.run_continuation_repair_digest !== sha256(canonicalJson(repair))
  )
    throw new ProfileResolutionError(
      "run continuation repair successor does not match the immutable repair",
    );
  return repairedExecution(repaired, successor);
}
