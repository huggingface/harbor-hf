import type {
  CurrentRunLock,
  HarborAgentConfig,
  ModelProfileSpec,
  ResolvedDeploymentProfile,
  ResolvedExecutionContract,
  ResolvedHarnessProfile,
  ResolvedInferenceContract,
  ResolvedModelProfile,
  ResolvedProfile,
  RunLock,
} from "@harbor-hf/contracts";
import { canonicalJson } from "@harbor-hf/contracts";
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
): { harborProvider: "openai"; bridgeModel: string } {
  const separator = model.harbor_model_name.indexOf("/");
  if (separator < 1 || separator === model.harbor_model_name.length - 1)
    throw new ProfileResolutionError("Harbor model route is malformed");
  const harborProvider = model.harbor_model_name.slice(0, separator);
  if (harborProvider !== "openai")
    throw new ProfileResolutionError(
      `unsupported Harbor model provider prefix: ${harborProvider}`,
    );
  const bridgeModel = model.harbor_model_name.slice(separator + 1);
  const providerSeparator = bridgeModel.lastIndexOf(":");
  if (providerSeparator < 1 || providerSeparator === bridgeModel.length - 1)
    throw new ProfileResolutionError("Harbor model route has no provider suffix");
  if (bridgeModel.slice(providerSeparator + 1) !== provider)
    throw new ProfileResolutionError(
      "Harbor model provider suffix does not match the deployment provider",
    );
  return { harborProvider, bridgeModel };
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
  const inferenceRequired =
    deployment.spec.inference_token === "required" ||
    deployment.spec.trial_job_template?.inference_token === "required";
  if (!inferenceRequired) return;
  const api = source.inference_api;
  if (!api) throw new ProfileResolutionError("deployment has no inference API");
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
  const maxTotalConcurrency =
    "inference_max_total_concurrency" in source &&
    typeof source.inference_max_total_concurrency === "number"
      ? source.inference_max_total_concurrency
      : undefined;
  return {
    harbor_provider: route.harborProvider,
    provider,
    upstream: requiredString(source.inference_upstream, "inference upstream"),
    agent_model: model.spec.harbor_model_name,
    bridge_model: route.bridgeModel,
    api: requiredString(source.inference_api, "inference API") as
      | "chat-completions"
      | "responses",
    max_requests: requiredNumber(
      source.inference_max_requests,
      "inference request limit",
    ),
    max_concurrency: requiredNumber(
      source.inference_max_concurrency,
      "inference concurrency limit",
    ),
    ...(maxTotalConcurrency ? { max_total_concurrency: maxTotalConcurrency } : {}),
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
    model_id: inference.bridge_model,
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
  return {
    import_path: template.import_path,
    model_name: inference.agent_model,
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
  const inferenceRequired =
    deployment.spec.inference_token === "required" ||
    deployment.spec.trial_job_template?.inference_token === "required";
  const inference = inferenceRequired
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

export function requireExecutionContract(lock: RunLock): ResolvedExecutionContract {
  if (!isCurrentRunLock(lock))
    throw new ProfileResolutionError(
      "historical run locks are read-only after the profile cutover",
    );
  return lock.execution;
}
